import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import path from "node:path";
import { it } from "node:test";
import { build } from "esbuild";
import { LIVE_CONSOLE_BATCH, LIVE_CONSOLE_SUBSCRIBE, LIVE_CONSOLE_UNSUBSCRIBE, type LiveLogEntry } from "../src/shared/diagnostics/LiveConsole.ts";

it("retains output between page visits, clears without replay, and owns only one IPC subscription", async () => {
    const root = path.resolve(import.meta.dirname, "..");
    const compiled = await build({
        entryPoints: [path.join(root, "src/renderer/src/states/LiveConsoleStore.ts")],
        bundle: true, platform: "node", format: "cjs", write: false,
        define: { "import.meta.hot": "undefined" },
        plugins: [{ name: "console-store-alias", setup(builder) {
            builder.onResolve({ filter: /^@shared\// }, args => ({ path: path.join(root, "src/shared", args.path.slice("@shared/".length) + ".ts") }));
        } }],
    });
    const ipc = Object.assign(new EventEmitter(), { send: (channel: string): void => { sent.push(channel); } });
    const sent: string[] = [];
    const events = new EventEmitter();
    const nodeRequire = createRequire(import.meta.url);
    const testWindow = {
        require: (name: string): unknown => name === "electron" ? { ipcRenderer: ipc } : nodeRequire(name),
        addEventListener: (name: string, callback: () => void): void => { events.on(name, callback); },
        removeEventListener: (name: string, callback: () => void): void => { events.off(name, callback); },
    };
    const module = { exports: {} };
    new Function("require", "module", "exports", "window", compiled.outputFiles[0].text)(nodeRequire, module, module.exports, testWindow);
    const { initializeLiveConsole, useLiveConsoleStore } = module.exports as typeof import("../src/renderer/src/states/LiveConsoleStore.ts");
    const line = (id: number): LiveLogEntry => ({ id, time: 1234, source: "renderer", scope: "xodus", level: "INFO", message: `Building ${id}` });

    initializeLiveConsole();
    initializeLiveConsole();
    assert.deepEqual(sent, [LIVE_CONSOLE_SUBSCRIBE]);
    assert.equal(ipc.listenerCount(LIVE_CONSOLE_BATCH), 1);
    ipc.emit(LIVE_CONSOLE_BATCH, {}, [line(1)]);
    assert.equal(useLiveConsoleStore.getState().connected, true);
    const leavePage = useLiveConsoleStore.subscribe(() => {});
    leavePage();
    ipc.emit(LIVE_CONSOLE_BATCH, {}, [line(2)]);
    assert.deepEqual(useLiveConsoleStore.getState().entries.map(entry => entry.id), [1, 2]);

    useLiveConsoleStore.getState().clear();
    ipc.emit(LIVE_CONSOLE_BATCH, {}, [line(1), line(2), line(3)]);
    assert.deepEqual(useLiveConsoleStore.getState().entries.map(entry => entry.id), [3]);
    assert.deepEqual(sent, [LIVE_CONSOLE_SUBSCRIBE], "clearing the view never deletes or resets main-process logs");

    events.emit("beforeunload");
    assert.equal(ipc.listenerCount(LIVE_CONSOLE_BATCH), 0);
    assert.equal(useLiveConsoleStore.getState().connected, false);
    assert.deepEqual(sent, [LIVE_CONSOLE_SUBSCRIBE, LIVE_CONSOLE_UNSUBSCRIBE]);
});
