import { SourceToolArtifact } from "./SourceToolArtifact";
import { LINUX_SOURCES } from "@shared/linux/LinuxBuild";
import { acquireXodusCiks, acquireXodusContentCiks } from "@shared/linux/XodusLicence";
import { XODUS_ENSURE_RUNNING, type XodusLoginResult } from "@shared/linux/XodusAccountTypes";

const path = window.require("path") as typeof import("path");

export class Xodus extends SourceToolArtifact {
    constructor() { super("xodus"); }

    getServiceExecutable(): string {
        return path.join(this.getFolder(), LINUX_SOURCES.xodus.executables[1]);
    }

    protected async afterVerification(onStatus: (message: string) => void): Promise<void> {
        onStatus("Starting Xodus; unlock your keyring if prompted...");
        await this.ensureRunning();
    }

    private async ensureRunning(): Promise<void> {
        const { ipcRenderer } = window.require("electron") as typeof import("electron");
        const result: XodusLoginResult = await ipcRenderer.invoke(XODUS_ENSURE_RUNNING);
        if (!result.ok) throw new Error(result.message || "Could not start Xodus.");
    }

    async requireContentLicence(contentId: string, amethystData: string): Promise<void> {
        await this.ensureVerified();
        await this.ensureRunning();
        await acquireXodusContentCiks(this.getExecutable(), contentId, amethystData);
    }

    async licenceKeys(archive: string, amethystData: string): Promise<Record<string, string>> {
        await this.ensureVerified();
        await this.ensureRunning();
        return acquireXodusCiks(this.getExecutable(), archive, amethystData);
    }
}
