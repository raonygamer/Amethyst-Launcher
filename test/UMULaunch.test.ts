import assert from "node:assert/strict";
import { it } from "node:test";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import path from "node:path";
import { rendererBundle } from "./helpers/RendererBundle.ts";
import type { XodusAccountSnapshot } from "../src/shared/linux/XodusAccountTypes.ts";

const require = createRequire(import.meta.url);
it("checks both archive tools and launches UMU with ProtonGDK, the selected prefix and logged output", async () => {
    const checks: string[] = [];
    const shell = { HOME: "/home/shell-user", XDG_RUNTIME_DIR: "/run/user/4242", WAYLAND_DISPLAY: "wayland-1", WINELOADER: "/shell/wine" };
    let spawnError = false, checkError = false, detached = 0;
    const fixture = {
        prepare: async (proton: string, prefix: string, env: Record<string, string>) => {
            assert.equal(proton, "/tools/ProtonGDK");
            assert.equal(prefix, "/profiles/test/prefix");
            assert.deepEqual(env, { WINEPREFIX: prefix });
            return "/profiles/test/proton-launch";
        },
        check: async (name: string, options: unknown) => {
            checks.push(name);
            assert.deepEqual(options, { checkForUpdates: false });
            if (checkError) throw Error("tool unavailable");
            return { executable: "/tools/umu-run", path: "/tools/ProtonGDK" };
        },
        spawn: (executable: string, args: string[], options: { env: NodeJS.ProcessEnv; cwd: string }) => {
            assert.equal(executable, "/tools/umu-run");
            assert.deepEqual(args, ["/games/with spaces/Minecraft.Windows.exe"]);
            assert.equal(options.cwd, "/games/with spaces");
            assert.equal(options.env.PROTONPATH, "/profiles/test/proton-launch");
            assert.equal(options.env.WINEPREFIX, "/profiles/test/prefix");
            assert.deepEqual(options.env, {
                ...shell, WINEPREFIX: "/profiles/test/prefix", PROTONPATH: "/profiles/test/proton-launch",
                PRESSURE_VESSEL_FILESYSTEMS_RW: "/run/user/4242/xodus.sock",
            });
            const child = new EventEmitter() as EventEmitter & { unref: () => void };
            child.unref = () => { detached++; };
            queueMicrotask(() => spawnError ? child.emit("error", Error("ENOENT")) : child.emit("spawn"));
            return child;
        },
    };
    const { UMULauncher } = await rendererBundle("src/renderer/src/scripts/backend/tools/UMULauncher.ts", {
        "@shared/linux/ProtonLaunchEnvironment": "export const prepareProtonLaunchEnvironment=(...args)=>fixture.prepare(...args); export const withXodusSocketMount=async env=>({...env,PRESSURE_VESSEL_FILESYSTEMS_RW:env.XDG_RUNTIME_DIR+'/xodus.sock'});",
        "./ToolArtifact": "export class ArchiveToolArtifact {name='umu-launcher';check(o){return fixture.check('umu',o)}}",
        "./LauncherTools": "export const LauncherTools={GDKProton:{check:o=>fixture.check('proton',o)}};",
        "@renderer/scripts/LauncherLog": "export const log=()=>{};",
        "@renderer/scripts/diagnostics/GameOutput": "export const spawnLoggedGame=(...args)=>fixture.spawn(...args);",
    }, fixture, { require: (name: string) => name === "shell-env" ? { shellEnv: async () => shell } : name === "os" ? { homedir: () => "/home/test" } : require(name) }) as typeof import("../src/renderer/src/scripts/backend/tools/UMULauncher.ts");
    const tool = new UMULauncher();
    const launch = (): Promise<void> => tool.runGame("/games/with spaces/Minecraft.Windows.exe", { WINEPREFIX: "/profiles/test/prefix" });
    await launch(); assert.deepEqual(checks, ["umu", "proton"]); assert.equal(detached, 1);
    spawnError = true; await assert.rejects(launch(), /Could not start.*ENOENT/); assert.equal(detached, 1);
    checkError = true; await assert.rejects(launch(), /tool unavailable/);
});

it("verifies Xodus and waits for OK only when both service and account are unavailable before launching UMU", async () => {
    const events: string[] = [];
    let status: Pick<XodusAccountSnapshot, "service" | "session"> = { service: "connected", session: "signed_in" };
    let answer!: (accepted: boolean) => void;
    let opened = (): void => {};
    const fixture = {
        account: () => ({ refresh: async () => { events.push("refresh"); }, snapshot: status }),
        warning: () => new Promise<boolean>(resolve => { answer = resolve; opened(); }),
        verify: async () => { events.push("xodus"); },
        launch: async (game: string, env: Record<string, string>) => {
            assert.equal(game, "/game/Minecraft.Windows.exe");
            assert.deepEqual(env, { WINEPREFIX: "/home/test/.amethyst/launcher/profile_data/profile-id/prefix", DXVK_HUD: "fps" });
            events.push("umu");
        },
    };
    const { LinuxLauncherPlatform } = await rendererBundle("src/renderer/src/scripts/platform/LinuxLauncherPlatform.ts", {
        "@renderer/scripts/LauncherLog": "export const log=()=>{};",
        "@renderer/scripts/PathUtils": "export const PathUtils={ensureDirectory:()=>{},ensureParentDirectory:()=>{}};",
        "@renderer/scripts/session/Session": "export const SESSION_SCHEMA=1;export const writeSession=()=>{};",
        "@renderer/popups/OnlineFeaturesWarningPopup": "export const showOnlineFeaturesWarning=()=>fixture.warning();",
        "@renderer/states/XodusAccountStore": "export const useXodusAccountStore={getState:()=>fixture.account()};",
        "@renderer/scripts/backend/tools/LauncherTools": "export const LauncherTools={Xodus:{ensureVerified:()=>fixture.verify()},UMULauncher:{runGame:(...args)=>fixture.launch(...args)}};",
    }, fixture, { require: (name: string) => name === "fs" ? { readdirSync: () => [], mkdirSync: () => {} } : name === "os" ? { homedir: () => "/home/test" } : path }) as typeof import("../src/renderer/src/scripts/platform/LinuxLauncherPlatform.ts");
    const platform = new LinuxLauncherPlatform();
    const request = { profile: { uuid: "profile-id", name: "Preview profile", channel: "preview", environmentVariables: "DXVK_HUD=fps" }, version: { path: "/game", label: "test", uuid: "game-id" }, mods: [], runtime: null, developerMode: false } as Parameters<typeof platform.launch>[0];
    for (const next of [status, { service: "connected", session: "unavailable" }, { service: "disconnected", session: "signed_in" }] as const) {
        status = next; events.length = 0;
        await platform.launch(request);
        assert.deepEqual(events, ["xodus", "refresh", "umu"]);
    }
    status = { service: "disconnected", session: "unavailable" };
    for (const accepted of [true, false]) {
        events.length = 0;
        const shown = new Promise<void>(resolve => { opened = resolve; });
        const launching = platform.launch(request);
        const outcome = accepted ? launching : assert.rejects(launching, /Launch cancelled/);
        await shown;
        assert.deepEqual(events, ["xodus", "refresh"]);
        answer(accepted);
        await outcome;
        assert.equal(events.includes("umu"), accepted);
    }
});
