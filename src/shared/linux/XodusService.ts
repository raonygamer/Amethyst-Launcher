import { checked, findExecutable, type Execute } from "./LinuxBuild.ts";
import { run } from "../diagnostics/ProcessRunner.ts";
import { shellQuote } from "./LinuxDependencies.ts";

const require = (globalThis as unknown as { require: NodeRequire }).require;
const fs = require("fs") as typeof import("fs");
const os = require("os") as typeof import("os");
const path = require("path") as typeof import("path");

export const XODUS_SERVICE_NAME = "amethyst-xodus.service";

/** Inspect session paths without replacing them in any child process. */
export function xodusEnvironment(_amethystData: string): { HOME: string; XDG_RUNTIME_DIR: string } {
    const runtime = process.env.XDG_RUNTIME_DIR;
    if (!runtime || !path.isAbsolute(runtime)) throw new Error("The desktop session has no valid XDG_RUNTIME_DIR for Xodus.");
    return { HOME: process.env.HOME || os.homedir(), XDG_RUNTIME_DIR: runtime };
}

/** systemd parses quoted values and % specifiers; ExecStart additionally expands $ tokens. */
function unitQuote(value: string, command = false): string {
    if (value.includes("\0")) throw new Error("Invalid service path.");
    const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")
        .replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");
    return `"${command ? escaped.replace(/\$/g, "$$$$") : escaped}"`;
}

export function xodusUnit(executable: string, amethystData: string, busAddress?: string): string {
    const env = xodusEnvironment(amethystData);
    const socket = path.join(env.XDG_RUNTIME_DIR, "xodus.sock");
    return "[Unit]\nDescription=Amethyst Xodus service\nAfter=network-online.target\nStartLimitIntervalSec=0\n\n"
        + "[Service]\nType=simple\n"
        + (busAddress ? `Environment=${unitQuote(`DBUS_SESSION_BUS_ADDRESS=${busAddress}`)}\n` : "")
        + 'Environment="XODUS_LOG=warn"\n'
        + `ExecStart=${unitQuote(executable, true)}\n`
        + `ExecStopPost=/usr/bin/rm -f ${unitQuote(socket, true)}\n`
        + "Restart=always\nRestartSec=10\nTimeoutStopSec=15\nUMask=0077\n\n[Install]\nWantedBy=default.target\n";
}

async function socketReady(socket: string): Promise<boolean> {
    // Connecting without an Xodus request makes the daemon log a protocol error.
    // The kernel's listening-socket table proves readiness without sending it an invalid request.
    try {
        if (!(await fs.promises.lstat(socket)).isSocket()) return false;
        const sockets = await fs.promises.readFile("/proc/net/unix", "utf8");
        return sockets.split("\n").some(line => {
            const fields = line.match(/^\S+\s+\S+\s+\S+\s+(\S+)\s+\S+\s+\S+\s+\S+\s+(.+)$/);
            return fields?.[2] === socket && (parseInt(fields[1], 16) & 0x10000) !== 0;
        });
    } catch { return false; }
}

export async function assertXodusReady(amethystData: string): Promise<void> {
    if (!await socketReady(path.join(xodusEnvironment(amethystData).XDG_RUNTIME_DIR, "xodus.sock"))) {
        throw new Error("xodus-service is not running in the desktop session's runtime directory. Start amethyst-xodus.service or verify Xodus in Settings → Tools.");
    }
}

async function waitForSocket(runtime: string): Promise<void> {
    const socket = path.join(runtime, "xodus.sock");
    const deadline = Date.now() + 60_000;
    do {
        if (await socketReady(socket)) return;
        await new Promise(resolve => setTimeout(resolve, 500));
    } while (Date.now() < deadline);
    throw new Error("xodus-service did not open its runtime socket within one minute. Check its log for a keyring or network error.");
}

function desktopQuote(value: string): string {
    return `"${value.replace(/\\/g, "\\\\\\\\").replace(/["`$]/g, character => `\\\\${character}`).replace(/%/g, "%%")}"`;
}

/** Desktop-session fallback on hosts without a working systemd user manager. */
export function xodusAutostartScript(executable: string, amethystData: string): string {
    const env = xodusEnvironment(amethystData);
    const socket = path.join(env.XDG_RUNTIME_DIR, "xodus.sock");
    return "#!/bin/sh\numask 077\n"
        + "export XODUS_LOG=warn\n"
        + `exec 9>${shellQuote(path.join(env.XDG_RUNTIME_DIR, "amethyst-xodus.lock"))}\nflock -n 9 || exit 0\n`
        + 'trap \'[ -z "$child" ] || kill "$child" 2>/dev/null; exit 0\' TERM INT HUP\n'
        + `while :; do\n  rm -f ${shellQuote(socket)}\n  ${shellQuote(executable)} >>${shellQuote(path.join(amethystData, "xodus-service.log"))} 2>&1 &\n`
        + '  child=$!\n  wait "$child"\n  child=\n  sleep 10 &\n  child=$!\n  wait "$child"\n  child=\ndone\n';
}

/** Match only our user's exact wrapper command, including its process start time to detect PID reuse. */
async function autostartIdentity(pid: number, wrapper: string): Promise<string | null> {
    try {
        const folder = `/proc/${pid}`;
        if ((await fs.promises.stat(folder)).uid !== process.getuid?.()) return null;
        const args = (await fs.promises.readFile(path.join(folder, "cmdline"), "utf8")).split("\0").filter(Boolean);
        if (args.length !== 2 || args[0] !== "/bin/sh" || args[1] !== wrapper) return null;
        const stat = await fs.promises.readFile(path.join(folder, "stat"), "utf8");
        return stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)[19] ?? null;
    } catch { return null; } // A process may exit while /proc is being inspected.
}

/** Stop the supervisor from a previous setup before starting the rebuilt executable. */
export async function stopXodusAutostart(wrapper: string, runtime: string, execute: Execute = run): Promise<void> {
    const flock = findExecutable("flock");
    if (!flock) throw new Error("Desktop autostart needs flock (util-linux). Install it, then prepare Linux tools again.");
    for (const entry of await fs.promises.readdir("/proc")) {
        if (!/^\d+$/.test(entry)) continue;
        const pid = Number(entry);
        const identity = await autostartIdentity(pid, wrapper);
        if (!identity || await autostartIdentity(pid, wrapper) !== identity) continue;
        try { process.kill(pid, "SIGTERM"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
    // The child inherits fd 9, so an exited wrapper alone does not release this lock.
    // A stuck child makes setup fail instead of overlapping the previous daemon.
    await checked(flock, ["--wait", "15", path.join(runtime, "amethyst-xodus.lock"), "/bin/true"], { timeoutMs: 17_000 }, execute);
}

export interface XodusServiceResult {
    manager: "systemd" | "autostart";
    configuration: string;
    runtime: string;
    home: string;
}

export async function setupXodusService(executable: string, amethystData: string,
    onStatus: (message: string) => void, execute: Execute = run): Promise<XodusServiceResult> {
    await fs.promises.access(executable, fs.constants.X_OK);
    const env = xodusEnvironment(amethystData);
    await fs.promises.access(env.XDG_RUNTIME_DIR, fs.constants.W_OK);
    await fs.promises.mkdir(amethystData, { recursive: true, mode: 0o700 });
    // HOME and runtime remain managed by the desktop session.
    const configRoot = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
    const systemctl = findExecutable("systemctl");
    const manager = systemctl ? await execute(systemctl, ["--user", "show-environment"], { timeoutMs: 10_000 }) : null;
    if (systemctl && manager?.code === 0 && !manager.timedOut && !manager.spawnError) {
        const serviceFile = path.join(configRoot, "systemd", "user", XODUS_SERVICE_NAME);
        const busAddress = process.env.DBUS_SESSION_BUS_ADDRESS
            || manager.stdout.split("\n").find(line => line.startsWith("DBUS_SESSION_BUS_ADDRESS="))?.slice("DBUS_SESSION_BUS_ADDRESS=".length);
        await fs.promises.mkdir(path.dirname(serviceFile), { recursive: true });
        await fs.promises.writeFile(serviceFile, xodusUnit(executable, amethystData, busAddress), { mode: 0o600 });
        onStatus("Enabling xodus-service for your user...");
        await checked(systemctl, ["--user", "daemon-reload"], {}, execute);
        await checked(systemctl, ["--user", "enable", XODUS_SERVICE_NAME], {}, execute);
        await checked(systemctl, ["--user", "restart", XODUS_SERVICE_NAME], {}, execute);
        onStatus("Waiting for xodus-service...");
        try {
            await waitForSocket(env.XDG_RUNTIME_DIR);
            await checked(systemctl, ["--user", "is-active", XODUS_SERVICE_NAME], {}, execute);
        } catch (error) {
            const journal = findExecutable("journalctl");
            const details = journal ? await execute(journal, ["--user", "-u", XODUS_SERVICE_NAME, "-n", "25", "--no-pager"], { timeoutMs: 10_000 }) : null;
            throw new Error(`${error instanceof Error ? error.message : String(error)}\n\n${details?.output ?? ""}`);
        }
        return { manager: "systemd", configuration: serviceFile, runtime: env.XDG_RUNTIME_DIR, home: env.HOME };
    }
    const wrapper = path.join(amethystData, "start-xodus-service.sh");
    onStatus("Restarting xodus-service desktop autostart...");
    await stopXodusAutostart(wrapper, env.XDG_RUNTIME_DIR, execute);
    await fs.promises.writeFile(wrapper, xodusAutostartScript(executable, amethystData), { mode: 0o700 });
    await fs.promises.chmod(wrapper, 0o700);
    const desktopFile = path.join(configRoot, "autostart", "amethyst-xodus.desktop");
    await fs.promises.mkdir(path.dirname(desktopFile), { recursive: true });
    await fs.promises.writeFile(desktopFile, "[Desktop Entry]\nType=Application\nName=Amethyst Xodus service\n"
        + `Exec=/bin/sh ${desktopQuote(wrapper)}\nTerminal=false\nX-GNOME-Autostart-enabled=true\n`, { mode: 0o600 });
    const child = require("child_process") as typeof import("child_process");
    const daemon = child.spawn("/bin/sh", [wrapper], { detached: true, stdio: "ignore", env: process.env });
    await new Promise<void>((resolve, reject) => { daemon.once("spawn", resolve); daemon.once("error", reject); });
    daemon.unref();
    onStatus("Waiting for xodus-service...");
    await waitForSocket(env.XDG_RUNTIME_DIR);
    return { manager: "autostart", configuration: desktopFile, runtime: env.XDG_RUNTIME_DIR, home: env.HOME };
}
