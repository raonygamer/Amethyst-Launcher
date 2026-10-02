import type { BrowserWindow } from "electron";

export function isProfileLaunchUrl(value: string | null): boolean {
    if (!value) return false;
    try {
        const url = new URL(value);
        return url.protocol === "amethyst-launcher:" && url.hostname === "launchprofile";
    } catch { return false; }
}

/** Keep renderer-owned builds, transfers and log subscriptions alive when the window closes. */
export function keepWindowInBackground(window: BrowserWindow, isQuitting: () => boolean): void {
    window.on("close", event => {
        if (isQuitting()) return;
        event.preventDefault();
        window.hide();
    });
}

export function revealWindow(window: BrowserWindow): void {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
}
