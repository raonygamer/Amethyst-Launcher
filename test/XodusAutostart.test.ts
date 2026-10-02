import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";

(globalThis as unknown as { require: NodeRequire }).require = createRequire(import.meta.url);
const { findExecutable } = await import("../src/shared/linux/LinuxBuild.ts");
const { run } = await import("../src/shared/diagnostics/ProcessRunner.ts");
const { stopXodusAutostart, xodusAutostartScript, setupXodusService } = await import("../src/shared/linux/XodusService.ts");

async function waitForFile(file: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        if (await fs.stat(file).then(() => true, () => false)) return;
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`Timed out waiting for the test process: ${file}`);
}

it("restarts only the matching autostart wrapper and waits for its child to release the lock", {
    skip: process.platform !== "linux" || !findExecutable("flock"),
    timeout: 20_000,
}, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "amethyst autostart test "));
    const processes: { process: ChildProcess; done: Promise<void>; wrapper: string; runtime: string }[] = [];
    try {
        for (const name of ["selected service", "unrelated service"]) {
            const data = path.join(root, name);
            const home = path.join(data, "home");
            const runtime = path.join(data, "runtime");
            await fs.mkdir(home, { recursive: true });
            await fs.mkdir(runtime, { recursive: true });
            const child = path.join(data, "harmless child.sh");
            // The temporary child delays its exit to prove setup waits beyond the wrapper exiting.
            await fs.writeFile(child, '#!/bin/sh\n'
                + 'trap \'kill "$sleeper" 2>/dev/null; sleep 0.3; printf stopped > "$HOME/stopped"; exit 0\' TERM\n'
                + 'sleep 60 &\nsleeper=$!\nprintf ready > "$HOME/ready"\nwait "$sleeper"\n', { mode: 0o700 });
            const wrapper = path.join(data, "start-xodus-service.sh");
            const originalRuntime = process.env.XDG_RUNTIME_DIR;
            process.env.XDG_RUNTIME_DIR = runtime;
            try { await fs.writeFile(wrapper, xodusAutostartScript(child, data)); }
            finally { if (originalRuntime === undefined) delete process.env.XDG_RUNTIME_DIR; else process.env.XDG_RUNTIME_DIR = originalRuntime; }
            const childProcess = spawn("/bin/sh", [wrapper], { stdio: "ignore", env: { ...globalThis.process.env, HOME: home, XDG_RUNTIME_DIR: runtime } });
            const done = new Promise<void>((resolve, reject) => {
                childProcess.once("error", reject);
                childProcess.once("exit", () => resolve());
            });
            processes.push({ process: childProcess, done, wrapper, runtime });
            await waitForFile(path.join(home, "ready"));
        }

        const [selected, unrelated] = processes;
        await stopXodusAutostart(selected.wrapper, selected.runtime);
        await selected.done;
        assert.equal(await fs.readFile(path.join(root, "selected service/home/stopped"), "utf8"), "stopped");
        assert.equal(unrelated.process.exitCode, null);
        assert.equal(unrelated.process.signalCode, null);
        await assert.rejects(fs.stat(path.join(root, "unrelated service/home/stopped")), { code: "ENOENT" });
    } finally {
        for (const entry of processes) {
            await stopXodusAutostart(entry.wrapper, entry.runtime);
            await entry.done;
        }
        await fs.rm(root, { recursive: true, force: true });
    }
});

it("rerunning desktop setup starts the rebuilt executable before reporting socket readiness", {
    skip: process.platform !== "linux" || !findExecutable("flock"),
    timeout: 20_000,
}, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "xodus restart test "));
    const originalHome = process.env.HOME;
    const originalRuntime = process.env.XDG_RUNTIME_DIR;
    const originalConfig = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = path.join(root, "config");
    const data = path.join(root, "data");
    const executable = path.join(root, "fake service.cjs");
    const wrapper = path.join(data, "start-xodus-service.sh");
    const runtime = path.join(data, "runtime");
    const writeExecutable = (version: number): Promise<void> => fs.writeFile(executable,
        `#!${process.execPath}\n`
        + 'const fs = require("node:fs"), net = require("node:net"), path = require("node:path");\n'
        + 'const home = process.env.HOME;\n'
        + 'const server = net.createServer();\n'
        + `server.listen(path.join(process.env.XDG_RUNTIME_DIR, "xodus.sock"), () => fs.writeFileSync(path.join(home, "started-${version}"), String(process.pid)));\n`
        + `process.on("SIGTERM", () => server.close(() => setTimeout(() => { fs.writeFileSync(path.join(home, "stopped-${version}"), "stopped"); process.exit(0); }, 300)));\n`,
        { mode: 0o700 });
    process.env.HOME = path.join(data, "home");
    process.env.XDG_RUNTIME_DIR = runtime;
    await fs.mkdir(process.env.HOME, { recursive: true });
    await fs.mkdir(runtime, { recursive: true });
    try {
        const execute: typeof run = async (command, args, options) => {
            if (args.includes("show-environment")) {
                return { command, args, loggableArgs: args, code: 1, stdout: "", stderr: "", output: "", durationMs: 0, timedOut: false };
            }
            return run(command, args, options);
        };
        await writeExecutable(1);
        assert.equal((await setupXodusService(executable, data, () => {}, execute)).manager, "autostart");
        const firstPid = await fs.readFile(path.join(data, "home/started-1"), "utf8");
        await writeExecutable(2);
        assert.equal((await setupXodusService(executable, data, () => {}, execute)).manager, "autostart");
        const secondPid = await fs.readFile(path.join(data, "home/started-2"), "utf8");
        assert.notEqual(secondPid, firstPid);
        assert.equal(await fs.readFile(path.join(data, "home/stopped-1"), "utf8"), "stopped");
    } finally {
        if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
        if (originalRuntime === undefined) delete process.env.XDG_RUNTIME_DIR; else process.env.XDG_RUNTIME_DIR = originalRuntime;
        if (originalConfig === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = originalConfig;
        if (await fs.stat(runtime).then(() => true, () => false)) await stopXodusAutostart(wrapper, runtime);
        await fs.rm(root, { recursive: true, force: true });
    }
});
