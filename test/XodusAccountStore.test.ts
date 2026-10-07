import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import path from "node:path";
import { it } from "node:test";
import { build } from "esbuild";
import { XODUS_ACCOUNT_LOGOUT, XODUS_ACCOUNT_LOGIN, XODUS_ACCOUNT_REFRESH, XODUS_RESTART, XODUS_ACCOUNT_LIBRARY, type XboxOwnedGames, type XodusAccountSnapshot, type XodusLoginResult } from "../src/shared/linux/XodusAccountTypes.ts";

const root = path.resolve(import.meta.dirname, "..");
const compiled = await build({
    entryPoints: [path.join(root, "src/renderer/src/states/XodusAccountStore.ts")],
    bundle: true, platform: "node", format: "cjs", write: false,
    define: { "import.meta.hot": "undefined" },
    plugins: [{ name: "account-store-alias", setup(builder) {
        builder.onResolve({ filter: /^@renderer\/scripts\/backend\/tools\/LauncherTools$/ }, () => ({ path: "tools", namespace: "fixture" }));
        builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: "export const LauncherTools={Xodus:{ensureVerified:()=>window.verifyXodus()}};" }));
        builder.onResolve({ filter: /^@shared\// }, args => ({ path: path.join(root, "src/shared", args.path.slice("@shared/".length) + ".ts") }));
    } }],
});

const account: XodusAccountSnapshot = {
    service: "connected", session: "signed_in", updatedAt: 1234,
    profile: { gamertag: "ExamplePlayer", email: "example@example.com", avatarUrl: null, xuid: "123" },
    detail: null, emailDetail: null,
};

it("coalesces restart clicks, blocks conflicting actions, and performs a real account refresh afterward", async () => {
    const { useXodusAccountStore: store, calls } = setup();
    const restart = store.getState().restart();
    assert.equal(store.getState().restart(), restart);
    assert.equal(store.getState().restarting, true);
    await store.getState().login();
    await store.getState().refresh();
    await new Promise(setImmediate);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].channel, XODUS_RESTART);
    calls[0].resolve({ ok: true, message: null });
    await new Promise(setImmediate);
    assert.equal(calls[1].channel, XODUS_ACCOUNT_REFRESH);
    assert.equal(calls[1].force, true);
    calls[1].resolve(account);
    await restart;
    assert.equal(store.getState().restarting, false);
    assert.deepEqual(store.getState().snapshot, account);
});

interface PendingAccountRead {
    channel: string;
    force?: boolean;
    resolve(value: XodusAccountSnapshot | XodusLoginResult | XboxOwnedGames): void;
    reject(error: Error): void;
}

function setup(platform = "linux", verifyXodus: () => Promise<void> = async () => {}): typeof import("../src/renderer/src/states/XodusAccountStore.ts") & {
    calls: PendingAccountRead[];
    events: EventEmitter;
    intervals: Map<number, () => void>;
} {
    const events = new EventEmitter();
    const intervals = new Map<number, () => void>();
    const calls: PendingAccountRead[] = [];
    let timerId = 0;
    const testWindow = {
        verifyXodus,
        process: { platform },
        require: (name: string): unknown => {
            assert.equal(name, "electron");
            assert.equal(platform, "linux", "other platforms must never access account IPC");
            return { ipcRenderer: { invoke: (channel: string, force?: boolean) => new Promise<XodusAccountSnapshot | XodusLoginResult | XboxOwnedGames>((resolve, reject) => calls.push({ channel, force, resolve, reject })) } };
        },
        setInterval: (callback: () => void, delay: number) => {
            assert.equal(delay, 60 * 60_000);
            intervals.set(++timerId, callback);
            return timerId;
        },
        clearInterval: (id: number) => { intervals.delete(id); },
        addEventListener: (name: string, callback: () => void) => { events.on(name, callback); },
        removeEventListener: (name: string, callback: () => void) => { events.off(name, callback); },
    };
    const module = { exports: {} };
    new Function("require", "module", "exports", "window", compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports, testWindow);
    const api = module.exports as typeof import("../src/renderer/src/states/XodusAccountStore.ts");
    return { ...api, calls, events, intervals };
}

it("coalesces account reads and replaces the previous account on refresh", async () => {
    const { useXodusAccountStore: store, calls } = setup();
    const first = store.getState().refresh();
    assert.equal(store.getState().loading, true);
    const duplicate = store.getState().refresh();
    assert.equal(first, duplicate);
    await Promise.resolve();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].channel, XODUS_ACCOUNT_REFRESH);
    calls[0].resolve(account);
    await first;
    assert.equal(store.getState().loading, false);
    assert.deepEqual(store.getState().snapshot, account);

    const refresh = store.getState().refresh();
    await Promise.resolve();
    calls[1].resolve({ ...account, profile: null, session: "unavailable" });
    await refresh;
    assert.equal(store.getState().snapshot?.profile, null, "old profile must disappear when the service no longer has a session");
});

it("clears stale account and connection data on failure without exposing the IPC exception", async () => {
    const { useXodusAccountStore: store, calls } = setup();
    store.setState({ snapshot: account });
    const refresh = store.getState().refresh();
    await Promise.resolve();
    calls[0].reject(new Error("PRIVATE_AUTH_RESPONSE"));
    await refresh;
    assert.equal(store.getState().snapshot, null);
    assert.equal(store.getState().loading, false);
    assert.match(store.getState().error!, /Could not refresh/);
    assert.doesNotMatch(JSON.stringify(store.getState()), /PRIVATE_AUTH_RESPONSE/);
});

it("shares polling between mounts and removes timers and listeners when the last mount leaves", async () => {
    const { startXodusAccountPolling: start, useXodusAccountStore: store, calls, intervals, events } = setup();
    const stopOne = start();
    const stopTwo = start();
    await Promise.resolve();
    assert.equal(calls.length, 1);
    assert.equal(intervals.size, 1);
    assert.equal(events.listenerCount("focus"), 1);
    events.emit("focus");
    assert.equal(calls.length, 1, "focus during the initial request must not start a second lookup");
    calls[0].resolve(account);
    await store.getState().refresh();
    stopOne();
    stopOne();
    assert.equal(intervals.size, 1);
    intervals.values().next().value!();
    await Promise.resolve();
    assert.equal(calls.length, 2);
    calls[1].resolve({ ...account, service: "disconnected", session: "unavailable", profile: null });
    await store.getState().refresh();
    assert.equal(store.getState().snapshot?.service, "disconnected");
    stopTwo();
    assert.equal(intervals.size, 0);
    assert.equal(events.listenerCount("focus"), 0);
    assert.equal(events.listenerCount("beforeunload"), 0);
    events.emit("focus");
    assert.equal(calls.length, 2);

    start();
    await Promise.resolve();
    calls[2].resolve(account);
    await store.getState().refresh();
    events.emit("beforeunload");
    assert.equal(intervals.size, 0);
    assert.equal(events.listenerCount("focus"), 0);
});

it("does not start timers, subscribe or invoke account IPC on Windows", async () => {
    const { startXodusAccountPolling: start, useXodusAccountStore: store, calls, intervals, events } = setup("win32");
    const stop = start();
    await store.getState().refresh();
    stop();
    assert.equal(calls.length, 0);
    await store.getState().login();
    assert.equal(calls.length, 0);
    assert.equal(intervals.size, 0);
    assert.equal(events.eventNames().length, 0);
    assert.equal(store.getState().snapshot, null);
});

it("opens only one login, pauses refreshes during it, then reads the new session", async () => {
    const { useXodusAccountStore: store, calls } = setup();
    const login = store.getState().login();
    assert.equal(store.getState().login(), login);
    assert.equal(store.getState().signingIn, true);
    await new Promise(setImmediate);
    assert.equal(calls[0].channel, XODUS_ACCOUNT_LOGIN);
    await store.getState().refresh();
    assert.equal(calls.length, 1);
    calls[0].resolve({ ok: true, message: null });
    await new Promise(setImmediate);
    assert.equal(calls[1].channel, XODUS_ACCOUNT_REFRESH);
    assert.equal(calls[1].force, true);
    calls[1].resolve(account);
    await login;
    assert.equal(store.getState().snapshot?.profile?.gamertag, "ExamplePlayer");
    assert.equal(store.getState().signingIn, false);
});

it("waits for Xodus verification before login and can retry a failed verification", async () => {
    let finish!: () => void;
    let fail = false;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const { useXodusAccountStore: store, calls } = setup("linux", async () => {
        await gate;
        if (fail) throw Error("Verification failed");
    });
    const login = store.getState().login();
    await new Promise(setImmediate);
    assert.equal(calls.length, 0);
    fail = true;
    finish();
    await login;
    assert.equal(calls.length, 0);
    assert.equal(store.getState().signingIn, false);
    assert.match(store.getState().error!, /verification did not complete/);
    fail = false;
    const retry = store.getState().login();
    await new Promise(setImmediate);
    assert.equal(calls[0].channel, XODUS_ACCOUNT_LOGIN);
    calls[0].resolve({ ok: false, message: "User cancelled login" });
    await retry;
});

it("shows login failure and lets the user retry without leaking exceptions", async () => {
    const { useXodusAccountStore: store, calls } = setup();
    const first = store.getState().login();
    await new Promise(setImmediate);
    calls[0].resolve({ ok: false, message: "Prepare Linux tools first." });
    await first;
    assert.equal(store.getState().error, "Prepare Linux tools first.");
    assert.equal(store.getState().signingIn, false);
    const retry = store.getState().login();
    await new Promise(setImmediate);
    calls[1].reject(new Error("PRIVATE_LOGIN_RESPONSE"));
    await retry;
    assert.match(store.getState().error!, /Could not open Xodus login/);
    assert.doesNotMatch(JSON.stringify(store.getState()), /PRIVATE_LOGIN_RESPONSE/);
    assert.equal(store.getState().signingIn, false);
});

it("explains a stale main process and pauses automatic requests until a manual retry succeeds", async () => {
    const { startXodusAccountPolling: start, useXodusAccountStore: store, calls, intervals } = setup();
    const stop = start();
    await Promise.resolve();
    const pending = store.getState().refresh();
    calls[0].reject(new Error(`Error invoking remote method '${XODUS_ACCOUNT_REFRESH}': Error: No handler registered for '${XODUS_ACCOUNT_REFRESH}'`));
    await pending;
    assert.equal(store.getState().snapshot, null);
    assert.match(store.getState().error!, /Restart the launcher/);
    intervals.values().next().value!();
    await Promise.resolve();
    assert.equal(calls.length, 1, "an old main process cannot recover through repeated polling");

    const retry = store.getState().refresh();
    await Promise.resolve();
    calls[1].resolve(account);
    await retry;
    assert.equal(store.getState().error, null);
    intervals.values().next().value!();
    await Promise.resolve();
    assert.equal(calls.length, 3, "successful manual retry resumes automatic checks");
    calls[2].resolve(account);
    await store.getState().refresh();
    stop();
});


it("forwards manual refresh as a forced backend request", async () => {
    const { useXodusAccountStore: store, calls } = setup();
    const pending = store.getState().refresh(true);
    await Promise.resolve();
    assert.equal(calls[0].force, true);
    calls[0].resolve({ service: "connected", session: "unavailable", profile: null, detail: null, emailDetail: null, updatedAt: 0 });
    await pending;
});


it("logs out once, pauses polling, clears the displayed account and forces a real refresh", async () => {
    const { useXodusAccountStore: store, calls } = setup();
    store.setState({ snapshot: account });
    const pending = store.getState().logout();
    assert.equal(store.getState().logout(), pending);
    assert.equal(store.getState().signingOut, true);
    await new Promise(setImmediate);
    assert.equal(calls[0].channel, XODUS_ACCOUNT_LOGOUT);
    await store.getState().refresh();
    assert.equal(calls.length, 1);
    calls[0].resolve({ ok: true, message: null });
    await new Promise(setImmediate);
    assert.equal(store.getState().snapshot, null);
    assert.equal(calls[1].channel, XODUS_ACCOUNT_REFRESH);
    assert.equal(calls[1].force, true);
    calls[1].resolve({ ...account, profile: null, session: "unavailable" });
    await pending;
    assert.equal(store.getState().signingOut, false);
    assert.equal(store.getState().snapshot?.session, "unavailable");
});


it("discards an old library when the account changes and forwards a forced library refresh", async () => {
    const { useXodusAccountStore: store, calls } = setup();
    store.setState({ snapshot: account });
    const oldLibrary = store.getState().loadLibrary();
    await Promise.resolve();
    assert.equal(calls[0].channel, XODUS_ACCOUNT_LIBRARY);
    const refresh = store.getState().refresh();
    await Promise.resolve();
    calls[1].resolve({ ...account, profile: { ...account.profile!, xuid: "456" } });
    await refresh;
    calls[0].resolve({ status: "available", games: [{ id: "old-game", title: "Old account game", productId: null, acquired: null, imageUrl: null }], updatedAt: Date.now(), detail: null });
    await oldLibrary;
    assert.equal(store.getState().library, null);
    const newLibrary = store.getState().loadLibrary(true);
    await Promise.resolve();
    assert.equal(calls[2].force, true);
    calls[2].resolve({ status: "available", games: [], updatedAt: Date.now(), detail: null });
    await newLibrary;
    assert.deepEqual(store.getState().library?.games, []);
});

it("clears owned games after an account lookup fails", async () => {
    const { useXodusAccountStore: store, calls } = setup();
    store.setState({ snapshot: account, library: { status: "available", games: [], updatedAt: Date.now(), detail: null } });
    const refresh = store.getState().refresh();
    await Promise.resolve();
    calls[0].reject(new Error("PRIVATE_AUTH_RESPONSE"));
    await refresh;
    assert.equal(store.getState().library, null);
});
