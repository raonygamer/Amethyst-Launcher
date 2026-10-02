import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { execFileSync } from "node:child_process";
import { it } from "node:test";
(globalThis as unknown as { require: NodeRequire }).require = createRequire(import.meta.url);
const { prepareProtonLaunchEnvironment, withXodusSocketMount } = await import("../src/shared/linux/ProtonLaunchEnvironment.ts");

it("shares the Xodus socket without overriding session paths or losing existing container mounts", async () => {
    const runtime = await fs.mkdtemp(path.join(os.tmpdir(), "xodus-mount-"));
    const socket = path.join(runtime, "xodus.sock");
    const server = net.createServer();
    try {
        const env = { HOME: "/home/player", XDG_RUNTIME_DIR: runtime, PRESSURE_VESSEL_FILESYSTEMS_RW: "/games:/media/library" };
        assert.deepEqual(await withXodusSocketMount(env), env);
        await fs.writeFile(socket, "not a socket");
        assert.deepEqual(await withXodusSocketMount(env), env);
        await fs.unlink(socket);
        await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
        const mounted = await withXodusSocketMount(env);
        assert.deepEqual(mounted, { ...env, PRESSURE_VESSEL_FILESYSTEMS_RW: `/games:/media/library:${socket}` });
        assert.equal(env.PRESSURE_VESSEL_FILESYSTEMS_RW, "/games:/media/library");
        assert.deepEqual(await withXodusSocketMount(mounted), mounted);
        assert.deepEqual(await withXodusSocketMount({ HOME: "/home/player" }), { HOME: "/home/player" });
    } finally {
        if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
        await fs.rm(runtime, { recursive: true, force: true });
    }
});

it("restores HOME, runtime and literal profile variables after the container, preserving arguments and manifests", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "proton-env-"));
    try {
        const proton = path.join(root, "Proton's files");
        const prefix = path.join(root, "profile/prefix");
        await fs.mkdir(proton);
        await fs.writeFile(path.join(proton, "toolmanifest.vdf"), "original runtime requirements");
        await fs.writeFile(path.join(proton, "proton"), '#!/bin/sh\nprintf "%s\\n" "$HOME" "$XDG_RUNTIME_DIR" "$LITERAL" "$WINEPREFIX" "$PROTONPATH" "$@"\n', { mode: 0o700 });
        const env = { HOME: path.join(root, "home"), XDG_RUNTIME_DIR: path.join(root, "runtime"), LITERAL: "space 'quote';$(touch /tmp/should-not-execute)" };
        const wrapper = await prepareProtonLaunchEnvironment(proton, prefix, env);
        assert.equal(await fs.readFile(path.join(wrapper, "toolmanifest.vdf"), "utf8"), "original runtime requirements");
        const output = execFileSync(path.join(wrapper, "proton"), ["waitforexitandrun", "game with spaces.exe"], {
            env: { ...process.env, HOME: "/wrong", XDG_RUNTIME_DIR: "/run/user/123" }, encoding: "utf8",
        }).trimEnd().split("\n");
        assert.deepEqual(output, [env.HOME, env.XDG_RUNTIME_DIR, env.LITERAL, prefix, proton, "waitforexitandrun", "game with spaces.exe"]);
        await prepareProtonLaunchEnvironment(proton, prefix, { ...env, LITERAL: "updated" });
        assert.match(await fs.readFile(path.join(wrapper, "proton"), "utf8"), /LITERAL='updated'/);
        assert.equal((await fs.stat(path.join(wrapper, "proton"))).mode & 0o777, 0o700);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});
