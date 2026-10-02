import assert from "node:assert/strict";
import type { spawn, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { it } from "node:test";
import { createXodusLogin, createXodusLogout } from "../src/main/linux/XodusLogin.ts";

it("runs the installed CLI once with the original desktop environment", async () => {
    const child = new EventEmitter();
    const calls: { command: string; args: string[]; options: SpawnOptions }[] = [];
    const execute = (command: string, args: string[], options: SpawnOptions): EventEmitter => {
        calls.push({ command, args, options });
        return child;
    };
    const env = { HOME: "/home/test user", XDG_RUNTIME_DIR: "/run/user/1000", WAYLAND_DISPLAY: "wayland-1", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus", DISPLAY: ":0" };
    const login = createXodusLogin({ platform: "linux", home: "/home/test user", env,
        access: async () => {}, spawn: execute as unknown as typeof spawn });
    const first = login();
    assert.equal(login(), first);
    await new Promise(setImmediate);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, "/home/test user/.amethyst/launcher/tools/xodus/bin/xodus-cli");
    assert.deepEqual(calls[0].args, ["login"]);
    assert.equal(calls[0].options.env?.HOME, env.HOME);
    assert.equal(calls[0].options.env?.XDG_RUNTIME_DIR, env.XDG_RUNTIME_DIR);
    assert.equal(calls[0].options.env?.WAYLAND_DISPLAY, "wayland-1");
    assert.equal(calls[0].options.env?.DBUS_SESSION_BUS_ADDRESS, env.DBUS_SESSION_BUS_ADDRESS);
    assert.equal(calls[0].options.env?.DISPLAY, ":0");
    assert.equal(calls[0].options.env?.XAUTHORITY, undefined);
    assert.equal(calls[0].options.shell, false);
    assert.equal(calls[0].options.stdio, "ignore", "authentication output never enters the console or renderer");
    assert.equal(calls[0].options.timeout, 15 * 60_000);
    assert.equal(env.HOME, "/home/test user", "parent environment is unchanged");
    child.emit("close", 0, null);
    assert.deepEqual(await first, { ok: true, message: null });
});

it("reports missing setup without spawning a process and rejects other platforms", async () => {
    let probes = 0;
    const deps = { home: "/unused", env: {},
        access: async (): Promise<void> => { probes++; throw Error("private path"); },
        spawn: (() => { throw Error("must not spawn"); }) as unknown as typeof spawn };
    const missing = await createXodusLogin({ ...deps, platform: "linux" })();
    assert.equal(missing.ok, false);
    assert.match(missing.message!, /Verify Xodus/);
    assert.doesNotMatch(missing.message!, /private path/);
    probes = 0;
    assert.equal((await createXodusLogin({ ...deps, platform: "win32" })()).ok, false);
    assert.equal(probes, 0);
});

it("allows retry after cancellation or process errors without returning private error details", async () => {
    let child = new EventEmitter();
    const login = createXodusLogin({ platform: "linux", home: "/unused", env: {}, access: async () => {},
        spawn: (() => child) as unknown as typeof spawn });
    const cancelled = login();
    await new Promise(setImmediate);
    child.emit("close", null, "SIGTERM");
    assert.equal((await cancelled).ok, false);
    child = new EventEmitter();
    const retry = login();
    await new Promise(setImmediate);
    child.emit("error", Error("PRIVATE_AUTH_RESPONSE"));
    const failed = await retry;
    assert.equal(failed.ok, false);
    assert.doesNotMatch(JSON.stringify(failed), /PRIVATE_AUTH_RESPONSE/);
});

it("keeps desktop display/auth paths without injecting a bus or runtime", async () => {
    const child = new EventEmitter();
    let options: SpawnOptions | undefined;
    const login = createXodusLogin({ platform: "linux", home: "/unused", access: async () => {},
        env: { XDG_RUNTIME_DIR: "/run/user/123", WAYLAND_DISPLAY: "/tmp/desktop/wayland", XAUTHORITY: "/tmp/desktop/auth" },
        spawn: ((_command: string, _args: string[], value: SpawnOptions) => { options = value; return child; }) as unknown as typeof spawn });
    const pending = login();
    await new Promise(setImmediate);
    assert.equal(options?.env?.WAYLAND_DISPLAY, "/tmp/desktop/wayland");
    assert.equal(options?.env?.XAUTHORITY, "/tmp/desktop/auth");
    assert.equal(options?.env?.DBUS_SESSION_BUS_ADDRESS, undefined);
    child.emit("close", 1, null);
    assert.equal((await pending).ok, false);
});


it("uses xodus-cli logout without removing the device licence and keeps credentials out of logs", async () => {
    const child = new EventEmitter();
    const logout = createXodusLogout({ platform: "linux", home: "/test", env: {}, access: async () => {},
        spawn: ((command: string, args: string[], options: SpawnOptions) => {
            assert.equal(command, "/test/.amethyst/launcher/tools/xodus/bin/xodus-cli");
            assert.deepEqual(args, ["logout"]);
            assert.equal(options.env?.HOME, undefined);
            assert.equal(options.env?.XDG_RUNTIME_DIR, undefined);
            assert.equal(options.stdio, "ignore");
            assert.equal(options.timeout, 30_000);
            return child;
        }) as unknown as typeof spawn });
    const pending = logout();
    assert.equal(logout(), pending);
    await new Promise(setImmediate);
    child.emit("close", 0, null);
    assert.deepEqual(await pending, { ok: true, message: null });
});
