import { DEFAULT_LINUX_TOOL_SETTINGS, type LinuxToolSettings } from "../src/shared/linux/LinuxToolSettings.ts";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { rendererBundle } from "./helpers/RendererBundle.ts";

const require = createRequire(import.meta.url);

async function scenario(): Promise<{
    root: string; events: string[];
    plain: import("../src/renderer/src/scripts/backend/tools/SourceToolArtifact.ts").SourceToolArtifact;
    xodus: import("../src/renderer/src/scripts/backend/tools/SourceToolArtifact.ts").SourceToolArtifact;
    freshTool(): import("../src/renderer/src/scripts/backend/tools/SourceToolArtifact.ts").SourceToolArtifact;
    failBuild(value: boolean): void; failService(value: boolean): void;
    settings(value: Partial<LinuxToolSettings>): void;
    latest(value: string): void;
    gate(value: Promise<void>): void; cleanup(): Promise<void>;
}> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "amethyst-verify-"));
    const events: string[] = [];
    let failBuild = false, failService = false;
    let latest = "a".repeat(40);
    let gate: Promise<void> | undefined;
    const executables = { xodus: ["bin/xodus-cli", "bin/xodus-service"] };
    const fixture = {
        root, executables, settings: { ...DEFAULT_LINUX_TOOL_SETTINGS },
        dependencies: async (tools: string[]) => { events.push(`dependencies:${tools.join()}`); },
        revision: async (tool: string) => { events.push(`fetch:${tool}`); return latest; },
        build: async (tool: keyof typeof executables, _revision: string, folder: string) => {
            events.push(`build:${tool}`);
            await gate;
            if (failBuild) throw Error("compiler failed");
            await fs.mkdir(path.join(folder, "bin"), { recursive: true });
            for (const file of executables[tool]) await fs.writeFile(path.join(folder, file), "tool", { mode: 0o755 });
        },
        verify: async (tool: keyof typeof executables, folder: string) => {
            events.push(`verify:${tool}`);
            for (const file of executables[tool]) await fs.access(path.join(folder, file));
        },
        service: async () => { events.push("service:xodus"); if (failService) throw Error("service failed"); },
    };
    const { SourceToolArtifact } = await rendererBundle("src/renderer/src/scripts/backend/tools/SourceToolArtifact.ts", {
        "@shared/linux/LinuxBuild": `export const LINUX_SOURCES={xodus:{repository:'test/xodus',executables:fixture.executables.xodus}};export const sourceRevision=(...args)=>fixture.revision(...args);export const buildSource=(...args)=>fixture.build(...args);export const verifySource=(...args)=>fixture.verify(...args);`,
        "./LinuxToolDependencies": "export const ensureLinuxDependencies=(...args)=>fixture.dependencies(...args);",
        "@renderer/scripts/LauncherLog": "export const log=()=>{};",
        "@renderer/states/AppStore": "export const useAppStore={getState:()=>({linuxToolSettings:fixture.settings,platform:{getPaths:()=>({toolsPath:fixture.root})}})};",
        "@renderer/states/ProgressBarStore": "export const ProgressBar={runAsync:f=>f({setStatus:()=>{},setMessage:()=>{},setProgress:()=>{}})};",
        "@renderer/popups/ToolUpdatePopup": "export const askToolUpdate=async()=>true;",
        "../Downloader": "export const Downloader={};",
        "../Extractor": "export const Extractor={};",
        "../github/GithubTools": "export const GithubTools={};",
    }, fixture, { require, process: { platform: "linux", arch: "x64" } }) as typeof import("../src/renderer/src/scripts/backend/tools/SourceToolArtifact.ts");
    class XodusFixture extends SourceToolArtifact {
        constructor() { super("xodus"); }
        protected async afterVerification(): Promise<void> { await fixture.service(); }
    }
    return { root, events, plain: new SourceToolArtifact("xodus"), xodus: new XodusFixture(),
        freshTool: () => new SourceToolArtifact("xodus"),
        failBuild: (value: boolean) => { failBuild = value; }, failService: (value: boolean) => { failService = value; },
        settings: value => { Object.assign(fixture.settings, value); },
        latest: (value: string) => { latest = value; },
        gate: (value: Promise<void>) => { gate = value; },
        cleanup: () => fs.rm(root, { recursive: true, force: true }),
    };
}

it("builds missing tools separately, shares concurrent verification, and persists success across restarts", async () => {
    const app = await scenario();
    let release!: () => void;
    app.gate(new Promise<void>(resolve => { release = resolve; }));
    try {
        const first = app.plain.ensureVerified();
        assert.equal(app.plain.ensureVerified(), first);
        release();
        await first;
        assert.equal(app.events.filter(e => e === "build:xodus").length, 1);
        const count = app.events.length;
        await app.freshTool().ensureVerified();
        assert.equal(app.events.length, count, "saved verification skips setup in a new instance");
        await app.plain.ensureVerified(true);
        assert.equal(app.events.at(-1), "verify:xodus");
        assert.equal(app.events.filter(e => e === "build:xodus").length, 1, "manual verification reuses a healthy build");
        await app.xodus.ensureVerified(true);
        assert.equal(app.events.at(-1), "service:xodus");
        const services = app.events.filter(e => e === "service:xodus").length;
        await app.xodus.ensureVerified();
        assert.equal(app.events.filter(e => e === "service:xodus").length, services, "verified Xodus is not restarted by every action");
    } finally { release(); await app.cleanup(); }
});

it("does not mark build or service failures verified and allows retry", async () => {
    const app = await scenario();
    try {
        app.failBuild(true);
        await assert.rejects(app.plain.ensureVerified(), /compiler failed/);
        await assert.rejects(fs.access(path.join(app.plain.getFolder(), ".amethyst-verified.json")));
        app.failBuild(false);
        await app.plain.ensureVerified();
        app.failService(true);
        await assert.rejects(app.xodus.ensureVerified(true), /service failed/);
        await assert.rejects(fs.access(path.join(app.xodus.getFolder(), ".amethyst-verified.json")));
        app.failService(false);
        await app.xodus.ensureVerified();
        assert.equal(app.events.filter(e => e === "build:xodus").length, 2, "service retry does not rebuild a healthy binary");
    } finally { await app.cleanup(); }
});

it("rechecks changed revisions and rebuilds tools whose executables were deleted", async () => {
    const app = await scenario();
    try {
        await app.plain.ensureVerified();
        await fs.writeFile(app.plain.getVersionFile(), "b".repeat(40));
        const count = app.events.length;
        assert.equal(await app.plain.ensureVerified(), "b".repeat(40));
        assert.equal(app.events.length, count + 1);
        await fs.rm(app.plain.getExecutable());
        await app.plain.ensureVerified();
        assert.equal(app.events.filter(e => e === "build:xodus").length, 2);
    } finally { await app.cleanup(); }
});

it("explicit verification builds a newer source revision even when the installed build was verified", async () => {
    const app = await scenario();
    try {
        await app.plain.ensureVerified();
        app.latest("c".repeat(40));
        assert.equal(await app.plain.ensureVerified(), "a".repeat(40));
        assert.equal(await app.plain.ensureVerified(true), "c".repeat(40));
        assert.equal(app.events.filter(e => e === "build:xodus").length, 2);
        assert.equal(await app.freshTool().ensureVerified(), "c".repeat(40));
    } finally { await app.cleanup(); }
});

it("Settings verification selects only the requested tool", async () => {
    const calls: string[] = [];
    const fixture = {
        verify: async (force: boolean) => { assert.equal(force, true); calls.push("xodus"); return "revision"; },
        check: async (tool: string, options: unknown) => {
            assert.deepEqual(options, { checkForUpdates: true, promptForUpdate: false, allowOutdated: false });
            calls.push(tool);
            return { version: "v1" };
        },
    };
    const { prepareLinuxTool } = await rendererBundle("src/renderer/src/flows/LinuxToolsSetup.ts", {
        "@renderer/scripts/backend/tools/LauncherTools": "export const LauncherTools={Xodus:{ensureVerified:f=>fixture.verify(f)},GDKProton:{check:o=>fixture.check('GDKProton',o)},UMULauncher:{check:o=>fixture.check('UMULauncher',o)}};",
    }, fixture) as typeof import("../src/renderer/src/flows/LinuxToolsSetup.ts");
    for (const tool of ["GDKProton", "UMULauncher", "xodus"] as const) {
        calls.length = 0;
        await prepareLinuxTool(tool);
        assert.deepEqual(calls, [tool]);
    }
});

it("rebuilds Xodus when its upstream changes, even at the same revision", async () => {
    const app = await scenario();
    try {
        await app.plain.ensureVerified();
        app.events.length = 0;
        app.settings({ xodusUpstream: "example/xodus" });
        await app.plain.ensureVerified();
        assert.equal(app.events.filter(e => e === "build:xodus").length, 1);
        app.events.length = 0;
        await app.freshTool().ensureVerified();
        assert.deepEqual(app.events, [], "custom build settings survive restarts");
    } finally { await app.cleanup(); }
});
