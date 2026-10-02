import { prepareProtonLaunchEnvironment, withXodusSocketMount } from "@shared/linux/ProtonLaunchEnvironment";
import { spawnLoggedGame } from "@renderer/scripts/diagnostics/GameOutput";
import { log } from "@renderer/scripts/LauncherLog";
import { ArchiveToolArtifact } from "./ToolArtifact";
import { LauncherTools } from "./LauncherTools";

const path = window.require("path") as typeof import("path");
const { shellEnv } = window.require("shell-env") as typeof import("shell-env");

/**
 * [UMU Launcher](https://github.com/raonygamer/umu-launcher) - a compatibility layer for running
 * Windows games on Linux via Proton.
 *
 * Supported platforms: **Linux** only.
 *
 * Typical usage:
 * ```ts
 * await LauncherTools.UMULauncher.runGame(gamePath, { WINEPREFIX: prefixPath });
 * ```
 */
export class UMULauncher extends ArchiveToolArtifact {
    constructor() {
        super({
            name: "umu-launcher",
            repository: "raonygamer/umu-launcher",
            executableName: "umu-run",
            platforms: ["linux"],
            permissions: 0o755,
            checkDefaults: {
                promptForUpdate: false,
                allowOutdated: true,
                releaseFetchTimeout: 1000,
                checkForUpdates: true
            }
        });
    }

    /**
     * Launches a game through UMU Launcher.
     *
     * @param gamePath        Absolute path to the game executable (`.exe`).
     * @param envVars         Environment variables to pass to the process (e.g. `WINEPREFIX`, `PROTONPATH`).
     * @param checkForUpdates When `true`, checks GitHub for a newer UMU Launcher first.
     */
    async runGame(gamePath: string, envVars: Record<string, string>, checkForUpdates: boolean = false): Promise<void> {
        log(this.name, `Starting '${gamePath}' through Proton, checkForUpdates=${checkForUpdates}`);

        const { executable } = await this.check({ checkForUpdates });
        const { path: gdkProtonPath } = await LauncherTools.GDKProton.check({ checkForUpdates });

        const envs = await shellEnv();
        const ownEnv = {
            ...envVars,
            PROTONPATH: gdkProtonPath,
        };
        const env = await withXodusSocketMount({
            ...envs,
            ...ownEnv,
        });
        if (env.PRESSURE_VESSEL_FILESYSTEMS_RW !== (envVars.PRESSURE_VESSEL_FILESYSTEMS_RW ?? envs.PRESSURE_VESSEL_FILESYSTEMS_RW)) {
            log(this.name, `Sharing Xodus socket ${path.join(env.XDG_RUNTIME_DIR!, "xodus.sock")} with the Steam container`);
        }
        // The launcher's own additions only. The inherited shell environment is not logged:
        // it is long and routinely carries tokens the user never meant to hand over.
        log(
            this.name,
            `Spawning ${executable} ${gamePath} in ${path.dirname(gamePath)} with `
            + `${Object.keys(ownEnv).join(", ")} `
            + `on top of ${Object.keys(envs).length} inherited variables`
        );

        if (!envVars.WINEPREFIX) throw new Error("A profile Wine prefix is required.");
        env.PROTONPATH = await prepareProtonLaunchEnvironment(gdkProtonPath, envVars.WINEPREFIX, {
            ...envVars,
        });
        log(this.name, "Applying profile variables after the Steam container starts; HOME and runtime inherit session defaults unless explicitly configured in the profile");

        const proc = spawnLoggedGame(executable, [gamePath], {
            env, cwd: path.dirname(gamePath),
        });

        // A spawn failure arrives asynchronously, so without this wait the launch would report
        // success for a game that never started.
        await new Promise<void>((resolve, reject) => {
            proc.once("spawn", () => resolve());
            proc.once("error", error => {
                log(this.name, `${executable} could not be started: ${error.message}`);
                reject(new Error(`Could not start ${executable}. ${error.message}`));
            });
        });

        proc.unref();
        log(this.name, `${gamePath} started as pid ${proc.pid ?? "unknown"}, detached from the launcher`);
    }
}
