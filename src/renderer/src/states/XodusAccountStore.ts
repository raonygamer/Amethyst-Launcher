import { create } from "zustand";
import { XODUS_ACCOUNT_LOGIN, XODUS_ACCOUNT_LOGOUT, XODUS_ACCOUNT_REFRESH, XODUS_RESTART, XODUS_ACCOUNT_LIBRARY, type XboxOwnedGames, type XodusAccountSnapshot, type XodusLoginResult } from "@shared/linux/XodusAccountTypes";

interface XodusAccountState {
    snapshot: XodusAccountSnapshot | null;
    loading: boolean;
    signingIn: boolean;
    signingOut: boolean;
    restarting: boolean;
    restart(): Promise<void>;
    library: XboxOwnedGames | null;
    libraryLoading: boolean;
    loadLibrary(force?: boolean): Promise<void>;
    logout(): Promise<void>;
    error: string | null;
    refresh(force?: boolean): Promise<void>;
    login(): Promise<void>;
}

let pending: Promise<void> | undefined;
let pendingLogout: Promise<void> | undefined;
let pendingLogin: Promise<void> | undefined;
let pendingRestart: Promise<void> | undefined;
let pendingLibrary: Promise<void> | undefined;
let accountRevision = 0;
let backendUnavailable = false;

export const useXodusAccountStore = create<XodusAccountState>((set, get) => ({
    snapshot: null,
    loading: false,
    signingIn: false,
    signingOut: false,
    restarting: false,
    library: null,
    libraryLoading: false,
    error: null,
    refresh: (force = false) => {
        if (window.process.platform !== "linux") return Promise.resolve();
        if (get().signingIn || get().signingOut || get().restarting) return Promise.resolve();
        if (pending) return pending;
        set({ loading: true, error: null });
        pending = Promise.resolve().then(async () => {
            try {
                const { ipcRenderer } = window.require("electron") as typeof import("electron");
                const snapshot: XodusAccountSnapshot = await ipcRenderer.invoke(XODUS_ACCOUNT_REFRESH, force);
                if (snapshot.profile?.xuid !== get().snapshot?.profile?.xuid || snapshot.session !== "signed_in") {
                    accountRevision++;
                    set({ library: null });
                }
                backendUnavailable = false;
                set({ snapshot, error: null });
            } catch (error) {
                // Never copy an IPC exception into the UI or log: it may contain account data.
                accountRevision++;
                backendUnavailable = error instanceof Error
                    && error.message.includes(`No handler registered for '${XODUS_ACCOUNT_REFRESH}'`);
                set({ snapshot: null, library: null, error: backendUnavailable
                    ? "Restart the launcher to load the account integration. If running in development, restart npm run dev."
                    : "Could not refresh account status. Try again." });
            } finally {
                pending = undefined;
                set({ loading: false });
            }
        });
        return pending;
    },
    loadLibrary: (force = false) => {
        if (window.process.platform !== "linux" || get().snapshot?.session !== "signed_in" || get().signingIn || get().signingOut || get().restarting) return Promise.resolve();
        if (pendingLibrary) return pendingLibrary;
        const revision = accountRevision;
        set({ libraryLoading: true });
        pendingLibrary = Promise.resolve().then(async () => {
            try {
                const { ipcRenderer } = window.require("electron") as typeof import("electron");
                const library: XboxOwnedGames = await ipcRenderer.invoke(XODUS_ACCOUNT_LIBRARY, force);
                if (revision === accountRevision) set({ library });
            } catch {
                if (revision === accountRevision) set({ library: { games: [], status: "unavailable", updatedAt: Date.now(), detail: "Could not load your Xbox library. Try Refresh again." } });
            } finally { pendingLibrary = undefined; set({ libraryLoading: false }); }
        });
        return pendingLibrary;
    },
    restart: () => {
        if (window.process.platform !== "linux" || get().signingIn || get().signingOut) return Promise.resolve();
        if (pendingRestart) return pendingRestart;
        set({ restarting: true, error: null });
        pendingRestart = Promise.resolve().then(async () => {
            try {
                await pending;
                const { ipcRenderer } = window.require("electron") as typeof import("electron");
                const result: XodusLoginResult = await ipcRenderer.invoke(XODUS_RESTART);
                set({ restarting: false });
                if (result.ok) await get().refresh(true);
                else set({ error: result.message || "Could not restart Xodus." });
            } catch {
                set({ error: "Could not restart Xodus. Fully quit and reopen the launcher, then try again." });
            } finally { pendingRestart = undefined; set({ restarting: false }); }
        });
        return pendingRestart;
    },
    logout: () => {
        if (window.process.platform !== "linux" || get().signingIn || get().restarting) return Promise.resolve();
        if (pendingLogout) return pendingLogout;
        accountRevision++;
        set({ library: null });
        set({ signingOut: true, error: null });
        pendingLogout = Promise.resolve().then(async () => {
            try {
                const { LauncherTools } = await import("@renderer/scripts/backend/tools/LauncherTools");
                await LauncherTools.Xodus.ensureVerified();
                await pending;
                const { ipcRenderer } = window.require("electron") as typeof import("electron");
                const result: XodusLoginResult = await ipcRenderer.invoke(XODUS_ACCOUNT_LOGOUT);
                set({ signingOut: false });
                if (result.ok) {
                    set({ snapshot: null });
                    await get().refresh(true);
                } else set({ error: result.message || "Xodus logout did not complete. Try again." });
            } catch {
                set({ error: "Could not log out of Xodus. Verify Xodus in Settings → Tools, then try again." });
            } finally { pendingLogout = undefined; set({ signingOut: false }); }
        });
        return pendingLogout;
    },
    login: () => {
        if (get().signingOut || get().restarting) return Promise.resolve();
        if (window.process.platform !== "linux") return Promise.resolve();
        if (pendingLogin) return pendingLogin;
        accountRevision++;
        set({ library: null });
        set({ signingIn: true, error: null });
        pendingLogin = Promise.resolve().then(async () => {
            try {
                const { LauncherTools } = await import("@renderer/scripts/backend/tools/LauncherTools");
                try { await LauncherTools.Xodus.ensureVerified(); }
                catch {
                    set({ error: "Xodus verification did not complete. Open Settings → Tools to verify Xodus, then try logging in again." });
                    return;
                }
                // Finish any earlier lookup so its result cannot overwrite the new login.
                await pending;
                set({ error: null });
                const { ipcRenderer } = window.require("electron") as typeof import("electron");
                const result: XodusLoginResult = await ipcRenderer.invoke(XODUS_ACCOUNT_LOGIN);
                set({ signingIn: false });
                if (result.ok) await get().refresh(true);
                else set({ error: result.message || "Xodus login did not complete. Try again." });
            } catch (error) {
                const missingHandler = error instanceof Error
                    && error.message.includes(`No handler registered for '${XODUS_ACCOUNT_LOGIN}'`);
                set({ error: missingHandler
                    ? "Restart the launcher to load the login integration. If running in development, restart npm run dev."
                    : "Could not open Xodus login. Try again." });
            } finally {
                pendingLogin = undefined;
                set({ signingIn: false });
            }
        });
        return pendingLogin;
    },
}));

let users = 0;
let stopPolling: (() => void) | undefined;

/** Keep the sidebar account current across page navigation, only while mounted on Linux. */
export function startXodusAccountPolling(): () => void {
    if (window.process.platform !== "linux") return () => {};
    users++;
    if (!stopPolling) {
        let lastRefresh = 0;
        const refresh = (): void => {
            // An old main process cannot gain a new handler through renderer hot reload.
            // Leave manual retry available, but stop repeating the same error every hour.
            if (backendUnavailable) return;
            lastRefresh = Date.now();
            void useXodusAccountStore.getState().refresh();
        };
        const focus = (): void => {
            if (Date.now() - lastRefresh >= 60 * 60_000) refresh();
        };
        const interval = window.setInterval(refresh, 60 * 60_000);
        const cleanup = (): void => {
            window.clearInterval(interval);
            window.removeEventListener("focus", focus);
            window.removeEventListener("beforeunload", cleanup);
            stopPolling = undefined;
            users = 0;
        };
        stopPolling = cleanup;
        window.addEventListener("focus", focus);
        window.addEventListener("beforeunload", cleanup);
        refresh();
    }
    // A component can dispose twice during development; never underflow the subscriber count.
    let stopped = false;
    return () => {
        if (stopped) return;
        stopped = true;
        if (--users <= 0) stopPolling?.();
    };
}

if (import.meta.hot) import.meta.hot.dispose(() => stopPolling?.());
