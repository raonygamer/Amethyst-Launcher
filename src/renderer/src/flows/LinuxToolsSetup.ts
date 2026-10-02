import { LauncherTools } from "@renderer/scripts/backend/tools/LauncherTools";

export type LinuxSetupTool = "xodus" | "GDKProton" | "UMULauncher";

/** Xodus builds from source; UMU and Proton use their original release artifacts. */
export async function prepareLinuxTool(tool: LinuxSetupTool): Promise<string> {
    if (tool === "xodus") {
        const revision = await LauncherTools.Xodus.ensureVerified(true);
        return `Xodus verified successfully.\nRevision: ${revision.slice(0, 12)}`;
    }
    const result = await LauncherTools[tool].check({ checkForUpdates: true, promptForUpdate: false, allowOutdated: false });
    return `${tool === "GDKProton" ? "ProtonGDK" : "UMU Launcher"} ready.\nVersion: ${result.version}`;
}
