import { useAppStore } from "@renderer/states/AppStore";
import { ProgressBar } from "@renderer/states/ProgressBarStore";
import { Profile } from "./Profiles";
import { InstalledVersionModel } from "./VersionManager";
import { MinecraftVersionData } from "./VersionDatabase";

/**
 * Launches a profile by its UUID. Can be called from anywhere (protocol handler, UI, etc.)
 */
export async function launchProfileByUUID(profileUuid: string): Promise<void> {
    const state = useAppStore.getState();
    const profile = state.allProfiles.find(p => p.uuid === profileUuid);
    if (!profile) {
        throw new Error(`Profile with UUID ${profileUuid} not found!`);
    }
    await launchProfile(profile);
}

/**
 * Core launch logic extracted from LauncherPage. Validates mods, resolves versions, and launches.
 */
export async function launchProfile(profile: Profile): Promise<void> {
    const state = useAppStore.getState();
    const { allValidMods, versionManager, platform } = state;

    if (!ProgressBar.canDoAction("launch") || state.minecraftIsRunning) return;

    const profileInvalidMods = profile.mods.filter(mod => !allValidMods.includes(mod));
    if (profileInvalidMods.length > 0) {
        throw new Error(
            `Profile has ${profileInvalidMods.length} missing mod${profileInvalidMods.length > 1 ? "s" : ""}, edit profile to launch! Missing mods: ${profileInvalidMods.map(mod => `'${mod}'`).join(", ")}`
        );
    }

    if (!profile.version_uuid) {
        throw new Error("No Minecraft version selected for this profile! Edit the profile to set one.");
    }

    await versionManager.database.update();
    const anyVersion = versionManager.getAnyVersionByUUID(profile.version_uuid);
    if (!anyVersion) {
        throw new Error("Selected Minecraft version for this profile is not in the version database nor installed! Edit the profile to select a different version.");
    }

    if (anyVersion instanceof InstalledVersionModel) {
        await ProgressBar.useAsync(async ({ setStatus, setMessage, setProgress }) => {
            setStatus("launching");
            setProgress(0.5);
            setMessage(`Preparing ${anyVersion.getName()}...`);

            await platform.runProfile(profile, anyVersion, setMessage);
        }, true);
        return;
    } 
    else if (anyVersion instanceof MinecraftVersionData) {
        await ProgressBar.useAsync(async ({ setStatus, setMessage, setProgress }) => {
            setStatus("other");
            setProgress(0);
            setMessage(`Checking version ${anyVersion.version.toString()}...`);

            const isVersionInstalled = versionManager.getInstalledVersionByUUID(anyVersion.uuid) !== null;

            if (!isVersionInstalled) {
                setMessage(`Downloading ${anyVersion.version.toString()}...`);
                await versionManager.downloadExtractAndInstallVersion(anyVersion.uuid);
            }
        }, true);

        await ProgressBar.useAsync(async ({ setStatus, setMessage, setProgress }) => {
            setStatus("launching");
            setProgress(0.5);
            setMessage(`Preparing ${anyVersion.version.toString()}...`);

            const installedVersion = versionManager.getInstalledVersionByUUID(anyVersion.uuid);
            if (!installedVersion) {
                throw new Error("Failed to find the installed version after downloading and extracting it.");
            }

            await platform.runProfile(profile, installedVersion, setMessage);
        }, true);
    }
}
