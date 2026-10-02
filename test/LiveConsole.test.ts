import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { build } from "esbuild";
import {
    LIVE_CONSOLE_BATCH,
    LIVE_CONSOLE_MAX_BYTES,
    LIVE_CONSOLE_MAX_ENTRIES,
    LIVE_CONSOLE_MESSAGE_BYTES,
    LIVE_CONSOLE_SUBSCRIBE,
    LIVE_CONSOLE_UNSUBSCRIBE,
    LiveConsoleBuffer,
} from "../src/shared/diagnostics/LiveConsole.ts";
import type { LiveLogEntry } from "../src/shared/diagnostics/LiveConsole.ts";

function entry(id: number, message = `line ${id}`): LiveLogEntry {
    return { id, time: id, source: "renderer", scope: "build", level: "INFO", message };
}

describe("live console history", () => {
    it("orders each batch and deduplicates overlapping history and streamed entries", () => {
        const buffer = new LiveConsoleBuffer();
        buffer.append([entry(3), entry(1), entry(2), entry(2)]);
        buffer.append([entry(2), entry(3), entry(4)]);
        assert.deepEqual(buffer.snapshot().map(value => value.id), [1, 2, 3, 4]);
    });

    it("does not restore cleared entries when history is replayed", () => {
        const buffer = new LiveConsoleBuffer();
        buffer.append([entry(1), entry(2)]);
        buffer.clear();
        assert.deepEqual(buffer.snapshot(), []);
        buffer.append([entry(1), entry(2), entry(3)]);
        assert.deepEqual(buffer.snapshot().map(value => value.id), [3]);
    });

    it("retains only the most recent entries when the count limit is reached", () => {
        const buffer = new LiveConsoleBuffer();
        buffer.append(Array.from({ length: LIVE_CONSOLE_MAX_ENTRIES + 5 }, (_, index) => entry(index + 1)));
        const values = buffer.snapshot();
        assert.equal(values.length, LIVE_CONSOLE_MAX_ENTRIES);
        assert.equal(values[0].id, 6);
        assert.equal(values.at(-1)?.id, LIVE_CONSOLE_MAX_ENTRIES + 5);
    });

    it("bounds UTF-8 message and total text size while preserving whole characters", () => {
        const buffer = new LiveConsoleBuffer();
        buffer.append(Array.from({ length: 100 }, (_, index) => entry(index + 1, "🎮".repeat(10000))));
        const values = buffer.snapshot();
        assert.ok(values.length > 0 && values.length < 100);
        assert.equal(values.at(-1)?.id, 100);
        let size = 0;
        for (const value of values) {
            assert.ok(Buffer.byteLength(value.message) <= LIVE_CONSOLE_MESSAGE_BYTES);
            assert.ok(value.message.endsWith("… [truncated]"));
            assert.ok(!value.message.includes("�"));
            size += Buffer.byteLength(value.message + value.scope + value.source);
        }
        assert.ok(size <= LIVE_CONSOLE_MAX_BYTES);
    });

    it("strips terminal commands and control characters without losing readable output", () => {
        const buffer = new LiveConsoleBuffer();
        buffer.append([entry(1, "\x1b[32mCompiling\x1b[0m\r50%\r\n\x1b]8;;https://example.test\x07link\x1b]8;;\x07\tDone\0\x07")]);
        assert.equal(buffer.snapshot()[0].message, "Compiling\n50%\nlink\tDone");
    });

    it("does not mutate producer entries and ignores invalid sequence numbers", () => {
        const buffer = new LiveConsoleBuffer();
        const original = entry(1, "\x1b[31merror\x1b[0m");
        buffer.append([entry(NaN), entry(-1), entry(0), entry(Infinity), original]);
        assert.equal(buffer.snapshot().length, 1);
        assert.equal(buffer.snapshot()[0].message, "error");
        assert.equal(original.message, "\x1b[31merror\x1b[0m");
    });
});

it("streams ordered history and new batches even when disk logging fails, and releases subscribers", async () => {
    const compiled = await build({
        entryPoints: [path.resolve(import.meta.dirname, "../src/main/diagnostics/LogWriter.ts")],
        bundle: true, platform: "node", format: "cjs", write: false, external: ["electron"],
    });
    const require = createRequire(import.meta.url);
    const ipcMain = new EventEmitter();
    const app = Object.assign(new EventEmitter(), {
        getPath: (): string => "/unused/log-test",
        getVersion: (): string => "test",
        whenReady: (): Promise<void> => Promise.resolve(),
        isPackaged: false,
    });
    let diskWrites = 0;
    const fs = {
        mkdirSync: (): void => {},
        readdirSync: (): string[] => [],
        statfsSync: (): never => { throw Error("unavailable"); },
        appendFileSync: (): never => { diskWrites++; throw Error("disk full"); },
    };
    interface Timer { callback: () => void; delay: number; unref: () => void; }
    const timers = new Set<Timer>();
    const schedule = (callback: () => void, delay: number): Timer => {
        const timer = { callback, delay, unref: (): void => {} };
        timers.add(timer);
        return timer;
    };
    const flush = (): void => {
        for (const timer of timers) {
            if (timer.delay !== 100) continue;
            timers.delete(timer);
            timer.callback();
        }
    };
    const module = { exports: {} };
    const quiet = { log: (): void => {}, warn: (): void => {}, error: (): void => {} };
    new Function("require", "module", "exports", "process", "console", "setTimeout", "clearTimeout", compiled.outputFiles[0].text)(
        (id: string): unknown => id === "electron" ? { ipcMain, app } : id === "fs" ? fs : require(id),
        module, module.exports, { ...process, on: (): void => {} }, quiet, schedule,
        (timer: Timer): void => { timers.delete(timer); },
    );
    const { writeEntry } = module.exports as typeof import("../src/main/diagnostics/LogWriter.ts");

    class Window extends EventEmitter {
        batches: LiveLogEntry[][] = [];
        destroyed = false;
        fail = false;
        isDestroyed(): boolean { return this.destroyed; }
        send(channel: string, entries: LiveLogEntry[]): void {
            if (this.fail) throw Error("renderer gone");
            assert.equal(channel, LIVE_CONSOLE_BATCH);
            this.batches.push(entries);
        }
    }
    const first = new Window();
    writeEntry(entry(100, `\x1b[32mBuilding ${os.homedir()}/tool\x1b[0m`));
    ipcMain.emit(LIVE_CONSOLE_SUBSCRIBE, { sender: first });
    assert.deepEqual(first.batches[0].map(value => value.id), [1]);
    assert.ok(first.batches[0][0].message.includes("%USERPROFILE%/tool"));
    assert.ok(!first.batches[0][0].message.includes("\x1b"));
    assert.equal(diskWrites, 1, "the failed header write disables persistence, but not live history");

    writeEntry(entry(200, "next step"));
    const second = new Window();
    ipcMain.emit(LIVE_CONSOLE_SUBSCRIBE, { sender: second });
    assert.deepEqual(second.batches[0].map(value => value.id), [1, 2]);
    flush();
    assert.deepEqual(first.batches[1].map(value => value.id), [2]);
    assert.equal(second.batches.length, 1, "a history reply already includes pending entries");

    ipcMain.emit(LIVE_CONSOLE_UNSUBSCRIBE, { sender: first });
    assert.equal(first.listenerCount("destroyed"), 0);
    writeEntry(entry(300, "finished"));
    flush();
    assert.equal(first.batches.length, 2);
    assert.deepEqual(second.batches[1].map(value => value.id), [3]);
    second.destroyed = true;
    second.emit("destroyed");
    assert.equal(second.listenerCount("render-process-gone"), 0);

    const broken = new Window();
    broken.fail = true;
    ipcMain.emit(LIVE_CONSOLE_SUBSCRIBE, { sender: broken });
    assert.equal(broken.listenerCount("destroyed"), 0, "failed sends release subscribers without logging recursively");
    writeEntry(entry(400, "after close"));
    assert.ok(![...timers].some(timer => timer.delay === 100));
});
