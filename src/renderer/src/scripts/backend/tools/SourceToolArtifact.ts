import { useAppStore } from "@renderer/states/AppStore";
import { DEFAULT_LINUX_TOOL_SETTINGS, toolBuildSettings, type LinuxToolSettings } from "@shared/linux/LinuxToolSettings";
import { buildSource, LINUX_SOURCES, sourceRevision, verifySource } from "@shared/linux/LinuxBuild";
import type { LinuxTool } from "@shared/linux/LinuxDependencies";
import { log } from "@renderer/scripts/LauncherLog";
import { ProgressBar } from "@renderer/states/ProgressBarStore";
import { ToolArtifact, type DefaultCheckOptions, type ToolCandidate } from "./ToolArtifact";
import { ensureLinuxDependencies } from "./LinuxToolDependencies";

const fs = window.require("fs") as typeof import("fs");
const path = window.require("path") as typeof import("path");

/** Source builds retain ToolArtifact's serialisation, staging, rollback and version cache. */
export class SourceToolArtifact extends ToolArtifact {
    private verification: Promise<string> | null = null;
    private activeSettings: LinuxToolSettings | null = null;
    private settings(): LinuxToolSettings {
        return this.activeSettings ?? useAppStore.getState().linuxToolSettings ?? DEFAULT_LINUX_TOOL_SETTINGS;
    }
    constructor(private readonly tool: LinuxTool) {
        super(tool, LINUX_SOURCES[tool].repository);
    }

    isSupported(): boolean {
        return window.process.platform === "linux" && window.process.arch === "x64";
    }

    protected getFolderName(): string { return this.name; }
    protected getExecutableName(): string { return LINUX_SOURCES[this.tool].executables[0]; }
    protected compareTags(current: string | null, latest: string): number { return current === latest ? 0 : -1; }

    protected checkDefaults(): DefaultCheckOptions {
        return { ...super.checkDefaults(), releaseFetchTimeout: 30_000 };
    }

    protected async prepareCheck(): Promise<void> {
        await ensureLinuxDependencies([this.tool]);
    }

    /** Persist success per installed revision; concurrent actions share the same setup. */
    ensureVerified(force = false): Promise<string> {
        if (this.verification) return this.verification;
        this.activeSettings = { ...this.settings() };
        this.verification = this.verifyInstallation(force).finally(() => { this.verification = null; this.activeSettings = null; });
        return this.verification;
    }

    protected async afterVerification(_onStatus: (message: string) => void): Promise<void> {
        // Subclasses can finish setup before the successful verification is saved.
    }

    private async verifyInstallation(force: boolean): Promise<string> {
        if (!this.isSupported()) throw new Error(`${this.name} requires x86_64 Linux.`);
        const marker = path.join(this.getFolder(), ".amethyst-verified.json");
        const current = await this.getCurrentVersion();
        if (current && !force) {
            try {
                const saved = JSON.parse(await fs.promises.readFile(marker, "utf8"));
                if (saved.schema === 1 && saved.version === current) return current;
            } catch { /* First verification, a changed install, or an interrupted write. */ }
        }
        await fs.promises.rm(marker, { force: true });
        let version = current;
        await ProgressBar.runAsync(async ({ setStatus, setMessage }) => {
            setStatus("other");
            setMessage(`Verifying ${this.name}...`);
            if (force) {
                setMessage(`Checking ${this.name} source updates...`);
                const result = await this.check({ checkForUpdates: true, promptForUpdate: false, allowOutdated: false });
                version = result.version;
                setMessage(`Verifying ${this.name}...`);
            }
            let usable = false;
            if (version) {
                try { await verifySource(this.tool, this.getFolder()); usable = true; }
                catch { log(this.name, "Installed tool failed verification; preparing a replacement."); }
            }
            if (!usable) {
                const result = await this.check({ checkForUpdates: false, forceInstall: Boolean(version), promptForUpdate: false, allowOutdated: false });
                version = result.version;
                await verifySource(this.tool, this.getFolder());
            }
            await this.afterVerification(setMessage);
            const temporary = `${marker}.tmp`;
            await fs.promises.writeFile(temporary, JSON.stringify({ schema: 1, version }), { mode: 0o600 });
            await fs.promises.rename(temporary, marker);
            log(this.name, `Verified installed revision ${version}`);
        });
        return version!;
    }

    protected async resolveLatest(timeout: number): Promise<ToolCandidate> {
        return { version: await sourceRevision(this.tool, timeout, undefined, line => log(this.name, line), this.settings()) };
    }

    protected async getCurrentVersion(): Promise<string | null> {
        const version = await super.getCurrentVersion();
        if (!version) return null;
        for (const executable of LINUX_SOURCES[this.tool].executables) {
            try { fs.accessSync(path.join(this.getFolder(), executable), fs.constants.X_OK); }
            catch { return null; }
        }
        const expected = toolBuildSettings(this.tool, this.settings());
        let installed = toolBuildSettings(this.tool);
        try {
            installed = JSON.parse(await fs.promises.readFile(path.join(this.getFolder(), ".amethyst-build-settings.json"), "utf8"));
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
            // Existing builds predate customization and used the original defaults.
        }
        if (JSON.stringify(installed) !== JSON.stringify(expected)) return null;
        return version;
    }

    protected async stageInstall(candidate: ToolCandidate, destination: string): Promise<void> {
        await ProgressBar.runAsync(async ({ setStatus, setMessage }) => {
            setStatus("other");
            const started = Date.now();
            let stage = `Preparing ${this.name}...`;
            const updateMessage = (): void => {
                const elapsed = Math.floor((Date.now() - started) / 1000);
                setMessage(`${stage} (${Math.floor(elapsed / 60)}m ${elapsed % 60}s elapsed)`);
            };
            const onStatus = (message: string): void => {
                stage = message;
                log(this.name, message);
                updateMessage();
            };
            const timer = setInterval(updateMessage, 1000);
            try {
                await buildSource(this.tool, candidate.version, destination, this.getFolder(), onStatus,
                    line => log(this.name, line), undefined, this.settings());
                await fs.promises.writeFile(path.join(destination, ".amethyst-build-settings.json"),
                    JSON.stringify(toolBuildSettings(this.tool, this.settings())), { mode: 0o600 });
                onStatus(`Verifying ${this.name}...`);
                await verifySource(this.tool, destination);
            } finally {
                clearInterval(timer);
            }
        });
    }
}
