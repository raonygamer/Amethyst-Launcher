import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { packageInstallCommand, selectPackageManager, shellQuote } from "../src/shared/linux/LinuxDependencies.ts";
import type { ProcessResult } from "../src/shared/diagnostics/ProcessRunner.ts";

(globalThis as unknown as { require: NodeRequire }).require = createRequire(import.meta.url);
const { checked, buildSource, sourceRevision, verifySource, installDependencies, findExecutable } = await import("../src/shared/linux/LinuxBuild.ts");

function result(stdout = "", code = 0): ProcessResult {
    return { command: "test", args: [], loggableArgs: [], code, stdout, stderr: "", output: stdout, durationMs: 0, timedOut: false };
}

describe("Linux dependency planning", () => {
    it("prefers the native manager and recognises derivative distros", () => {
        assert.equal(selectPackageManager('ID=ubuntu\nID_LIKE="debian"', ["dnf", "apt-get"]), "apt-get");
        assert.equal(selectPackageManager('ID=custom\nID_LIKE="arch"', ["pacman", "apt-get"]), "pacman");
        assert.equal(selectPackageManager("ID=fedora", ["dnf", "pacman"]), "dnf");
        assert.equal(selectPackageManager("ID=nixos", []), null);
        assert.equal(selectPackageManager("ID=custom", ["dnf", "pacman"]), null);
    });

    it("deduplicates packages and does not refresh or upgrade Arch during install", () => {
        assert.deepEqual(packageInstallCommand("pacman", ["wayland", "wayland"]), {
            command: "pacman", args: ["-S", "--needed", "--noconfirm", "wayland"],
        });
        assert.deepEqual(packageInstallCommand("apt-get", ["libx11-dev"]), {
            command: "apt-get", args: ["install", "-y", "libx11-dev"],
        });
    });

    it("quotes shell metacharacters and apostrophes as literal arguments", () => {
        assert.equal(shellQuote("/tmp/a b;$(echo bad)"), "'/tmp/a b;$(echo bad)'");
        assert.equal(shellQuote("a'b"), `'a'"'"'b'`);
    });

    it("honours a cancelled administrator prompt without trying another prompt", { skip: process.platform !== "linux" || process.getuid?.() === 0 || !findExecutable("pkexec") || !findExecutable("pacman") }, async () => {
        const calls: string[] = [];
        await assert.rejects(installDependencies(packageInstallCommand("pacman", ["git"]), () => {}, async command => {
            calls.push(command);
            return result("Dismissed", 126);
        }), /cancelled or denied/);
        assert.equal(calls.length, 1);
        assert.ok(calls[0].endsWith("pkexec"));
    });
});

describe("Linux source builds", () => {
    it("rejects process errors and timeouts even with a zero exit code", async () => {
        await assert.rejects(checked("cargo", [], {}, async () => result("compile failure", 1)), /compile failure/);
        await assert.rejects(checked("cargo", [], {}, async () => ({ ...result(), timedOut: true })), /timed out/);
        await assert.rejects(checked("cargo", [], {}, async () => ({ ...result(), spawnError: "missing compiler" })), /missing compiler/);
    });

    it("tracks full Git revisions and rejects empty remote refs", async () => {
        const revision = "a".repeat(40);
        assert.equal(await sourceRevision("xodus", 5000, async () => result(`${revision}\trefs/heads/main\n`)), revision);
        await assert.rejects(sourceRevision("xodus", 5000, async () => result()), /no valid/);
    });

    it("builds both Xodus binaries with nproc and retains its source and Cargo artifacts", async () => {
        const folder = await fs.mkdtemp(path.join(os.tmpdir(), "linux-build-test-"));
        const calls: { command: string; args: string[] }[] = [];
        try {
            await buildSource("xodus", "a".repeat(40), path.join(folder, "stage"), path.join(folder, "installed"), () => {}, () => {}, async (command, args, options) => {
                calls.push({ command, args });
                if (command === "nproc") return result("32\n");
                const cwd = options!.cwd!;
                if (command === "git" && args[0] === "checkout") await fs.writeFile(path.join(cwd, "Cargo.toml"), 'rust-version = "1.98.0"');
                if (command === "rustc") return result("rustc 1.98.1");
                if (command === "cargo") {
                    await fs.mkdir(path.join(cwd, "target/release"), { recursive: true });
                    for (const name of ["xodus-cli", "xodus-service"]) await fs.writeFile(path.join(cwd, "target/release", name), name);
                }
                return result();
            });
            assert.match(await fs.readFile(path.join(folder, "stage/bin/xodus-service"), "utf8"), /xodus-service/);
            assert.ok(calls.find(call => call.command === "cargo")!.args.includes("--locked"));
            assert.deepEqual(calls.find(call => call.command === "cargo")!.args.slice(-2), ["--jobs", "32"]);
            await fs.access(path.join(folder, "installed.build/source/Cargo.toml"));
            await fs.access(path.join(folder, "installed.build/source/target/release/xodus-service"));
        } finally { await fs.rm(folder, { recursive: true, force: true }); }
    });

    it("retains Git edits and Cargo objects after failure and reuses them on retry", async () => {
        const { run } = await import("../src/shared/diagnostics/ProcessRunner.ts");
        const folder = await fs.mkdtemp(path.join(os.tmpdir(), "xodus-retry-build-"));
        const upstream = path.join(folder, "upstream");
        const installation = path.join(folder, "xodus");
        const staging = `${installation}.staging`;
        const workspace = `${installation}.build`;
        const checkout = path.join(workspace, "source");
        let fail = true;
        try {
            await fs.mkdir(upstream);
            await checked("git", ["init", "--quiet"], { cwd: upstream });
            await fs.writeFile(path.join(upstream, "source.c"), "original\n");
            await fs.writeFile(path.join(upstream, "Cargo.toml"), 'rust-version = "1.98.0"');
            await checked("git", ["add", "source.c", "Cargo.toml"], { cwd: upstream });
            await checked("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--no-gpg-sign", "-m", "fixture"], { cwd: upstream });
            await checked("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--no-gpg-sign", "--allow-empty", "-m", "next revision"], { cwd: upstream });
            const revision = (await checked("git", ["rev-parse", "HEAD"], { cwd: upstream })).stdout.trim();
            const { DEFAULT_LINUX_TOOL_SETTINGS } = await import("../src/shared/linux/LinuxToolSettings.ts");
            const settings = { ...DEFAULT_LINUX_TOOL_SETTINGS, xodusUpstream: upstream };
            const execute: import("../src/shared/linux/LinuxBuild.ts").Execute = async (command, args, options) => {
                if (command === "git") return run(command, args, options);
                if (command === "nproc") return result("24\n");
                if (command === "rustc") return result("rustc 1.98.1");
                if (command === "cargo") {
                    assert.deepEqual(args.slice(-2), ["--jobs", "24"]);
                    const target = path.join(options!.cwd!, "target/release");
                    await fs.mkdir(target, { recursive: true });
                    const object = path.join(target, "compiled.o");
                    if (fail) { await fs.writeFile(object, "compiled work"); return result("compiler failed", 1); }
                    assert.equal(await fs.readFile(object, "utf8"), "compiled work");
                    for (const name of ["xodus-cli", "xodus-service"]) await fs.writeFile(path.join(target, name), name);
                }
                return result();
            };
            const build = (): Promise<void> => buildSource("xodus", revision, staging, installation, () => {}, () => {}, execute, settings);
            await assert.rejects(build(), /compiler failed/);
            // ToolArtifact removes failed installations, while the build cache stays outside staging.
            await fs.rm(staging, { recursive: true, force: true });
            await fs.writeFile(path.join(checkout, "source.c"), "edited for debugging\n");
            fail = false;
            await build();
            await fs.access(path.join(staging, "bin/xodus-cli"));
            await fs.access(path.join(workspace, "source/target/release/compiled.o"));
            await checked("git", ["rev-parse", "--verify", "HEAD^"], { cwd: checkout });
            const diff = await checked("git", ["diff", "--", "source.c"], { cwd: checkout });
            assert.match(diff.stdout, /edited for debugging/);
            assert.equal((await checked("git", ["rev-parse", "HEAD"], { cwd: checkout })).stdout.trim(), revision);
        } finally { await fs.rm(folder, { recursive: true, force: true }); }
    });

    it("checks the service's linkage without launching its credential and socket setup", async () => {
        const folder = await fs.mkdtemp(path.join(os.tmpdir(), "xodus-verify-test-"));
        const calls: string[] = [];
        try {
            await fs.mkdir(path.join(folder, "bin"));
            for (const name of ["xodus-cli", "xodus-service"]) await fs.writeFile(path.join(folder, "bin", name), name, { mode: 0o755 });
            await verifySource("xodus", folder, async command => { calls.push(command); return result("linked"); });
            assert.ok(calls.includes(path.join(folder, "bin/xodus-cli")));
            assert.ok(!calls.includes(path.join(folder, "bin/xodus-service")));
            await assert.rejects(verifySource("xodus", folder, async () => result("libwebkit.so => not found")), /missing runtime libraries/);
        } finally { await fs.rm(folder, { recursive: true, force: true }); }
    });
});
