import { outputLines } from "./OutputLines.ts";

const nodeRequire = (globalThis as unknown as { require: NodeRequire }).require;
const child = nodeRequire("child_process") as typeof import("child_process");
const fs = nodeRequire("fs") as typeof import("fs");
const path = nodeRequire("path") as typeof import("path");
const { randomUUID } = nodeRequire("crypto") as typeof import("crypto");
const { setTimeout, clearTimeout } = nodeRequire("timers") as typeof import("timers");

type OutputStream = "stdout" | "stderr";

export interface GameOutput {
    directory: string;
    onLine: (stream: OutputStream, line: string) => void;
    onDiagnostic: (message: string) => void;
}

export interface LoggedGameProcess {
    process: import("child_process").ChildProcess;
    /** Settles once the last output has been read and the capture handles are closed. */
    outputClosed: Promise<void>;
}

const KEEP_CAPTURES = 20;
const READ_BYTES = 64 * 1024;
const READS_PER_POLL = 4;

/** Never prune a capture whose game may still be using its descriptors. */
export function rotateGameOutput(directory: string): void {
    const names = fs.readdirSync(directory)
        .filter(name => /^game_\d+_[\da-f-]+\.pid$/.test(name))
        .sort().reverse();
    for (const marker of names.slice(KEEP_CAPTURES)) {
        const base = path.join(directory, marker.slice(0, -4));
        try {
            const pid = Number(fs.readFileSync(base + ".pid", "utf8"));
            if (!Number.isInteger(pid) || pid <= 0) continue;
            try {
                process.kill(pid, 0);
                continue;
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ESRCH") continue;
            }
            for (const suffix of [".stdout.log", ".stderr.log", ".pid"]) {
                fs.rmSync(base + suffix, { force: true });
            }
        } catch {
            // A stale or unreadable marker is not permission to remove an active game's log.
        }
    }
}

/**
 * Give the detached game real files, then tail them while the launcher is alive. Pipes would
 * disappear when keepLauncherOpen is off and could break a game that writes after that point.
 */
export function spawnGameWithOutput(
    command: string,
    args: string[],
    options: { cwd?: string; env?: NodeJS.ProcessEnv },
    output: GameOutput,
): LoggedGameProcess {
    const descriptors: number[] = [];
    const base = path.join(output.directory, `game_${Date.now()}_${randomUUID()}`);
    let proc: import("child_process").ChildProcess;
    try {
        fs.mkdirSync(output.directory, { recursive: true });
        rotateGameOutput(output.directory);
        descriptors.push(fs.openSync(base + ".stdout.log", "ax+", 0o600));
        descriptors.push(fs.openSync(base + ".stderr.log", "ax+", 0o600));
    } catch (error) {
        for (const [index, descriptor] of descriptors.entries()) {
            fs.closeSync(descriptor);
            fs.rmSync(base + (index === 0 ? ".stdout.log" : ".stderr.log"), { force: true });
        }
        output.onDiagnostic(`Could not capture game output: ${String(error)}`);
        return {
            process: child.spawn(command, args, { ...options, detached: true, stdio: "ignore" }),
            outputClosed: Promise.resolve(),
        };
    }

    try {
        proc = child.spawn(command, args, { ...options, detached: true, stdio: ["ignore", ...descriptors] });
    } catch (error) {
        for (const descriptor of descriptors) fs.closeSync(descriptor);
        for (const suffix of [".stdout.log", ".stderr.log"]) fs.rmSync(base + suffix, { force: true });
        throw error;
    }

    if (proc.pid) {
        try {
            fs.writeFileSync(base + ".pid", String(proc.pid), { mode: 0o600, flag: "wx" });
        } catch (error) {
            output.onDiagnostic(`Could not record the game log owner: ${String(error)}`);
        }
    }
    output.onDiagnostic(`Game output: ${base}.stdout.log and ${base}.stderr.log`);

    let finished = false;
    let reading = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settle!: () => void;
    const outputClosed = new Promise<void>(resolve => { settle = resolve; });
    const streams = descriptors.map((fd, index) => ({
        fd, offset: 0, closed: false,
        lines: outputLines(line => output.onLine(index === 0 ? "stdout" : "stderr", line)),
    }));

    const close = (stream: typeof streams[number]): void => {
        if (stream.closed) return;
        stream.closed = true;
        stream.lines.flush();
        fs.closeSync(stream.fd);
    };

    const poll = async (): Promise<void> => {
        if (reading) return;
        reading = true;
        try {
            await Promise.all(streams.map(async stream => {
                if (stream.closed) return;
                try {
                    const buffer = Buffer.allocUnsafe(READ_BYTES);
                    for (let i = 0; i < READS_PER_POLL; i++) {
                        const count = await new Promise<number>((resolve, reject) => {
                            fs.read(stream.fd, buffer, 0, buffer.length, stream.offset, (error, bytesRead) => {
                                if (error) reject(error);
                                else resolve(bytesRead);
                            });
                        });
                        if (count === 0) {
                            if (finished) close(stream);
                            break;
                        }
                        stream.offset += count;
                        stream.lines.push(buffer.subarray(0, count));
                    }
                } catch (error) {
                    output.onDiagnostic(`Could not read game output: ${String(error)}`);
                    close(stream);
                }
            }));
        } finally {
            reading = false;
        }
        if (streams.every(stream => stream.closed)) {
            settle();
        } else {
            timer = setTimeout(() => { void poll(); }, finished ? 0 : 100);
            if (!finished) timer.unref();
        }
    };

    proc.once("close", () => {
        finished = true;
        if (timer) clearTimeout(timer);
        void poll();
    });
    void poll();
    return { process: proc, outputClosed };
}
