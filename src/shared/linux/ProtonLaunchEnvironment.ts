import { shellQuote } from "./LinuxDependencies.ts";

const require = (globalThis as unknown as { require: NodeRequire }).require;
const fs = require("fs") as typeof import("fs");
const path = require("path") as typeof import("path");

/** Pressure-vessel hides arbitrary session sockets unless explicitly shared. */
export async function withXodusSocketMount(environment: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
    const env = { ...environment };
    const runtime = env.XDG_RUNTIME_DIR;
    if (!runtime || !path.isAbsolute(runtime)) return env;
    const socket = path.join(runtime, "xodus.sock");
    const stat = await fs.promises.stat(socket).catch(() => null);
    // Offline play must still work when Xodus is unavailable.
    if (!stat?.isSocket()) return env;
    // Pressure-vessel's mount list uses unescaped colon separators.
    if (socket.includes(":")) throw new Error("The Xodus socket path cannot contain ':' when launching through Proton.");
    const mounts = (env.PRESSURE_VESSEL_FILESYSTEMS_RW ?? "").split(":").filter(Boolean);
    if (!mounts.includes(socket)) mounts.push(socket);
    env.PRESSURE_VESSEL_FILESYSTEMS_RW = mounts.join(":");
    return env;
}

/** UMU enters pressure-vessel before invoking proton. Restore game variables at that boundary. */
export async function prepareProtonLaunchEnvironment(proton: string, prefix: string, environment: Record<string, string>): Promise<string> {
    const directory = path.join(path.dirname(prefix), "proton-launch");
    await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
    // Keep the selected release's manifests/runtime requirements; only wrap its entry point.
    for (const name of await fs.promises.readdir(proton)) {
        if (name === "proton") continue;
        const target = path.join(proton, name);
        const link = path.join(directory, name);
        try {
            if (await fs.promises.readlink(link) === target) continue;
            await fs.promises.unlink(link);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        await fs.promises.symlink(target, link);
    }
    const assignments = Object.entries({ ...environment, WINEPREFIX: prefix, PROTONPATH: proton }).map(([key, value]) => {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || value.includes("\0")) throw new Error("Invalid game environment variable.");
        return `export ${key}=${shellQuote(value)}`;
    });
    const script = `#!/bin/sh\n${assignments.join("\n")}\nexec ${shellQuote(path.join(proton, "proton"))} "$@"\n`;
    const staging = path.join(directory, "proton.tmp");
    await fs.promises.writeFile(staging, script, { mode: 0o700 });
    await fs.promises.rename(staging, path.join(directory, "proton"));
    return directory;
}
