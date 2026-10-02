import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, it } from "node:test";
import { build } from "esbuild";
import { XODUS_ACCOUNT_LOGIN, XODUS_ACCOUNT_LOGOUT, XODUS_ACCOUNT_REFRESH, type XodusAccountSnapshot } from "../src/shared/linux/XodusAccountTypes.ts";

// Exercise the real entrypoint's registration order, without launching Electron or
// accessing the user's service, keyring, account, log files, or app data.
const compiled = await build({
    entryPoints: [path.resolve(import.meta.dirname, "../src/main/index.ts")],
    bundle: true, platform: "node", format: "cjs", write: false,
    loader: { ".png": "dataurl" },
    external: [
        "electron", "electron-updater", "@electron-toolkit/utils",
        "./diagnostics/LogWriter", "./linux/XodusAccount", "./linux/XodusLogin",
        "./net/DownloadService", "./protocol/IconProtocol",
    ],
});

const snapshot: XodusAccountSnapshot = {
    service: "connected", session: "signed_in", detail: null, emailDetail: null, updatedAt: 123,
    profile: { gamertag: "TestPlayer", avatarUrl: null, email: "player@example.test", xuid: "123" },
};

function startMain(platform: NodeJS.Platform, dev = false, failAccount = false): {
    handlers: Map<string, (...args: unknown[]) => Promise<unknown>>;
    loads: { mode: string; accountRegistered: boolean }[];
    logs: unknown[][];
    accountReads: () => number;
    forced: boolean[];
    cleared: () => number;
} {
    const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
    const ipcMain = Object.assign(new EventEmitter(), {
        handle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>): void => {
            assert.equal(handlers.has(channel), false, `duplicate handler: ${channel}`);
            handlers.set(channel, handler);
        },
    });
    const logs: unknown[][] = [];
    const loads: { mode: string; accountRegistered: boolean }[] = [];
    let reads = 0, clears = 0;
    const forced: boolean[] = [];
    const app = Object.assign(new EventEmitter(), {
        getPath: (): string => "/unused/account-ipc-test",
        setPath: (): void => {},
        getAppPath: (): string => "/unused/account-ipc-test",
        getVersion: (): string => "test",
        requestSingleInstanceLock: (): boolean => true,
        setAsDefaultProtocolClient: (): boolean => true,
    });
    class Window extends EventEmitter {
        webContents = new EventEmitter();
        setMenuBarVisibility(): void { /* No native menus in the test window. */ }
        loadURL(): void { loads.push({ mode: "dev", accountRegistered: handlers.has(XODUS_ACCOUNT_REFRESH) }); }
        loadFile(): void { loads.push({ mode: "packaged", accountRegistered: handlers.has(XODUS_ACCOUNT_REFRESH) }); }
    }
    class Menu {
        append(): void { /* Record no native menu state. */ }
        static buildFromTemplate(): unknown[] { return []; }
        static setApplicationMenu(): void { /* No OS menu integration during tests. */ }
    }
    const mocks: Record<string, unknown> = {
        electron: { autoUpdater: new EventEmitter(), Tray: class extends EventEmitter { setToolTip(): void { return; } setContextMenu(): void { return; } }, nativeImage: { createFromPath: () => ({ resize: () => ({}) }) }, app, BrowserWindow: Window, ipcMain, Menu, MenuItem: class {}, nativeTheme: {}, shell: {}, dialog: {} },
        "electron-updater": { autoUpdater: new EventEmitter() },
        "@electron-toolkit/utils": { is: { dev } },
        fs: { existsSync: (): boolean => true },
        "./diagnostics/LogWriter": { discardRun: (): void => {}, mainLog: (...args: unknown[]): void => { logs.push(args); } },
        "./net/DownloadService": { registerDownloadIpc: (): void => {} },
        "./protocol/IconProtocol": { registerIconScheme: (): void => {}, serveIcons: (): void => {} },
        "./linux/XodusAccount": {
            getXodusAccountSnapshot: Object.assign(async (force: boolean): Promise<XodusAccountSnapshot> => {
                forced.push(force);
                reads++;
                if (failAccount) throw Error("private fixture authentication contents");
                return snapshot;
            }, { clearCache: () => { clears++; } }),
        },
        "./linux/XodusLogin": { logoutOfXodus: async () => ({ ok: true, message: null }), loginToXodus: async () => {
            if (failAccount) throw Error("private login contents");
            return { ok: true, message: null };
        } },
    };
    const require = createRequire(import.meta.url);
    const module = { exports: {} };
    new Function("require", "module", "exports", "process", "__dirname", compiled.outputFiles[0].text)(
        (id: string): unknown => id in mocks ? mocks[id] : require(id),
        module, module.exports,
        { platform, env: dev ? { ELECTRON_RENDERER_URL: "http://localhost:5173" } : {}, argv: ["electron", "test"] },
        "/unused/account-ipc-test/out/main",
    );
    assert.equal(reads, 0, "startup should not access account credentials");
    app.emit("ready");
    return { handlers, loads, logs, accountReads: () => reads, forced, cleared: () => clears };
}

describe("Xodus account main IPC wiring", () => {
    it("registers before loading either Linux renderer and forwards account refreshes", async () => {
        for (const dev of [true, false]) {
            const main = startMain("linux", dev);
            assert.deepEqual(main.loads, [{ mode: dev ? "dev" : "packaged", accountRegistered: true }]);
            assert.deepEqual(await main.handlers.get(XODUS_ACCOUNT_REFRESH)!(), snapshot);
            assert.equal(main.accountReads(), 1);
            await main.handlers.get(XODUS_ACCOUNT_REFRESH)!(undefined, true);
            assert.deepEqual(main.forced, [false, true]);
            assert.deepEqual(await main.handlers.get(XODUS_ACCOUNT_LOGOUT)!(), { ok: true, message: null });
            assert.equal(main.cleared(), 1);
            assert.deepEqual(await main.handlers.get(XODUS_ACCOUNT_LOGIN)!(), { ok: true, message: null });
        }
    });

    it("keeps the account IPC disabled on Windows", () => {
        const main = startMain("win32");
        assert.equal(main.handlers.has(XODUS_ACCOUNT_REFRESH), false);
        assert.equal(main.handlers.has(XODUS_ACCOUNT_LOGIN), false);
        assert.equal(main.handlers.has(XODUS_ACCOUNT_LOGOUT), false);
        assert.deepEqual(main.loads, [{ mode: "packaged", accountRegistered: false }]);
        assert.equal(main.accountReads(), 0);
    });

    it("never forwards or logs private backend exception contents", async () => {
        const main = startMain("linux", false, true);
        await assert.rejects(main.handlers.get(XODUS_ACCOUNT_REFRESH)!(), {
            message: "Could not refresh account status.",
        });
        assert.equal(JSON.stringify(main.logs).includes("private fixture"), false);
        assert.deepEqual(await main.handlers.get(XODUS_ACCOUNT_LOGIN)!(), { ok: false, message: "Could not open Xodus login. Try again." });
        assert.equal(JSON.stringify(main.logs).includes("private login"), false);
    });
});
