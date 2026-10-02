import { SourceToolArtifact } from "./SourceToolArtifact";
import { LINUX_SOURCES } from "@shared/linux/LinuxBuild";
import { acquireXodusCiks, acquireXodusContentCiks } from "@shared/linux/XodusLicence";
import { setupXodusService } from "@shared/linux/XodusService";

const path = window.require("path") as typeof import("path");

export class Xodus extends SourceToolArtifact {
    constructor() { super("xodus"); }

    getServiceExecutable(): string {
        return path.join(this.getFolder(), LINUX_SOURCES.xodus.executables[1]);
    }

    protected async afterVerification(onStatus: (message: string) => void): Promise<void> {
        await setupXodusService(this.getServiceExecutable(), path.resolve(this.getFolder(), "../../.."), onStatus);
    }

    async requireContentLicence(contentId: string, amethystData: string): Promise<void> {
        await this.ensureVerified();
        await acquireXodusContentCiks(this.getExecutable(), contentId, amethystData);
    }

    async licenceKeys(archive: string, amethystData: string): Promise<Record<string, string>> {
        await this.ensureVerified();
        return acquireXodusCiks(this.getExecutable(), archive, amethystData);
    }
}
