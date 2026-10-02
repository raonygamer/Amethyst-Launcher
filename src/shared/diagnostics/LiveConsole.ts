import type { LogEntry } from "./Log.ts";

export interface LiveLogEntry extends LogEntry {
    /** Main-process arrival order, shared by history and live batches. */
    id: number;
}

export const LIVE_CONSOLE_SUBSCRIBE = "LIVE_CONSOLE_SUBSCRIBE";
export const LIVE_CONSOLE_UNSUBSCRIBE = "LIVE_CONSOLE_UNSUBSCRIBE";
export const LIVE_CONSOLE_BATCH = "LIVE_CONSOLE_BATCH";

export const LIVE_CONSOLE_MAX_ENTRIES = 2000;
export const LIVE_CONSOLE_MAX_BYTES = 1024 * 1024;
export const LIVE_CONSOLE_MESSAGE_BYTES = 16 * 1024;

const TRUNCATED = "… [truncated]";
const encoder = new TextEncoder();

// Terminal colour, cursor movement, hyperlinks and other terminal-only control strings.
/* eslint-disable no-control-regex */
const ansi = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\|$)|[PX^_][\s\S]*?(?:\u001b\\|$)|[ -/]*[@-~])|\u009b[0-?]*[ -/]*[@-~]|\u009d[^\u0007\u009c]*(?:\u0007|\u009c|$)/g;
const controls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
/* eslint-enable no-control-regex */

function plainText(value: string, maxBytes: number): string {
    const cleaned = value.replace(ansi, "").replace(/\r\n?/g, "\n").replace(controls, "");
    const encoded = encoder.encode(cleaned);
    if (encoded.length <= maxBytes) return cleaned;

    let end = maxBytes - encoder.encode(TRUNCATED).length;
    // Stop before a partial UTF-8 character rather than showing a replacement glyph.
    while (end > 0 && (encoded[end] & 0xc0) === 0x80) end--;
    return new TextDecoder().decode(encoded.subarray(0, end)) + TRUNCATED;
}

/** A small session tail. Clearing it also remembers which history has already been consumed. */
export class LiveConsoleBuffer {
    private entries: LiveLogEntry[] = [];
    private sizes: number[] = [];
    private bytes = 0;
    private lastId = 0;

    append(entries: readonly LiveLogEntry[]): void {
        // A history reply and a live batch can overlap. Sort within a batch, then ignore IDs
        // already seen, including IDs removed by Clear or by the memory limit.
        const ordered = entries.filter(entry => Number.isSafeInteger(entry?.id) && entry.id > this.lastId)
            .sort((a, b) => a.id - b.id);
        for (const entry of ordered) {
            if (entry.id <= this.lastId) continue;
            if (typeof entry.message !== "string" || typeof entry.source !== "string" || typeof entry.scope !== "string") continue;
            const normalized: LiveLogEntry = {
                id: entry.id,
                time: Number.isFinite(entry.time) ? entry.time : Date.now(),
                source: plainText(entry.source, 256).replace(/\n/g, " "),
                scope: plainText(entry.scope, 256).replace(/\n/g, " "),
                level: ["INFO", "WARN", "ERROR", "DEBUG"].includes(entry.level) ? entry.level : "INFO",
                message: plainText(entry.message, LIVE_CONSOLE_MESSAGE_BYTES),
            };
            const size = encoder.encode(normalized.source + normalized.scope + normalized.message).length;
            this.entries.push(normalized);
            this.sizes.push(size);
            this.bytes += size;
            this.lastId = entry.id;
        }

        let dropped = 0;
        while (this.entries.length - dropped > LIVE_CONSOLE_MAX_ENTRIES || this.bytes > LIVE_CONSOLE_MAX_BYTES) {
            this.bytes -= this.sizes[dropped++];
        }
        if (dropped > 0) {
            this.entries.splice(0, dropped);
            this.sizes.splice(0, dropped);
        }
    }

    snapshot(): readonly LiveLogEntry[] {
        return this.entries.slice();
    }

    clear(): void {
        this.entries = [];
        this.sizes = [];
        this.bytes = 0;
    }
}
