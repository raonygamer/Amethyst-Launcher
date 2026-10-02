// Imported first: opening the run's log file and installing the console shim has to happen
// before any other module gets a chance to log or throw.
import { discardRun, mainLog } from "./diagnostics/LogWriter";

import { is } from "@electron-toolkit/utils";
import { app, autoUpdater as nativeAutoUpdater, BrowserWindow, dialog, ipcMain, Menu, MenuItem, nativeImage, nativeTheme, shell, Tray } from "electron";
import { autoUpdater } from "electron-updater";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

import { describeError } from "../shared/diagnostics/Log";
import { XODUS_ACCOUNT_LOGIN, XODUS_ACCOUNT_LOGOUT, XODUS_ACCOUNT_REFRESH } from "../shared/linux/XodusAccountTypes";
import { getXodusAccountSnapshot } from "./linux/XodusAccount";
import { loginToXodus, logoutOfXodus } from "./linux/XodusLogin";
import { createProfileShortcutSync } from "./linux/ProfileShortcuts";
import { PROFILE_SHORTCUTS_SYNC } from "../shared/linux/ProfileShortcuts";
import { isProfileLaunchUrl, keepWindowInBackground, revealWindow } from "./BackgroundWindow";
import launcherIcon from "../renderer/src/assets/icons/128x128.png?asset";
import { registerDownloadIpc } from "./net/DownloadService";
import { registerIconScheme, serveIcons } from "./protocol/IconProtocol";

process.env["ELECTRON_DISABLE_SECURITY_WARNINGS"] = "true";

registerIconScheme();

{
    const amethyst_appdata_path = path.join(app.getPath("appData"), "Amethyst", "Launcher", "AppData");
    if (!fs.existsSync(amethyst_appdata_path)) {
        mainLog("INFO", "startup", `Creating userData folder ${amethyst_appdata_path}`);
        fs.mkdirSync(amethyst_appdata_path, { recursive: true });
    }
    try {
        app.setPath("userData", amethyst_appdata_path);
        mainLog("INFO", "startup", `userData set to ${amethyst_appdata_path}`);
    } catch (e) {
        mainLog("ERROR", "startup", `Could not set userData to ${amethyst_appdata_path}: ${describeError(e)}`);
    }
}

let mainWindow: Electron.BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let protocolReady = false;
let backgroundLaunchRequested = false;
const pendingProtocolUrls: string[] = [];

function showMainWindow(): void {
    if (!app.isReady()) { void app.whenReady().then(showMainWindow); return; }
    if (!mainWindow || mainWindow.isDestroyed()) {
        mainWindow = createWindow();
        mainWindow.once("ready-to-show", () => { if (mainWindow) revealWindow(mainWindow); });
    } else revealWindow(mainWindow);
}

function createTray(): void {
    tray = new Tray(nativeImage.createFromPath(launcherIcon).resize({ width: 22, height: 22 }));
    tray.setToolTip("Amethyst Launcher");
    tray.setContextMenu(Menu.buildFromTemplate([
        { label: "Open Amethyst Launcher", click: showMainWindow },
        { type: "separator" },
        { label: "Quit Amethyst Launcher", click: () => app.quit() },
    ]));
    tray.on("click", showMainWindow);
    tray.on("double-click", showMainWindow);
}

/** Every renderer-bound send goes through here, so a dropped message is never silent. */
function sendToWindow(scope: string, channel: string, payload?: unknown): boolean {
    if (!mainWindow) {
        mainLog("WARN", scope, `Dropped "${channel}": no window exists yet (payload ${describeError(payload)})`);
        return false;
    }
    if (mainWindow.isDestroyed()) {
        mainLog("WARN", scope, `Dropped "${channel}": window is destroyed (payload ${describeError(payload)})`);
        return false;
    }
    mainWindow.webContents.send(channel, payload);
    return true;
}

const devRendererUrl = is.dev && process.env["ELECTRON_RENDERER_URL"] ? process.env["ELECTRON_RENDERER_URL"] : null;
const rendererRoot = path.resolve(__dirname, "../renderer");

/**
 * The renderer displays third-party markdown, so a navigation it did not intend is assumed
 * hostile. Only the app's own bundle counts as its own URL — including local files, because a
 * mod archive can drop an HTML file on disk and `file://` runs with the same Node privileges.
 */
function isAppUrl(target: string): boolean {
    let url: URL;
    try {
        url = new URL(target);
    } catch {
        return false;
    }

    if (devRendererUrl) {
        try {
            return url.origin === new URL(devRendererUrl).origin;
        } catch {
            return false;
        }
    }

    if (url.protocol !== "file:") return false;
    try {
        const relative = path.relative(rendererRoot, fileURLToPath(url));
        return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
    } catch {
        return false;
    }
}

const EXTERNAL_PROTOCOLS = ["http:", "https:", "mailto:"];

/** Hands a URL to the OS browser, refusing the schemes that would make the shell an exec sink. */
function openExternally(target: string): void {
    let url: URL;
    try {
        url = new URL(target);
    } catch {
        mainLog("WARN", "window", `Not opening "${target}" externally: it is not a URL`);
        return;
    }

    if (!EXTERNAL_PROTOCOLS.includes(url.protocol)) {
        mainLog("WARN", "window", `Not opening ${url.href} externally: "${url.protocol}" is not a browser scheme`);
        return;
    }

    mainLog("INFO", "window", `Opening ${url.href} in the default browser`);
    shell.openExternal(url.href).catch(e => {
        mainLog("ERROR", "window", `Could not open ${url.href} externally: ${describeError(e)}`);
    });
}

function guardNavigation(contents: Electron.WebContents): void {
    contents.on("will-navigate", (event, url) => {
        if (isAppUrl(url)) return;
        event.preventDefault();
        mainLog("WARN", "window", `Blocked a top-level navigation to ${url}`);
        openExternally(url);
    });

    contents.setWindowOpenHandler(({ url }) => {
        mainLog("INFO", "window", `Blocked a new window for ${url}`);
        openExternally(url);
        return { action: "deny" };
    });

    contents.on("will-attach-webview", event => {
        mainLog("WARN", "window", "Blocked a <webview> attachment");
        event.preventDefault();
    });
}

app.on("web-contents-created", (_event, contents) => guardNavigation(contents));

function createWindow(): BrowserWindow {
    const win = new BrowserWindow({
        width: 800,
        height: 600,
        minWidth: 600,
        minHeight: 400,
        backgroundColor: "#1E1E1F",
        show: false,
        webPreferences: {
            preload: path.join(app.getAppPath(), "/out/preload/index.js"),
            nodeIntegration: true,
            contextIsolation: false,
            backgroundThrottling: false,
        },
        frame: false,
    });

    win.setMenuBarVisibility(false);
    keepWindowInBackground(win, () => quitting);
    win.on("query-session-end", () => { quitting = true; });
    win.on("session-end", () => { quitting = true; });
    // HashRouter navigation can emit loading events while keeping the same renderer and IPC
    // listener. Only a new main-frame document needs a new readiness handshake.
    win.webContents.on("did-start-navigation", details => {
        if (details.isMainFrame && !details.isSameDocument) protocolReady = false;
    });

    if (devRendererUrl) {
        mainLog("INFO", "window", `Loading dev renderer from ${devRendererUrl}`);
        win.loadURL(devRendererUrl);
    } else {
        const file = path.join(__dirname, "../renderer/index.html");
        mainLog("INFO", "window", `Loading packaged renderer from ${file}`);
        win.loadFile(file);
    }

    win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
        mainLog("ERROR", "window", `Renderer failed to load ${validatedURL}: ${errorDescription} (${errorCode})`);
    });
    win.on("unresponsive", () => mainLog("WARN", "window", "Renderer stopped responding"));
    win.on("closed", () => {
        if (mainWindow === win) mainWindow = null;
        protocolReady = false;
        mainLog("INFO", "window", "Main window closed");
    });

    return win;
}

// Reload is not shipped: every child process is spawned from the renderer, so Ctrl+R during an
// appx registration destroys the state awaiting an elevated PowerShell that keeps running.
if (is.dev) {
    const windowMenu = new Menu();
    windowMenu.append(new MenuItem({ role: "toggleDevTools" }));
    windowMenu.append(new MenuItem({ role: "reload" }));
    Menu.setApplicationMenu(windowMenu);
} else {
    Menu.setApplicationMenu(null);
}

ipcMain.on("TITLE_BAR_ACTION", (_, args) => {
    if (!mainWindow) {
        mainLog("WARN", "ipc", `TITLE_BAR_ACTION "${args}" ignored: no window exists`);
        return;
    }

    switch (args) {
        case "TOGGLE_MAXIMIZED":
            mainLog("INFO", "ipc", `TITLE_BAR_ACTION ${mainWindow.isMaximized() ? "unmaximize" : "maximize"}`);
            mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
            break;
        case "MINIMIZE":
            mainLog("INFO", "ipc", "TITLE_BAR_ACTION minimize");
            mainWindow.minimize();
            break;
        case "CLOSE":
            mainLog("INFO", "ipc", "TITLE_BAR_ACTION close, continuing in background");
            mainWindow.close();
            break;
        default:
            mainLog("WARN", "ipc", `TITLE_BAR_ACTION ignored: unknown action "${args}"`);
            break;
    }
});

ipcMain.on("WINDOW_UI_THEME", (_, args) => {
    switch (args) {
        case "Light":
            nativeTheme.themeSource = "light";
            break;
        case "Dark":
            nativeTheme.themeSource = "dark";
            break;
        case "System":
            nativeTheme.themeSource = "system";
            break;
        default:
            mainLog("WARN", "ipc", `WINDOW_UI_THEME "${args}" is not a known theme, falling back to system`);
            nativeTheme.themeSource = "system";
            break;
    }
    mainLog("INFO", "ipc", `WINDOW_UI_THEME requested "${args}", themeSource is now "${nativeTheme.themeSource}"`);
});

/**
 * Every invoke handler reports what it answered and, on a throw, why. An IPC call that failed
 * silently used to show up in the renderer as a rejected promise with no trace of the channel.
 */
function handle<T>(
    channel: string,
    body: (...args: never[]) => T | Promise<T>,
    describe?: (result: T) => string
): void {
    ipcMain.handle(channel, async (_event, ...args) => {
        try {
            const result = await body(...(args as never[]));
            mainLog("INFO", "ipc", `${channel} -> ${describe ? describe(result) : "ok"}`);
            return result;
        } catch (e) {
            mainLog("ERROR", "ipc", `${channel} failed: ${describeError(e)}`);
            throw e;
        }
    });
}

// Sync because every file the renderer writes stamps the version that wrote it, and the write
// paths are not async.
ipcMain.on("get-app-version-sync", (event) => {
    event.returnValue = app.getVersion();
});

ipcMain.on("APP_STATE_INIT_REQUEST", event => {
    mainLog("INFO", "ipc", "APP_STATE_INIT_REQUEST received, replying APP_STATE_INIT");
    event.sender.send("APP_STATE_INIT");
});

const hasSingleInstanceLock = app.requestSingleInstanceLock();

// Register the custom protocol so OS shortcuts can deep-link into the app.
const protocolRegistered = app.setAsDefaultProtocolClient("amethyst-launcher");
mainLog("INFO", "startup", `amethyst-launcher:// protocol registration ${protocolRegistered ? "succeeded" : "failed"}`);

/** Extracts the first amethyst-launcher:// URL from a argv array, or null. */
function extractProtocolUrl(argv: string[]): string | null {
    return argv.find(arg => arg.startsWith("amethyst-launcher://")) ?? null;
}

/** Forwards a protocol URL to the renderer if the window is ready. */
function handleProtocolUrl(url: string): void {
    mainLog("INFO", "protocol", `Protocol URL received: ${url}`);
    if (isProfileLaunchUrl(url)) backgroundLaunchRequested = true;
    if (!mainWindow || !protocolReady) {
        pendingProtocolUrls.push(url);
        mainLog("INFO", "protocol", "Holding launch link until profiles and the protocol listener are ready");
        return;
    }

    if (!isProfileLaunchUrl(url)) revealWindow(mainWindow);
    sendToWindow("protocol", "AMETHYST_PROTOCOL_URL", url);
}

ipcMain.on("AMETHYST_PROTOCOL_READY", event => {
    if (event.sender !== mainWindow?.webContents) return;
    protocolReady = true;
    mainLog("INFO", "protocol", `Renderer ready; delivering ${pendingProtocolUrls.length} queued link(s)`);
    for (const url of pendingProtocolUrls.splice(0)) handleProtocolUrl(url);
});

const MOD_ARCHIVE_EXTENSIONS = [".amethyst", ".zip"];

/** Extracts the first mod archive path from an argv array, or null. */
function extractModFilePath(argv: string[]): string | null {
    const candidates = argv.slice(1).filter(arg => !arg.startsWith("-"));
    const match = candidates.find(arg => MOD_ARCHIVE_EXTENSIONS.includes(path.extname(arg).toLowerCase())) ?? null;

    if (match) {
        mainLog("INFO", "fileopen", `argv holds mod archive "${match}"`);
    }
    else if (candidates.length > 0) {
        mainLog(
            "INFO",
            "fileopen",
            `No mod archive in argv: [${candidates.join(", ")}] carry no ${MOD_ARCHIVE_EXTENSIONS.join("/")} extension`
        );
    }

    return match;
}

let pendingModFilePath: string | null = null;

/** Forwards a mod archive path to the renderer, holding it until the window exists. */
function handleModFilePath(file_path: string): void {
    const resolved = path.resolve(file_path);
    mainLog("INFO", "fileopen", `Mod file open requested: ${file_path} (resolved ${resolved})`);

    if (!mainWindow) {
        mainLog("INFO", "fileopen", `Holding ${resolved} until the window exists`);
        pendingModFilePath = resolved;
        return;
    }

    revealWindow(mainWindow);
    sendToWindow("fileopen", "AMETHYST_OPEN_FILE", resolved);
}

// Other window is open, so don't create a new one
if (hasSingleInstanceLock === false) {
    mainLog("INFO", "startup", `Another instance holds the lock; handing over argv [${process.argv.slice(1).join(" ")}] and quitting`);
    discardRun();
    app.quit();
}
// No window is open so create new
else {
    mainLog("INFO", "startup", "Single instance lock acquired");

    app.on("window-all-closed", () => {
        // quit(), not exit(): exit() skips before-quit/will-quit, so the log's terminal block
        // never writes and a deferred update never installs.
        mainLog("INFO", "shutdown", "All windows closed, quitting");
        app.quit();
    });

    app.on("before-quit", () => { quitting = true; mainLog("INFO", "shutdown", "before-quit"); });
    nativeAutoUpdater.on("before-quit-for-update", () => { quitting = true; });
    app.on("will-quit", () => { tray?.destroy(); tray = null; });
    app.on("quit", (_event, exitCode) => mainLog("INFO", "shutdown", `quit with exit code ${exitCode}`));
    app.on("activate", showMainWindow);
    app.on("open-url", (event, url) => { event.preventDefault(); handleProtocolUrl(url); });

    // macOS delivers file opens as an event instead of argv.
    app.on("open-file", (event, file_path) => {
        event.preventDefault();
        mainLog("INFO", "fileopen", `open-file event for ${file_path}`);
        handleModFilePath(file_path);
    });

    app.on("ready", () => {
        mainLog("INFO", "startup", `App ready, creating main window (version ${app.getVersion()})`);
        serveIcons();
        mainWindow = createWindow();
        createTray();

        mainWindow.once("ready-to-show", () => {
            // Handle the case where the app was cold-started via a protocol URL.
            const url = extractProtocolUrl(process.argv);
            const background = isProfileLaunchUrl(url) || backgroundLaunchRequested;
            mainLog("INFO", "window", background ? "Profile launch: keeping the window in the background" : "Window ready to show");
            if (!background) mainWindow!.show();
            if (url) handleProtocolUrl(url);
            else mainLog("INFO", "protocol", "Cold start carried no amethyst-launcher:// URL");

            // Handle the case where the app was cold-started by opening a mod file.
            const filePath = extractModFilePath(process.argv) ?? pendingModFilePath;
            pendingModFilePath = null;
            if (filePath) handleModFilePath(filePath);
        });
    });

    app.on("second-instance", (_event, commandLine) => {
        mainLog("INFO", "startup", `second-instance argv: [${commandLine.slice(1).join(" ")}]`);
        // Forward protocol URL if this instance was opened via deep-link.
        const url = extractProtocolUrl(commandLine);
        if (!isProfileLaunchUrl(url)) showMainWindow();
        if (url) handleProtocolUrl(url);

        // Forward mod file path if this instance was opened by a file association.
        const filePath = extractModFilePath(commandLine);
        if (filePath) handleModFilePath(filePath);
    });
}

registerDownloadIpc();

if (process.platform === "linux") {
    const dataHome = process.env.XDG_DATA_HOME && path.isAbsolute(process.env.XDG_DATA_HOME)
        ? process.env.XDG_DATA_HOME : path.join(app.getPath("home"), ".local/share");
    const executable = app.isPackaged && process.env.APPIMAGE && path.isAbsolute(process.env.APPIMAGE)
        ? process.env.APPIMAGE : process.execPath;
    const syncShortcuts = createProfileShortcutSync({ dataHome, iconSource: launcherIcon,
        command: app.isPackaged ? [executable] : [executable, app.getAppPath()],
    });
    ipcMain.handle(PROFILE_SHORTCUTS_SYNC, async (event, profiles: unknown) => {
        if (event.sender !== mainWindow?.webContents) throw new Error("Only the launcher can update profile shortcuts.");
        try { await syncShortcuts(profiles); }
        catch (error) { mainLog("ERROR", "Profiles", `Could not update application-menu shortcuts: ${describeError(error)}`); throw error; }
    });
    ipcMain.handle(XODUS_ACCOUNT_LOGIN, async () => {
        mainLog("INFO", "Xodus", "Opening account login");
        try {
            const result = await loginToXodus();
            if (result.ok) getXodusAccountSnapshot.clearCache();
            mainLog("INFO", "Xodus", result.ok ? "Login window closed; refreshing account status" : "Login did not complete");
            return result;
        } catch {
            return { ok: false, message: "Could not open Xodus login. Try again." };
        }
    });
    ipcMain.handle(XODUS_ACCOUNT_LOGOUT, async () => {
        try {
            const result = await logoutOfXodus();
            if (result.ok) getXodusAccountSnapshot.clearCache();
            mainLog("INFO", "Xodus", result.ok ? "Logged out; refreshing account status" : "Logout did not complete");
            return result;
        } catch { return { ok: false, message: "Could not log out of Xodus. Try again." }; }
    });
    ipcMain.handle(XODUS_ACCOUNT_REFRESH, async (_event, force?: unknown) => {
        try {
            return await getXodusAccountSnapshot(force === true);
        } catch {
            // Do not send or log raw authentication/keyring exceptions.
            throw new Error("Could not refresh account status.");
        }
    });
}

handle("get-app-version", () => app.getVersion(), result => result);

handle("check-for-updates", () => {
    autoUpdater.checkForUpdates().catch(e => {
        mainLog("ERROR", "update", `checkForUpdates failed: ${describeError(e)}`);
    });
    return "check started";
}, result => result);

handle("set-auto-download", (value: boolean) => {
    autoUpdater.autoDownload = value;
    return value;
}, result => `autoDownload=${result}`);

handle("set-auto-install-on-app-quit", (value: boolean) => {
    autoUpdater.autoInstallOnAppQuit = value;
    return value;
}, result => `autoInstallOnAppQuit=${result}`);

handle("update-download", async () => {
    const files = await autoUpdater.downloadUpdate();
    return files;
}, result => `downloaded ${Array.isArray(result) ? result.join(", ") : String(result)}`);

handle(
    "dialog:openFile",
    async (filters: Electron.FileFilter[]) => {
        const result = await dialog.showOpenDialog({ properties: ["openFile"], filters });
        return result.filePaths[0] ?? null;
    },
    result => result ?? "cancelled by user"
);

autoUpdater.on("checking-for-update", () => mainLog("INFO", "update", "Checking for updates"));

autoUpdater.on("update-available", info => {
    mainLog("INFO", "update", `Update available: ${info.version} released ${info.releaseDate}`);
    sendToWindow("update", "update-available", info);
});

autoUpdater.on("update-not-available", info => {
    mainLog("INFO", "update", `No update available, newest is ${info.version} and this build is ${app.getVersion()}`);
    sendToWindow("update", "update-not-available", info);
});

autoUpdater.on("update-cancelled", info => {
    mainLog("WARN", "update", `Update ${info.version} cancelled`);
    sendToWindow("update", "update-cancelled", info);
});

let lastLoggedUpdatePercent = -1;
autoUpdater.on("download-progress", info => {
    // Fires many times a second; only whole 10% steps reach the log.
    const step = Math.floor(info.percent / 10) * 10;
    if (step !== lastLoggedUpdatePercent) {
        lastLoggedUpdatePercent = step;
        mainLog("INFO", "update", `Update download ${step}% (${info.transferred} of ${info.total} bytes)`);
    }
    sendToWindow("update", "download-progress", info);
});

autoUpdater.on("update-downloaded", info => {
    // Installing is the user's call: autoInstallOnAppQuit carries the choice they made in the
    // update popup, and quitting here would kill a mod install that is mid-flight.
    mainLog(
        "INFO",
        "update",
        `Update ${info.version} downloaded; it will ${autoUpdater.autoInstallOnAppQuit ? "install on quit" : "not be installed"}`
    );
    sendToWindow("update", "update-downloaded", info);
});

autoUpdater.on("error", error => {
    mainLog("ERROR", "update", `Updater error: ${describeError(error)}`);
    sendToWindow("update", "update-error", error);
});
