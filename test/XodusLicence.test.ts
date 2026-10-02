import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { it } from "node:test";
import type { Execute } from "../src/shared/linux/LinuxBuild.ts";
import { rendererBundle } from "./helpers/RendererBundle.ts";
import { SemVersion } from "../src/renderer/src/scripts/classes/SemVersion.ts";
import type { LauncherPaths } from "../src/renderer/src/scripts/platform/LauncherPlatform.ts";

(globalThis as unknown as { require: NodeRequire }).require = createRequire(import.meta.url);
const { acquireXodusCiks, acquireXodusContentCiks, readXvdContentId } = await import("../src/shared/linux/XodusLicence.ts");
const contentId = "12345678-1234-5678-9abc-def012345678";
const keyId = "87654321-4321-8765-abcd-0123456789ab";
const contentBytes = Buffer.from("78563412341278569abcdef012345678", "hex");
const keyIdBytes = Buffer.from("2143658721436587abcd0123456789ab", "hex");
const key = Buffer.alloc(32, 0x5a);
const cikRecord = Buffer.concat([keyIdBytes, key]).toString("hex");

async function archiveFixture(): Promise<{ root: string; archive: string }> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "amethyst-licence-test-"));
    const archive = path.join(root, "game.msixvc");
    const header = Buffer.alloc(0x230);
    header.write("msft-xvd", 0x200);
    contentBytes.copy(header, 0x220);
    await fs.writeFile(archive, header);
    return { root, archive };
}

it("requests the archive content licence, decodes binary CIKs and deletes the private key directory", async () => {
    const { root, archive } = await archiveFixture();
    const folders: string[] = [];
    const execute: Execute = async (command, args, options) => {
        assert.equal(command, "/tools/xodus-cli");
        assert.deepEqual(args.slice(0, 2), ["license", contentId]);
        assert.equal(options?.env?.HOME, undefined);
        assert.equal(options?.env?.XDG_RUNTIME_DIR, undefined);
        assert.equal(options?.env?.HOME, undefined);
        assert.equal(options?.onLine, undefined, "licence output must not be streamed to the console");
        assert.equal((await fs.stat(args[2])).mode & 0o777, 0o700);
        folders.push(args[2]);
        await fs.writeFile(path.join(args[2], `${keyId}.cik`), Buffer.concat([keyIdBytes, key]));
        return { command, args, loggableArgs: args, code: 0, timedOut: false, durationMs: 1,
            stdout: "private output", stderr: "", output: "private output" };
    };
    try {
        assert.equal(await readXvdContentId(archive), contentId);
        const keys = await Promise.all([acquireXodusCiks("/tools/xodus-cli", archive, "/data", execute),
            acquireXodusCiks("/tools/xodus-cli", archive, "/data", execute)]);
        assert.deepEqual(keys, [{ [keyId]: cikRecord }, { [keyId]: cikRecord }]);
        assert.notEqual(folders[0], folders[1], "concurrent requests use separate directories");
        for (const folder of folders) await assert.rejects(fs.access(folder));
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it("rejects bad headers, failed licences and invalid or absent keys without leaking CLI output", async () => {
    const { root, archive } = await archiveFixture();
    try {
        for (const failure of ["exit", "timeout", "empty", "short", "mismatch"] as const) {
            let folder = "";
            const execute: Execute = async (command, args) => {
                folder = args[2];
                if (failure === "short") await fs.writeFile(path.join(folder, `${keyId}.cik`), key);
                if (failure === "mismatch") await fs.writeFile(path.join(folder, `${keyId}.cik`), Buffer.concat([contentBytes, key]));
                return { command, args, loggableArgs: args, code: failure === "exit" ? 1 : 0,
                    timedOut: failure === "timeout", durationMs: 1, stdout: "secret-token", stderr: "secret-token", output: "secret-token" };
            };
            await assert.rejects(acquireXodusCiks("/tools/xodus-cli", archive, "/data", execute), error => {
                assert(error instanceof Error);
                assert(!error.message.includes("secret-token"));
                return true;
            });
            await assert.rejects(fs.access(folder));
        }
        await fs.writeFile(archive, "invalid");
        await assert.rejects(readXvdContentId(archive), /invalid XVD header/);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it("requires a fresh Linux login, never falls back to Windows keys, and preserves Windows downloads", async () => {
    let snapshot: { service: string; session: string } | null = null;
    let refreshes = 0, requests = 0, failLicence = false, failVerification = false;
    let verifications = 0;
    const fixture = {
        verify: async () => { verifications++; if (failVerification) throw Error("Tool verification failed"); },
        account: () => ({ snapshot, refresh: async () => { refreshes++; } }),
        licence: async (archive: string, data: string) => {
            assert.equal(archive, "/game.msixvc"); assert.equal(data, "/data"); requests++;
            if (failLicence) throw Error("No entitlement");
            return { licensed: "test-key" };
        },
    };
    const testWindow = { process: { platform: "linux" } };
    const { requireDownloadAccount, gameLicenceKeys } = await rendererBundle("src/renderer/src/scripts/backend/Decryption.ts", {
        "@renderer/states/XodusAccountStore": "export const useXodusAccountStore={getState:()=>fixture.account()};",
        "./tools/LauncherTools": "export const LauncherTools={Xodus:{ensureVerified:()=>fixture.verify(),licenceKeys:(...args)=>fixture.licence(...args)}};",
        "./WindowsDecryption": "export const CIK_KEYS={windows:'test-key'};",
    }, fixture, testWindow) as typeof import("../src/renderer/src/scripts/backend/Decryption.ts");
    for (const state of [null, { service: "disconnected", session: "unavailable" }, { service: "connected", session: "unavailable" }]) {
        snapshot = state;
        await assert.rejects(requireDownloadAccount(), /Sign in with Xodus/);
        await assert.rejects(gameLicenceKeys("/game.msixvc", "/data"), /Sign in with Xodus/);
    }
    assert.equal(requests, 0);
    snapshot = { service: "connected", session: "signed_in" };
    failVerification = true;
    const beforeFailure = refreshes;
    await assert.rejects(requireDownloadAccount(), /Tool verification failed/);
    assert.equal(refreshes, beforeFailure, "verification must finish before account lookup");
    failVerification = false;
    await requireDownloadAccount();
    assert.deepEqual(await gameLicenceKeys("/game.msixvc", "/data"), { licensed: "test-key" });
    failLicence = true;
    await assert.rejects(gameLicenceKeys("/game.msixvc", "/data"), /No entitlement/);
    testWindow.process.platform = "win32";
    const before = refreshes;
    const verifiedBefore = verifications;
    await requireDownloadAccount();
    assert.deepEqual(await gameLicenceKeys("/game.msixvc", "/data"), { windows: "test-key" });
    assert.equal(refreshes, before);
    assert.equal(verifications, verifiedBefore, "Windows must not prepare Xodus");
});

it("blocks downloads and imports before copying bytes, and obtains licence keys before marking an archive for decryption", async () => {
    const { root, archive } = await archiveFixture();
    let licenceFails = true, accountFails = true, headCalls = 0, decrypts = 0;
    let decryptFailure: "" | "unchanged" | "modified" = "";
    const fixture = {
        account: async () => { if (accountFails) throw Error("Sign in first"); },
        keys: async () => { if (licenceFails) throw Error("No licence"); return { [keyId]: cikRecord }; },
        decrypt: async (file: string, keys: Record<string, string>) => {
            assert.equal(file, archive);
            assert.deepEqual(keys, { [keyId]: cikRecord });
            await fs.access(`${archive}.decrypting`);
            decrypts++;
            if (decryptFailure === "modified") await fs.appendFile(file, "partial decryption");
            if (decryptFailure) throw Error("Tool failed");
        },
    };
    const nodeRequire = createRequire(import.meta.url);
    try {
        const { VersionService } = await rendererBundle("src/renderer/src/scripts/versions/VersionService.ts", {
            "./Catalog": "export class Catalog {}; export const catalogLabel=()=> 'test';",
            "./Library": "export class Library {byUuid(){return null}};",
            "@renderer/scripts/LauncherLog": "export const log=()=>{};",
            "@renderer/scripts/Directories": "export const errnoCode=e=>e.code;",
            "@renderer/scripts/FileLocker": "export const FileLocker={get:()=>({isLocked:()=>false,lockFile:()=>{},unlockFile:()=>{}})};",
            "@renderer/scripts/backend/Decryption": "export const requireDownloadAccount=()=>fixture.account();export const requireDownloadLicence=()=>fixture.keys();export const gameLicenceKeys=()=>fixture.keys();",
            "@renderer/scripts/backend/Downloader": "export const Downloader={};export const PART_SUFFIX='.part';",
            "@renderer/scripts/backend/tools/LauncherTools": "export const LauncherTools={XVDTool:{check:async()=>{},decryptFile:(...args)=>fixture.decrypt(...args),extractFile:async()=>null}};",
            "@renderer/states/ProgressBarStore": "export const ProgressBar={runAsync:f=>f({setStatus:()=>{},setMessage:()=>{},setProgress:()=>{}})};export const FULL_PROGRESS_RESET_OPTIONS={};",
            "@renderer/states/DownloadStore": "export const useDownloadStore={};export const addPendingDownload=()=>{};export const removePendingDownload=()=>{};",
        }, fixture, { process: { platform: "linux" }, require: (name: string) => name === "electron" ? { ipcRenderer: { invoke: async () => { headCalls++; return { ok: true, status: 200, contentLength: 560, error: null, ms: 1 }; } } } : nodeRequire(name) }) as typeof import("../src/renderer/src/scripts/versions/VersionService.ts");
        const service = new VersionService({ amethystPath: root, versionsPath: root, cachedVersionsFilePath: path.join(root, "cache") } as LauncherPaths);
        const version = { uuid: contentId, version: new SemVersion(1, 0, 0, 0), channel: "release" as const, urls: ["https://example.test/game"] };
        await assert.rejects(service.install(version), /Sign in first/);
        await assert.rejects(service.importMsixvc({ ...version, label: "test", file: archive }), /Sign in first/);
        assert.equal(headCalls, 0);
        assert.deepEqual(await fs.readdir(root), ["game.msixvc"]);
        accountFails = false;
        await assert.rejects(service.install(version), /No licence/);
        assert(headCalls > 0, "licence preflight follows the mirror probe but precedes the full download");
        const pipeline = service as unknown as { decryptAndExtract(file: string, folder: string, label: string): Promise<void> };
        await assert.rejects(pipeline.decryptAndExtract(archive, root, "test"), /No licence/);
        await assert.rejects(fs.access(`${archive}.decrypting`));
        assert.equal(decrypts, 0);
        licenceFails = false;
        await pipeline.decryptAndExtract(archive, root, "test");
        assert.equal(decrypts, 1);
        await assert.rejects(fs.access(`${archive}.decrypting`));
        const cleanup = VersionService as unknown as { discardIfMutated(file: string, label: string): Promise<void> };
        decryptFailure = "unchanged";
        await assert.rejects(pipeline.decryptAndExtract(archive, root, "test"), /Tool failed/);
        await assert.rejects(fs.access(`${archive}.decrypting`));
        await cleanup.discardIfMutated(archive, "test");
        await fs.access(archive);
        decryptFailure = "modified";
        await assert.rejects(pipeline.decryptAndExtract(archive, root, "test"), /Tool failed/);
        await fs.access(`${archive}.decrypting`);
        await cleanup.discardIfMutated(archive, "test");
        await assert.rejects(fs.access(archive));
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it("redacts licence key bytes echoed by XVDTool from progress, logs and errors", async () => {
    const output: string[] = [];
    const fixture = {
        log: (...args: string[]) => { output.push(...args); },
        run: async (command: string, args: string[], options: { onLine(line: string): void; redactArgs(args: string[]): string[] }) => {
            const message = `Failed with key ${key.toString("hex").toUpperCase()}`;
            options.onLine(JSON.stringify({ message, error: "failure" }));
            return { command, args, loggableArgs: options.redactArgs(args), code: 1, timedOut: false,
                stdout: message, stderr: message, output: message, durationMs: 1 };
        },
    };
    const { XVDTool } = await rendererBundle("src/renderer/src/scripts/backend/tools/XVDTool.ts", {
        "./ToolArtifact": "export class ToolArtifact {name='xvdtool'};",
        "@renderer/scripts/LauncherLog": "export const log=(...args)=>fixture.log(...args);",
        "@shared/diagnostics/ProcessRunner": "export const run=(...args)=>fixture.run(...args); export const describeResult=r=>r.loggableArgs.join(' ')+r.output;",
        "@renderer/states/ProgressBarStore": "export const ProgressBar={runAsync:f=>f({setStatus:()=>{},setMessage:m=>fixture.log(m),setProgress:()=>{}})};",
    }, fixture, { require: createRequire(import.meta.url) }) as typeof import("../src/renderer/src/scripts/backend/tools/XVDTool.ts");
    const tool = new XVDTool() as unknown as { runTool(status: string, command: string, args: string[]): Promise<void> };
    await assert.rejects(tool.runTool("decrypting", "/xvdtool", ["-cik", keyId, "-cikdata", cikRecord, "/game.msixvc"]), error => {
        assert(error instanceof Error);
        output.push(error.message);
        return true;
    });
    assert(!output.join("\n").toLowerCase().includes(key.toString("hex")));
    assert(output.some(line => line.includes("<CIK redacted>")));
});


it("reports Xodus entitlement denial specifically without exposing the raw licence response", async () => {
    const execute: Execute = async (command, args) => ({ command, args, loggableArgs: args, code: 1, timedOut: false, durationMs: 0,
        stdout: "", stderr: "not entitled to this content: private account data", output: "not entitled to this content: private account data" });
    await assert.rejects(acquireXodusContentCiks("/xodus-cli", contentId, "/data", execute), error => {
        assert(error instanceof Error);
        assert.match(error.message, /does not own Minecraft/);
        assert(!error.message.includes("private account data"));
        return true;
    });
});

it("checks the remote content ID through Xodus before a Linux download and skips this on Windows", async () => {
    const { root, archive } = await archiveFixture();
    let probes = 0, licences = 0;
    const nodeRequire = createRequire(import.meta.url);
    const fixture = {
        licence: async (id: string, data: string) => {
            assert.equal(id, contentId);
            assert.equal(data, "/data");
            licences++;
            throw Error("This Xodus account does not own Minecraft");
        },
    };
    const testWindow = { process: { platform: "linux" }, require: (name: string) => name === "electron"
        ? { ipcRenderer: { invoke: async (channel: string, url: string) => {
            assert.equal(channel, "net:xvd-header");
            assert.equal(url, "https://mirror.test/game.msixvc");
            probes++;
            return fs.readFile(archive);
        } } } : nodeRequire(name) };
    try {
        const { requireDownloadLicence } = await rendererBundle("src/renderer/src/scripts/backend/Decryption.ts", {
            "@renderer/states/XodusAccountStore": "export const useXodusAccountStore={getState:()=>({refresh:async()=>{},snapshot:{service:'connected',session:'signed_in'}})};",
            "./tools/LauncherTools": "export const LauncherTools={Xodus:{ensureVerified:async()=>{},requireContentLicence:(...args)=>fixture.licence(...args)}};",
            "./WindowsDecryption": "export const CIK_KEYS={};",
        }, fixture, testWindow) as typeof import("../src/renderer/src/scripts/backend/Decryption.ts");
        await assert.rejects(requireDownloadLicence("https://mirror.test/game.msixvc", "/data"), /does not own Minecraft/);
        assert.equal(probes, 1); assert.equal(licences, 1);
        testWindow.process.platform = "win32";
        await requireDownloadLicence("https://mirror.test/game.msixvc", "/data");
        assert.equal(probes, 1); assert.equal(licences, 1);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});
