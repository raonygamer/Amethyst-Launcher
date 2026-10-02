import assert from "node:assert/strict";
import { it } from "node:test";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import path from "node:path";
import { build } from "esbuild";

interface MainFixture {
    actions: string[];
    sent: unknown[][];
    app: EventEmitter;
    ipc: EventEmitter;
    window: EventEmitter & { webContents: EventEmitter; destroyed: boolean; options: { webPreferences: { backgroundThrottling: boolean } } };
    menu: { label?: string; click?: () => void }[];
}

async function mainFixture(url?: string): Promise<MainFixture> {
    const actions: string[] = [], sent: unknown[][] = [];
    const windows: FakeWindow[] = [];
    class FakeWindow extends EventEmitter {
        webContents = Object.assign(new EventEmitter(), { send: (...args: unknown[]) => sent.push(args) });
        destroyed = false;
        options: { webPreferences: { backgroundThrottling: boolean } };
        constructor(options: { webPreferences: { backgroundThrottling: boolean } }) { super(); this.options = options; windows.push(this); }
        setMenuBarVisibility(): void { return; }
        loadFile(): void { return; }
        loadURL(): void { return; }
        isDestroyed(): boolean { return this.destroyed; }
        isMinimized(): boolean { return false; }
        hide(): void { actions.push("hide"); }
        show(): void { actions.push("show"); }
        focus(): void { actions.push("focus"); }
        close(): void {
            let prevented = false;
            this.emit("close", { preventDefault: () => { prevented = true; } });
            if (!prevented) { this.destroyed = true; this.emit("closed"); }
        }
    }
    let menu: { label?: string; click?: () => void }[] = [];
    class FakeTray extends EventEmitter {
        setToolTip(): void { return; }
        setContextMenu(value: typeof menu): void { menu = value; }
        destroy(): void { return; }
    }
    const app = Object.assign(new EventEmitter(), {
        isPackaged: true, getPath: () => "/tmp/amethyst-main-fixture", getAppPath: () => "/tmp/amethyst-main-fixture",
        getVersion: () => "test", setPath: () => {}, requestSingleInstanceLock: () => true,
        setAsDefaultProtocolClient: () => true, isReady: () => true,
        quit: () => { actions.push("quit"); app.emit("before-quit"); windows[0]?.close(); },
    });
    const ipc = Object.assign(new EventEmitter(), { handle: () => {} });
    const updater = new EventEmitter();
    const fixture = { electron: { app, ipcMain: ipc, BrowserWindow: FakeWindow, Tray: FakeTray,
        Menu: { setApplicationMenu: () => {}, buildFromTemplate: (value: typeof menu) => value }, MenuItem: class {},
        nativeImage: { createFromPath: () => ({ resize: () => ({}) }) }, nativeTheme: {}, shell: {}, dialog: {}, autoUpdater: updater }, updater };
    const mocks: Record<string, string> = {
        "electron": "module.exports=fixture.electron;",
        "electron-updater": "export const autoUpdater=fixture.updater;",
        "@electron-toolkit/utils": "export const is={dev:false};",
        "./diagnostics/LogWriter": "export const discardRun=()=>{};export const mainLog=()=>{};",
        "./linux/XodusAccount": "export const getXodusAccountSnapshot=()=>{};",
        "./linux/XodusLogin": "export const loginToXodus=()=>{};export const logoutOfXodus=()=>{};",
        "./linux/ProfileShortcuts": "export const createProfileShortcutSync=()=>()=>{};",
        "../renderer/src/assets/icons/128x128.png?asset": "export default '/tmp/icon.png';",
        "./net/DownloadService": "export const registerDownloadIpc=()=>{};",
        "./protocol/IconProtocol": "export const registerIconScheme=()=>{};export const serveIcons=()=>{};",
        "fs": "export const existsSync=()=>true;export const mkdirSync=()=>{};",
    };
    const output = await build({ entryPoints: [path.resolve("src/main/index.ts")], bundle: true, platform: "node", format: "cjs", write: false,
        plugins: [{ name: "fixtures", setup(builder) {
            builder.onResolve({ filter: /.*/ }, args => Object.hasOwn(mocks, args.path) ? { path: args.path, namespace: "fixture" } : null);
            builder.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: mocks[args.path], loader: "js" }));
        } }],
    });
    const fakeProcess = { env: {}, platform: "linux", execPath: "/tmp/launcher", argv: ["/tmp/launcher", ...(url ? [url] : [])] };
    new Function("require", "fixture", "process", "__dirname", output.outputFiles[0].text)(createRequire(import.meta.url), fixture, fakeProcess, "/tmp/amethyst-main-fixture/out/main");
    app.emit("ready");
    return { actions, sent, app, ipc, window: windows[0], menu };
}

it("cold and warm profile links never reveal the launcher, wait for hydration, and survive window close", async () => {
    const link = "amethyst-launcher://launchprofile/profile-id";
    const f = await mainFixture(link);
    f.window.emit("ready-to-show");
    assert.deepEqual(f.actions, []);
    assert.deepEqual(f.sent, []);
    assert.equal(f.window.options.webPreferences.backgroundThrottling, false);
    f.ipc.emit("AMETHYST_PROTOCOL_READY", { sender: f.window.webContents });
    assert.deepEqual(f.sent, [["AMETHYST_PROTOCOL_URL", link]]);
    f.ipc.emit("TITLE_BAR_ACTION", {}, "CLOSE");
    assert.equal(f.window.destroyed, false); assert.deepEqual(f.actions, ["hide"]);
    f.actions.length = 0;
    f.app.emit("second-instance", {}, ["launcher", link]);
    assert.deepEqual(f.actions, []); assert.equal(f.sent.length, 2);
    f.app.emit("second-instance", {}, ["launcher"]);
    assert.deepEqual(f.actions, ["show", "focus"]);
    f.actions.length = 0;
    f.menu.find(item => item.label === "Quit Amethyst Launcher")!.click!();
    assert.deepEqual(f.actions, ["quit"]); assert.equal(f.window.destroyed, true);
});

it("normal startup shows the window, but a profile link arriving during startup does not", async () => {
    const normal = await mainFixture();
    normal.window.emit("ready-to-show"); assert.deepEqual(normal.actions, ["show"]);
    const early = await mainFixture();
    early.app.emit("second-instance", {}, ["launcher", "amethyst-launcher://launchprofile/early"]);
    early.ipc.emit("AMETHYST_PROTOCOL_READY", { sender: early.window.webContents });
    early.window.emit("ready-to-show"); assert.deepEqual(early.actions, []);
    assert.equal(early.sent.length, 1);
});

it("keeps shortcut readiness across hash routes and subframes, but queues during a full reload", async () => {
    const f = await mainFixture();
    f.window.emit("ready-to-show");
    f.ipc.emit("AMETHYST_PROTOCOL_READY", { sender: f.window.webContents });
    f.actions.length = 0;
    const link = "amethyst-launcher://launchprofile/profile-id";
    f.window.webContents.emit("did-start-loading");
    f.window.webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });
    f.app.emit("second-instance", {}, ["launcher", link]);
    assert.equal(f.sent.length, 1);
    f.window.webContents.emit("did-start-navigation", { isMainFrame: false, isSameDocument: false });
    f.app.emit("second-instance", {}, ["launcher", link]);
    assert.equal(f.sent.length, 2);
    f.window.webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    f.app.emit("second-instance", {}, ["launcher", link]);
    assert.equal(f.sent.length, 2);
    f.ipc.emit("AMETHYST_PROTOCOL_READY", { sender: f.window.webContents });
    assert.equal(f.sent.length, 3);
    assert.deepEqual(f.actions, []);
});
