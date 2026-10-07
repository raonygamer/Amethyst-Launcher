import { spawn, execFile } from "node:child_process";
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { unlockXodusKeyring } from "./XodusKeyring.ts";

export const XODUS_SERVICE_NAME = "amethyst-xodus.service";

export async function xodusSocketReady(socket: string): Promise<boolean> {
    try {
        if (!(await fs.lstat(socket)).isSocket()) return false;
        const sockets = await fs.readFile("/proc/net/unix", "utf8");
        return sockets.split("\n").some(line => {
            const fields = line.match(/^\S+\s+\S+\s+\S+\s+(\S+)\s+\S+\s+\S+\s+\S+\s+(.+)$/);
            return fields?.[2] === socket && (parseInt(fields[1], 16) & 0x10000) !== 0;
        });
    } catch { return false; }
}

function command(program: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => execFile(program, args, { timeout: 20_000 }, error => error ? reject(error) : resolve()));
}

/** Remove only the service/autostart entries created by Amethyst. */
export async function removeXodusAutostart(home: string, env: NodeJS.ProcessEnv): Promise<void> {
    const config = env.XDG_CONFIG_HOME || path.join(home, ".config");
    const unit = path.join(config, "systemd/user", XODUS_SERVICE_NAME);
    const desktop = path.join(config, "autostart/amethyst-xodus.desktop");
    if (await fs.stat(unit).then(() => true, () => false)) {
        await command("systemctl", ["--user", "disable", "--now", XODUS_SERVICE_NAME]);
        await fs.rename(unit, `${unit}.disabled-by-launcher`);
        await command("systemctl", ["--user", "daemon-reload"]);
    }
    if (await fs.stat(desktop).then(() => true, () => false)) {
        const wrapper = path.join(home, ".amethyst/start-xodus-service.sh");
        // Stop the old restart loop; the detached daemon uses a different lock.
        for (const entry of await fs.readdir("/proc")) {
            if (!/^\d+$/.test(entry)) continue;
            try {
                const proc = `/proc/${entry}`;
                if ((await fs.stat(proc)).uid !== process.getuid?.()) continue;
                const args = (await fs.readFile(`${proc}/cmdline`, "utf8")).split("\0").filter(Boolean);
                if (args.length === 2 && args[0] === "/bin/sh" && args[1] === wrapper) process.kill(Number(entry), "SIGTERM");
            } catch { /* Already exited. */ }
        }
        if (env.XDG_RUNTIME_DIR) await command("flock", ["-w", "15", path.join(env.XDG_RUNTIME_DIR, "amethyst-xodus.lock"), "/bin/true"]);
        await fs.rename(desktop, `${desktop}.disabled-by-launcher`);
    }
}

interface DaemonOptions {
    home: string;
    env: NodeJS.ProcessEnv;
    log: (message: string) => void;
    unlock?: () => Promise<void>;
    migrate?: () => Promise<void>;
    ready?: typeof xodusSocketReady;
    spawn?: typeof spawn;
    timeoutMs?: number;
}

/** One pending start per launcher, plus flock for concurrent/restarted launchers. */
export function createXodusDaemon(options: DaemonOptions): { ensureRunning: () => Promise<void>; restart: () => Promise<void> } {
    let pending: Promise<void> | undefined;
    let restarting: Promise<void> | undefined;
    const ready = options.ready ?? xodusSocketReady;
    const start = async (): Promise<void> => {
        await (options.migrate ?? (() => removeXodusAutostart(options.home, options.env)))();
        const executable = path.join(options.home, ".amethyst/launcher/tools/xodus/bin/xodus-service");
        try { await fs.access(executable, constants.X_OK); }
        catch { throw new Error("Xodus is not installed. Verify Xodus in Settings → Tools."); }
        const runtime = options.env.XDG_RUNTIME_DIR;
        if (!runtime || !path.isAbsolute(runtime)) throw new Error("The desktop session has no valid XDG_RUNTIME_DIR for Xodus.");
        const socket = path.join(runtime, "xodus.sock");
        if (await ready(socket)) { options.log("Reusing the running Xodus daemon"); return; }
        options.log("Waiting for the desktop keyring; unlock it if prompted");
        await (options.unlock ?? unlockXodusKeyring)();
        if (await ready(socket)) return;
        const data = path.join(options.home, ".amethyst");
        await fs.mkdir(data, { recursive: true, mode: 0o700 });
        const output = path.join(data, "xodus-service.log");
        const handle = await fs.open(output, "a", 0o600);
        let exited: number | null | undefined;
        let spawnError: Error | undefined;
        try {
            // Removal happens under the daemon lock, so competing launches cannot unlink its socket.
            const daemon = (options.spawn ?? spawn)("flock", ["-n", "-E", "73", path.join(runtime, "amethyst-xodus-daemon.lock"),
                "/bin/sh", "-c", 'umask 077; rm -f -- "$1"; exec "$2"', "amethyst-xodus", socket, executable], {
                detached: true, stdio: ["ignore", handle.fd, handle.fd],
                cwd: options.home, env: { ...options.env, XODUS_LOG: "warn" },
            });
            daemon.once("error", error => { spawnError = error; });
            daemon.once("exit", (code, signal) => {
                exited = code;
                if (code !== 73) options.log(`Xodus exited (${code ?? signal}); details in ${output}`);
            });
            await new Promise<void>((resolve, reject) => { daemon.once("spawn", resolve); daemon.once("error", reject); });
            daemon.unref();
        } finally { await handle.close(); }
        const deadline = Date.now() + (options.timeoutMs ?? 120_000);
        do {
            if (await ready(socket)) { options.log("Xodus is listening in the desktop runtime directory"); return; }
            if (spawnError || (exited !== undefined && exited !== 73)) throw new Error(`Xodus exited before opening its socket. Check ${output}.`);
            await new Promise(resolve => setTimeout(resolve, 200));
        } while (Date.now() < deadline);
        throw new Error(`Xodus has not opened its socket yet. Complete any desktop permission prompt, then try again. Details: ${output}`);
    };
    return { ensureRunning() {
        if (restarting) return restarting;
        if (!pending) pending = start().finally(() => { pending = undefined; });
        return pending;
    }, restart() {
        if (restarting) return restarting;
        const previous = pending;
        restarting = (async () => {
            await previous?.catch(() => {});
            const executable = path.join(options.home, ".amethyst/launcher/tools/xodus/bin/xodus-service");
            const runtime = options.env.XDG_RUNTIME_DIR;
            if (!runtime || !path.isAbsolute(runtime)) throw new Error("The desktop session has no valid XDG_RUNTIME_DIR for Xodus.");
            // Unlock before stopping a working daemon, so cancellation leaves it running.
            await (options.unlock ?? unlockXodusKeyring)();
            await stopXodusDaemon(executable, runtime);
            options.log("Restarting Xodus");
            await start();
        })().finally(() => { restarting = undefined; });
        return restarting;
    } };
}

/** Match our user's installed binary and runtime; never kill by process name alone. */
async function daemonIdentity(pid: number, executable: string, runtime: string): Promise<string | null> {
    try {
        const proc = `/proc/${pid}`;
        if ((await fs.stat(proc)).uid !== process.getuid?.()) return null;
        const args = (await fs.readFile(`${proc}/cmdline`, "utf8")).split("\0").filter(Boolean);
        const binary = (await fs.readlink(`${proc}/exe`)).replace(/ \(deleted\)$/, "");
        if (binary !== executable && args[0] !== executable && !(args.length === 2 && args[1] === executable)) return null;
        const env = (await fs.readFile(`${proc}/environ`, "utf8")).split("\0");
        if (!env.includes(`XDG_RUNTIME_DIR=${runtime}`)) return null;
        const stat = await fs.readFile(`${proc}/stat`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
        return fields[0] === "Z" ? null : fields[19];
    } catch { return null; }
}

async function stopXodusDaemon(executable: string, runtime: string): Promise<void> {
    const stopped: { pid: number; identity: string }[] = [];
    for (const name of await fs.readdir("/proc")) {
        if (!/^\d+$/.test(name)) continue;
        const pid = Number(name);
        const identity = await daemonIdentity(pid, executable, runtime);
        if (!identity || await daemonIdentity(pid, executable, runtime) !== identity) continue;
        try { process.kill(pid, "SIGTERM"); stopped.push({ pid, identity }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
    const deadline = Date.now() + 15_000;
    for (const { pid, identity } of stopped) {
        while (await daemonIdentity(pid, executable, runtime) === identity) {
            if (Date.now() >= deadline) throw new Error("Xodus did not stop. Wait for it to finish, then try Restart Xodus again.");
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }
    await command("flock", ["-w", "15", path.join(runtime, "amethyst-xodus-daemon.lock"), "/bin/true"]);
    if (await xodusSocketReady(path.join(runtime, "xodus.sock"))) throw new Error("Another Xodus installation owns the socket. Stop that instance before restarting this one.");
}
