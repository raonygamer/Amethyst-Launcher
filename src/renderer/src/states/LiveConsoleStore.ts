import { create } from "zustand";
import { LiveConsoleBuffer, LIVE_CONSOLE_BATCH, LIVE_CONSOLE_SUBSCRIBE, LIVE_CONSOLE_UNSUBSCRIBE,
    type LiveLogEntry } from "@shared/diagnostics/LiveConsole";

interface LiveConsoleState {
    entries: readonly LiveLogEntry[];
    connected: boolean;
    clear(): void;
}

const history = new LiveConsoleBuffer();

/** The buffer lives outside the page so navigation never stops collection or loses the view. */
export const useLiveConsoleStore = create<LiveConsoleState>(set => ({
    entries: [],
    connected: false,
    clear: () => {
        history.clear();
        set({ entries: history.snapshot() });
    },
}));

let stop: (() => void) | undefined;

/** Subscribe once at renderer startup; the main process sends history before live batches. */
export function initializeLiveConsole(): void {
    if (stop) return;
    const { ipcRenderer } = window.require("electron") as typeof import("electron");
    const receive = (_event: Electron.IpcRendererEvent, entries: LiveLogEntry[]): void => {
        if (!Array.isArray(entries)) return;
        history.append(entries);
        useLiveConsoleStore.setState({ entries: history.snapshot(), connected: true });
    };
    const cleanup = (): void => {
        ipcRenderer.removeListener(LIVE_CONSOLE_BATCH, receive);
        ipcRenderer.send(LIVE_CONSOLE_UNSUBSCRIBE);
        window.removeEventListener("beforeunload", cleanup);
        useLiveConsoleStore.setState({ connected: false });
        stop = undefined;
    };
    ipcRenderer.on(LIVE_CONSOLE_BATCH, receive);
    stop = cleanup;
    window.addEventListener("beforeunload", cleanup);
    ipcRenderer.send(LIVE_CONSOLE_SUBSCRIBE);
}

if (import.meta.hot) import.meta.hot.dispose(() => stop?.());
