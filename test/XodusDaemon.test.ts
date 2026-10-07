import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { createXodusDaemon, xodusSocketReady } from "../src/main/linux/XodusDaemon.ts";
import { unlockXodusKeyring } from "../src/main/linux/XodusKeyring.ts";

it("the detached daemon survives its launcher and is reused without another keyring prompt", { skip: process.platform !== "linux", timeout: 15_000 }, async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "xodus-daemon-"));
    const runtime = path.join(home, "runtime");
    const executable = path.join(home, ".amethyst/launcher/tools/xodus/bin/xodus-service");
    const socket = path.join(runtime, "xodus.sock");
    let pid: number | undefined;
    try {
        await fs.mkdir(runtime);
        await fs.mkdir(path.dirname(executable), { recursive: true });
        await fs.writeFile(executable, `#!${process.execPath}\n`
            + 'const fs=require("node:fs"), net=require("node:net"), path=require("node:path");\n'
            + 'fs.appendFileSync(path.join(process.env.HOME,"starts"),process.pid+"\\n");\n'
            + 'const server=net.createServer(); server.listen(path.join(process.env.XDG_RUNTIME_DIR,"xodus.sock"));\n'
            + 'process.on("SIGTERM",()=>server.close(()=>process.exit(0)));\n', { mode: 0o700 });
        const module = new URL("../src/main/linux/XodusDaemon.ts", import.meta.url).href;
        execFileSync(process.execPath, ["--input-type=module", "-e", `
            import { createXodusDaemon } from ${JSON.stringify(module)};
            const options={home:process.env.HOME,env:process.env,log:()=>{},migrate:async()=>{},unlock:async()=>{}};
            await Promise.all([createXodusDaemon(options).ensureRunning(),createXodusDaemon(options).ensureRunning()]);
        `], { env: { ...process.env, HOME: home, XDG_RUNTIME_DIR: runtime }, timeout: 10_000, stdio: "pipe" });
        pid = Number((await fs.readFile(path.join(home, "starts"), "utf8")).trim());
        assert.equal(await xodusSocketReady(socket), true);
        let unlocks = 0;
        const manager = createXodusDaemon({ home, env: { ...process.env, HOME: home, XDG_RUNTIME_DIR: runtime },
            log: () => {}, migrate: async () => {}, unlock: async () => { unlocks++; } });
        const first = manager.ensureRunning();
        assert.equal(manager.ensureRunning(), first);
        await first;
        assert.equal(unlocks, 0);
        assert.equal((await fs.readFile(path.join(home, "starts"), "utf8")).trim(), String(pid));
        const oldPid = pid;
        const restarting = manager.restart();
        assert.equal(manager.restart(), restarting);
        assert.equal(manager.ensureRunning(), restarting);
        await restarting;
        const starts = (await fs.readFile(path.join(home, "starts"), "utf8")).trim().split("\n");
        pid = Number(starts.at(-1));
        assert.equal(starts.length, 2);
        assert.notEqual(pid, oldPid);
        assert.equal(await xodusSocketReady(socket), true);
    } finally {
        if (pid) {
            process.kill(pid, "SIGTERM");
            for (let i = 0; i < 100 && await xodusSocketReady(socket); i++) await new Promise(resolve => setTimeout(resolve, 20));
        }
        await fs.rm(home, { recursive: true, force: true });
    }
});

it("a cancelled unlock prevents daemon startup and can be retried", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "xodus-unlock-"));
    try {
        const executable = path.join(home, ".amethyst/launcher/tools/xodus/bin/xodus-service");
        await fs.mkdir(path.dirname(executable), { recursive: true });
        await fs.writeFile(executable, "", { mode: 0o700 });
        let attempts = 0;
        const manager = createXodusDaemon({ home, env: { XDG_RUNTIME_DIR: home }, log: () => {}, migrate: async () => {}, ready: async () => false,
            unlock: async () => { attempts++; throw Error("cancelled"); },
            spawn: (() => { throw Error("must not start"); }) as never });
        await assert.rejects(manager.ensureRunning(), /cancelled/);
        await assert.rejects(manager.ensureRunning(), /cancelled/);
        assert.equal(attempts, 2);
    } finally { await fs.rm(home, { recursive: true, force: true }); }
});

it("keyring errors distinguish cancellation and missing collections without leaking helper output", async () => {
    for (const [code, expected] of [[3, /No default keyring/], [4, /cancelled/], [5, /keyring is unavailable/], [6, /Python GObject/]] as const) {
        const execute = ((_file, _args, _options, callback) => {
            callback(Object.assign(Error("PRIVATE_BACKEND_DETAIL"), { code }), "PRIVATE", "PRIVATE");
        }) as typeof execFile;
        await assert.rejects(unlockXodusKeyring(execute), expected);
    }
});
