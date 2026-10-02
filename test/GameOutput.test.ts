import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { outputLines } from "../src/shared/diagnostics/OutputLines.ts";

(globalThis as unknown as { require: NodeRequire }).require = createRequire(import.meta.url);
const { spawnGameWithOutput, rotateGameOutput } = await import("../src/shared/diagnostics/GameProcess.ts");

describe("game output decoding", () => {
    it("preserves split UTF-8 characters, indentation, CRLF and the final partial line", () => {
        const lines: string[] = [];
        const reader = outputLines(line => lines.push(line));
        for (const byte of Buffer.from("  café 🎮\r\nloading\rready\ntail")) {
            reader.push(Uint8Array.of(byte));
        }
        assert.deepEqual(lines, ["  café 🎮", "loading", "ready"]);
        reader.flush();
        reader.flush();
        reader.push(Buffer.from("ignored"));
        assert.deepEqual(lines, ["  café 🎮", "loading", "ready", "tail"]);
    });

    it("bounds a stream without newlines without losing its text", () => {
        const lines: string[] = [];
        const text = "x".repeat(100_000);
        const reader = outputLines(line => lines.push(line));
        reader.push(Buffer.from(text));
        reader.flush();
        assert.equal(lines.join(""), text);
        assert.ok(lines.every(line => line.length <= 16_384));
    });
});

describe("detached game output", () => {
    it("streams stdout and stderr before exit, flushes the tail and releases file handles", async () => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), "amethyst-game-output-"));
        const lines: { stream: string; line: string }[] = [];
        const diagnostics: string[] = [];
        let liveOutput!: () => void;
        const live = new Promise<void>(resolve => { liveOutput = resolve; });
        try {
            const run = spawnGameWithOutput(process.execPath, ["-e", `
                process.stdout.write('hello\\n');
                process.stderr.write('warning\\n');
                setTimeout(() => process.stdout.write(Buffer.from([0xf0, 0x9f])), 150);
                setTimeout(() => process.stdout.write(Buffer.from([0x8e, 0xae])), 300);
                setTimeout(() => process.stdout.write(' last'), 500);
            `], {}, {
                directory,
                onLine: (stream, line) => {
                    lines.push({ stream, line });
                    if (line === "hello") liveOutput();
                },
                onDiagnostic: message => diagnostics.push(message),
            });
            const closed = once(run.process, "close");
            await live;
            assert.equal(run.process.exitCode, null);
            await closed;
            await run.outputClosed;
            assert.deepEqual(lines.filter(line => line.stream === "stdout").map(line => line.line), ["hello", "🎮 last"]);
            assert.deepEqual(lines.filter(line => line.stream === "stderr").map(line => line.line), ["warning"]);
            assert.equal(diagnostics.length, 1);
            assert.match(diagnostics[0], /Game output:/);
            const files = await fs.readdir(directory);
            assert.equal(files.length, 3);
            // Windows refuses these deletes if our read handles remain open.
            for (const file of files) await fs.unlink(path.join(directory, file));
        } finally {
            await fs.rm(directory, { recursive: true, force: true });
        }
    });

    it("still launches when the output folder cannot be opened", async () => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), "amethyst-game-output-"));
        const diagnostics: string[] = [];
        try {
            const blocked = path.join(directory, "file");
            await fs.writeFile(blocked, "not a directory");
            const run = spawnGameWithOutput(process.execPath, ["-e", "process.exit(0)"], {}, {
                directory: blocked,
                onLine: () => assert.fail("No output was captured"),
                onDiagnostic: message => diagnostics.push(message),
            });
            const [code] = await once(run.process, "close");
            await run.outputClosed;
            assert.equal(code, 0);
            assert.match(diagnostics[0], /Could not capture game output/);
        } finally {
            await fs.rm(directory, { recursive: true, force: true });
        }
    });

    it("cleans up output readers after an asynchronous spawn failure", async () => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), "amethyst-game-output-"));
        try {
            const run = spawnGameWithOutput(path.join(directory, "missing-game"), [], {}, {
                directory,
                onLine: () => assert.fail("A missing executable cannot produce output"),
                onDiagnostic: () => {},
            });
            const failure = once(run.process, "error");
            const [error] = await failure;
            assert.equal((error as NodeJS.ErrnoException).code, "ENOENT");
            await run.outputClosed;
            for (const file of await fs.readdir(directory)) await fs.unlink(path.join(directory, file));
        } finally {
            await fs.rm(directory, { recursive: true, force: true });
        }
    });

    it("rotates completed captures and keeps files belonging to a live process", async () => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), "amethyst-game-output-"));
        try {
            const run = spawnGameWithOutput(process.execPath, ["-e", "process.exit(0)"], {}, {
                directory, onLine: () => {}, onDiagnostic: () => {},
            });
            const deadPid = run.process.pid!;
            await once(run.process, "close");
            await run.outputClosed;
            for (const file of await fs.readdir(directory)) await fs.unlink(path.join(directory, file));
            for (let i = 0; i < 23; i++) {
                const base = path.join(directory, `game_${1000 + i}_abcdef`);
                await fs.writeFile(base + ".pid", String(i === 0 ? process.pid : deadPid));
                await fs.writeFile(base + ".stdout.log", "output");
                await fs.writeFile(base + ".stderr.log", "error");
            }
            rotateGameOutput(directory);
            const remaining = await fs.readdir(directory);
            assert.equal(remaining.length, 21 * 3);
            assert.ok(remaining.includes("game_1000_abcdef.stdout.log"));
            assert.ok(!remaining.includes("game_1001_abcdef.stdout.log"));
            assert.ok(!remaining.includes("game_1002_abcdef.stdout.log"));
        } finally {
            await fs.rm(directory, { recursive: true, force: true });
        }
    });
});
