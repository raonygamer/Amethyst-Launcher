import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { build } from "esbuild";
import type { GithubAsset } from "../src/renderer/src/scripts/backend/github/GithubAsset.ts";
import type { GithubRelease } from "../src/renderer/src/scripts/backend/github/GithubRelease.ts";
import type { ToolCandidate } from "../src/renderer/src/scripts/backend/tools/ToolArtifact.ts";

const require = createRequire(import.meta.url);
(globalThis as unknown as { window: unknown }).window = { require, process };
const root = path.resolve(import.meta.dirname, "..");
// Compile the actual lifecycle with only its UI/network dependencies replaced.
const compiled = await build({
    entryPoints: [path.join(root, "src/renderer/src/scripts/backend/tools/ToolArtifact.ts")],
    bundle: true, platform: "node", format: "cjs", write: false,
    plugins: [{ name: "tool-test-environment", setup(builder) {
        builder.onResolve({ filter: /LauncherLog|AppStore|ProgressBarStore|ToolUpdatePopup|Downloader|Extractor|GithubTools/ }, args => ({ path: args.path, namespace: "test-stub" }));
        builder.onLoad({ filter: /.*/, namespace: "test-stub" }, () => ({ contents: `
            export const log = () => {};
            export const useAppStore = { getState() { throw Error("tools root must be overridden"); } };
            export const ProgressBar = { async runAsync(callback) { await callback({ setStatus() {}, setMessage() {}, setProgress() {} }); } };
            export const askToolUpdate = async () => true;
            export const Downloader = {};
            export const Extractor = {};
            export const GithubTools = { async getLatestRelease() { throw Error("unexpected network request"); } };
        ` }));
        builder.onResolve({ filter: /^@renderer\// }, args => ({ path: path.join(root, "src/renderer/src", args.path.slice("@renderer/".length) + ".ts") }));
        builder.onResolve({ filter: /^@shared\// }, args => ({ path: path.join(root, "src/shared", args.path.slice("@shared/".length) + ".ts") }));
    } }],
});
const module = { exports: {} };
new Function("require", "module", "exports", compiled.outputFiles[0].text)(require, module, module.exports);
const { ToolArtifact, ArchiveToolArtifact } = module.exports as typeof import("../src/renderer/src/scripts/backend/tools/ToolArtifact.ts");

class SourceFixture extends ToolArtifact {
    revision = "commit-one";
    builds = 0;
    lookups = 0;
    failLookup = false;
    fail = false;
    missing = false;
    root: string;
    constructor(root: string) { super("source-fixture", "test/source"); this.root = root; }
    isSupported(): boolean { return true; }
    protected getToolsPath(): string { return this.root; }
    protected getFolderName(): string { return this.name; }
    protected getExecutableName(): string { return "bin/tool"; }
    protected compareTags(current: string | null, latest: string): number { return current === latest ? 0 : -1; }
    protected async resolveLatest(): Promise<ToolCandidate> {
        this.lookups++;
        if (this.failLookup) throw new Error("remote unavailable");
        return { version: this.revision };
    }
    protected async stageInstall(candidate: ToolCandidate, destination: string): Promise<void> {
        this.builds++;
        await fs.mkdir(path.join(destination, "bin"), { recursive: true });
        if (!this.missing) await fs.writeFile(path.join(destination, "bin/tool"), candidate.version);
        if (this.fail) throw new Error("compiler failed");
    }
}

class ArchiveFixture extends ArchiveToolArtifact {
    root: string;
    downloaded: string | null = null;
    constructor(root: string) {
        super({ name: "archive-fixture", repository: "test/archive", executableName: "tool", platforms: [process.platform] });
        this.root = root;
    }
    protected getToolsPath(): string { return this.root; }
    protected async fetchLatestRelease(): Promise<GithubRelease> {
        return { tagName: "release-one", assets: [
            { name: "checksums.txt", downloadUrl: "unused", size: 0 },
            { name: "tool.tar.gz", downloadUrl: "unused", size: 0 },
            { name: "tool.zip", downloadUrl: "unused", size: 0 },
        ] };
    }
    protected async download(asset: GithubAsset, destination: string): Promise<void> {
        this.downloaded = asset.name;
        await fs.writeFile(destination, "archive");
    }
    protected async extract(archive: string, destination: string): Promise<void> {
        await fs.mkdir(destination, { recursive: true });
        await fs.writeFile(path.join(destination, "tool"), "released tool");
        await fs.rm(archive);
    }
}

describe("shared source and release tool lifecycle", () => {
    it("serialises installation and reuses a cached source revision", async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "tool-lifecycle-"));
        try {
            const tool = new SourceFixture(root);
            const results = await Promise.all([tool.check(), tool.check()]);
            assert.equal(results[0].action, "installed");
            assert.equal(results[1].action, "up_to_date");
            assert.equal(tool.builds, 1);
            assert.equal(tool.lookups, 1);
            assert.equal(await fs.readFile(tool.getVersionFile(), "utf8"), "commit-one");
        } finally { await fs.rm(root, { recursive: true, force: true }); }
    });

    it("preserves the working executable and revision when a source update fails", async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "tool-rollback-"));
        try {
            const tool = new SourceFixture(root);
            await tool.check();
            tool.revision = "commit-two";
            tool.fail = true;
            await assert.rejects(tool.check({ checkForUpdates: true, allowOutdated: false }), /compiler failed/);
            assert.equal(await fs.readFile(tool.getExecutable(), "utf8"), "commit-one");
            assert.equal(await fs.readFile(tool.getVersionFile(), "utf8"), "commit-one");
            await assert.rejects(fs.stat(tool.getFolder() + ".staging"), { code: "ENOENT" });
            const fallback = await tool.check({ checkForUpdates: true, allowOutdated: true });
            assert.equal(fallback.version, "commit-one");
        } finally { await fs.rm(root, { recursive: true, force: true }); }
    });

    it("fetches and rebuilds an installed revision when forced, regardless of update checking", async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "tool-rebuild-"));
        try {
            const tool = new SourceFixture(root);
            await tool.check();
            for (const checkForUpdates of [false, true]) {
                const before = tool.builds;
                const rebuilt = await tool.check({ forceInstall: true, checkForUpdates });
                assert.equal(rebuilt.action, "updated");
                assert.equal(rebuilt.version, "commit-one");
                assert.equal(tool.builds, before + 1);
                assert.equal(tool.lookups, tool.builds);
            }
            await tool.check({ checkForUpdates: true });
            assert.equal(tool.builds, 3, "ordinary update checks can still reuse the installed revision");
        } finally { await fs.rm(root, { recursive: true, force: true }); }
    });

    it("reports forced rebuild and fetch failures while preserving the previous installation", async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "tool-rebuild-failure-"));
        try {
            const tool = new SourceFixture(root);
            await tool.check();
            tool.fail = true;
            await assert.rejects(tool.check({ forceInstall: true }), /compiler failed/);
            tool.failLookup = true;
            await assert.rejects(tool.check({ forceInstall: true }), /remote unavailable/);
            assert.equal(await fs.readFile(tool.getExecutable(), "utf8"), "commit-one");
            assert.equal(await fs.readFile(tool.getVersionFile(), "utf8"), "commit-one");
            await assert.rejects(fs.stat(tool.getFolder() + ".staging"), { code: "ENOENT" });
        } finally { await fs.rm(root, { recursive: true, force: true }); }
    });

    it("refuses to publish a staged install without its executable", async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "tool-missing-"));
        try {
            const tool = new SourceFixture(root);
            tool.missing = true;
            await assert.rejects(tool.check(), /missing/);
            await assert.rejects(fs.stat(tool.getVersionFile()), { code: "ENOENT" });
        } finally { await fs.rm(root, { recursive: true, force: true }); }
    });

    it("retains archive selection and download/extraction hooks for existing release tools", async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "tool-archive-"));
        try {
            const tool = new ArchiveFixture(root);
            const installation = await tool.check();
            assert.equal(installation.version, "release-one");
            assert.equal(tool.downloaded, "tool.zip");
            assert.equal(await fs.readFile(installation.executable, "utf8"), "released tool");
        } finally { await fs.rm(root, { recursive: true, force: true }); }
    });
});
