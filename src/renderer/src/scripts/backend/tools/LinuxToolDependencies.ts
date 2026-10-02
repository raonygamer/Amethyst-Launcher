import { inspectDependencies, installDependencies } from "@shared/linux/LinuxBuild";
import { shellQuote, type LinuxTool } from "@shared/linux/LinuxDependencies";
import { SystemSetupRequiredError } from "@renderer/scripts/platform/LauncherPlatform";
import { log } from "@renderer/scripts/LauncherLog";
import { runSystemSetup } from "@renderer/flows/SystemSetup";

let dependencyQueue: Promise<void> = Promise.resolve();

/** Package managers share a system lock even when different tools build concurrently. */
export function ensureLinuxDependencies(tools: LinuxTool[]): Promise<void> {
    const work = dependencyQueue.then(async () => {
        try { await requireLinuxDependencies(tools); }
        catch (error) {
            if (!(error instanceof SystemSetupRequiredError)) throw error;
            await runSystemSetup(error);
        }
    });
    dependencyQueue = work.catch(() => {});
    return work;
}

export async function requireLinuxDependencies(tools: LinuxTool[]): Promise<void> {
    const plan = await inspectDependencies(tools);
    if (!plan.missing.length) return;
    const missing = plan.missing.join(", ");
    if (!plan.install) {
        throw new Error(`Install these Linux build dependencies with your system's package manager, then retry:\n\n${missing}\n\n`
            + "Automatic installation supports apt-get, dnf, pacman, zypper and apk on writable systems.");
    }
    const install = plan.install;
    const manual = ["sudo", install.command, ...install.args].map(shellQuote).join(" ");
    throw new SystemSetupRequiredError(
        "Install Linux tool dependencies",
        `Building ${tools.join(" and ")} requires: ${missing}.\n\n`
        + `The launcher will run: ${[install.command, ...install.args].map(shellQuote).join(" ")}.\n\n`
        + "Your system will ask for administrator permission if needed. The tools will then be built in your launcher folder.",
        `Run this in a terminal, then retry:\n\n${manual}`,
        async onStatus => {
            onStatus("Installing Linux build dependencies...");
            await installDependencies(install, line => log("LinuxDependencies", line));
            const remaining = await inspectDependencies(tools);
            if (remaining.missing.length) {
                throw new Error(`Some build dependencies are still unavailable: ${remaining.missing.join(", ")}.\n\n${manual}`);
            }
        },
    );
}
