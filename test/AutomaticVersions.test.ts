import assert from "node:assert/strict";
import { it } from "node:test";
import path from "node:path";
import { rendererBundle } from "./helpers/RendererBundle.ts";
import { parseProfile } from "../src/renderer/src/scripts/domain/Profile.ts";
import { SemVersion } from "../src/renderer/src/scripts/classes/SemVersion.ts";
import type { CatalogVersion } from "../src/renderer/src/scripts/versions/Catalog.ts";
import type { InstalledVersion } from "../src/renderer/src/scripts/versions/InstalledVersion.ts";
import type { LauncherPaths } from "../src/renderer/src/scripts/platform/LauncherPlatform.ts";

it("automatic catalog refresh bypasses fresh cache every time and fails visibly when offline", async () => {
    let cached: unknown = { fetched_at: new Date().toISOString(), file_version: 1,
        versions: [{ uuid: "old", version: "1.0.0", channel: "release", urls: [] }] };
    let calls = 0;
    let offline = false;
    const fixture = {
        read: () => cached,
        write: (value: unknown) => { cached = value; },
        fetch: async (_url: string, options: RequestInit) => {
            assert.equal(options.cache, "no-store"); calls++;
            if (offline) throw Error("offline");
            return { ok: true, json: async () => ({ file_version: 1, releaseVersions: [{ version: `1.0.${calls}`, urls: ["https://example.test/11111111-1111-1111-1111-111111111111/file"] }], previewVersions: [] }) };
        },
    };
    const { Catalog } = await rendererBundle("src/renderer/src/scripts/versions/Catalog.ts", {
        "@renderer/scripts/LauncherLog": "export const log=()=>{};",
        "@renderer/scripts/Utility": `export const stampFields=()=>({}); export const inspectStamp=()=>({state:'ok'}); export const tryReadJsonFile=()=>({ok:true,value:fixture.read()}); export const writeJsonAtomic=(_path,value)=>fixture.write(value);export const discardCacheFile=()=>{};`,
    }, fixture, { require: () => ({ existsSync: () => true }) }) as typeof import("../src/renderer/src/scripts/versions/Catalog.ts");
    const catalog = new Catalog("/unused/cache.json");
    await catalog.refresh(); assert.equal(calls, 0);
    await catalog.refresh({ force: true, allowStale: false }); assert.equal(calls, 1);
    await catalog.refresh({ force: true, allowStale: false }); assert.equal(calls, 2);
    assert.equal(catalog.latest("release")?.version.toString(), "1.0.2");
    offline = true;
    await assert.rejects(catalog.refresh({ force: true, allowStale: false }), /Could not check/);
});

it("resolves automatic profiles anew, keeps release and preview separate, and preserves the selector", async () => {
    const version = (uuid: string, channel: "release" | "preview", patch: number): CatalogVersion => ({ uuid, channel, version: new SemVersion(1, 0, patch, 0), urls: [] });
    let newest = version("release-one", "release", 1);
    const preview = version("preview-one", "preview", 2);
    const installed = new Map<string, InstalledVersion>();
    let checks = 0;
    let installs = 0;
    const fixture = {
        catalog: { refresh: async (options: unknown) => { assert.deepEqual(options, { force: true, allowStale: false }); checks++; },
            latest: (channel: string) => channel === "preview" ? preview : newest },
        library: { byUuid: (uuid: string) => installed.get(uuid) ?? null },
    };
    const mocks = {
        "./Catalog": "export class Catalog {constructor(){return fixture.catalog}};export const catalogLabel=v=>v.uuid;",
        "./Library": "export class Library {constructor(){return fixture.library}};",
        "@renderer/scripts/LauncherLog": "export const log=()=>{};",
        "@renderer/scripts/Directories": "export const errnoCode=()=>null;",
        "@renderer/scripts/FileLocker": "export const FileLocker={};",
        "@renderer/scripts/backend/Decryption": "export const gameLicenceKeys=async()=>({});export const requireDownloadAccount=async()=>{};",
        "@renderer/scripts/backend/Downloader": "export const Downloader={};export const PART_SUFFIX='.part';",
        "@renderer/scripts/backend/tools/LauncherTools": "export const LauncherTools={};",
        "@renderer/states/ProgressBarStore": "export const ProgressBar={};export const FULL_PROGRESS_RESET_OPTIONS={};",
        "@renderer/states/DownloadStore": "export const useDownloadStore={};export const addPendingDownload=()=>{};export const removePendingDownload=()=>{};",
    };
    const { VersionService } = await rendererBundle("src/renderer/src/scripts/versions/VersionService.ts", mocks, fixture, {
        require: (name: string) => name === "path" ? path : name === "fs" ? { promises: { stat: async () => ({ isDirectory: () => true }) } } : { ipcRenderer: {} },
    }) as typeof import("../src/renderer/src/scripts/versions/VersionService.ts");
    const service = new VersionService({ cachedVersionsFilePath: "/unused", versionsPath: "/unused" } as LauncherPaths);
    const originalInstall = service.install.bind(service);
    service.install = async candidate => {
        if (installed.has(candidate.uuid)) return originalInstall(candidate);
        installs++;
        const result = { ...candidate, label: candidate.uuid, path: "/unused", packageFamily: "fixture", imported: false };
        installed.set(candidate.uuid, result); return result;
    };
    const profile = parseProfile({ uuid: "p", name: "Latest", channel: "release", versionUuid: "latest-release", versionLabel: "Latest Version", modded: false, mods: [] }, "fixture");
    assert.equal((await service.resolveOrInstall(profile.versionUuid)).uuid, "release-one");
    await service.resolveOrInstall(profile.versionUuid);
    assert.equal(installs, 1, "unchanged latest version reuses its installed files");
    newest = version("release-two", "release", 3);
    assert.equal((await service.resolveOrInstall(profile.versionUuid)).uuid, "release-two");
    assert.equal((await service.resolveOrInstall("latest-preview")).uuid, "preview-one");
    assert.equal(checks, 4);
    assert.equal(profile.versionUuid, "latest-release");
    assert.equal((await service.resolveOrInstall("release-one")).uuid, "release-one");
    assert.equal(checks, 4, "pinned installed versions retain existing behavior");
});
