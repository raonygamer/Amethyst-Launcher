import { describeError, userMessage } from "@shared/diagnostics/Log";
import { log } from "./LauncherLog";
import { inspectStamp, quarantineFile, stampFields, tryReadJsonFile, writeJsonAtomic } from "./Utility";
import { Profile, parseProfile } from "./domain/Profile";
import { PROFILE_SHORTCUTS_SYNC } from "@shared/linux/ProfileShortcuts";
import type { InstalledVersion } from "./versions/InstalledVersion";
import { automaticVersionChannel } from "./domain/AutomaticVersion";

const fs = window.require("fs") as typeof import("fs");
const path = window.require("path") as typeof import("path");

const FORMAT = "launcher-profiles";
const FORMAT_VERSION = 1;

const WHAT = "profiles";

interface StampedProfiles {
    profiles?: unknown;
}

export class ProfileStore {
    private loaded = false;
    private unmoved = false;

    constructor(private readonly filePath: string, private readonly installedVersion: (profile: Profile) => InstalledVersion | null = () => null) {}

    /** A save is only ever a rewrite of what this store read, so reading has to come first. */
    load(): Profile[] {
        this.unmoved = false;
        const profiles = this.read();
        this.loaded = !this.unmoved;
        if (profiles.length > 0) this.syncShortcuts(profiles);
        return profiles;
    }

    /**
     * A file that could not be read and could not be moved aside is still the user's only copy,
     * so this store stays shut rather than saving defaults over it.
     */
    private reject(reason: string): Profile[] {
        if (!quarantineFile("Profiles", this.filePath, WHAT, reason)) this.unmoved = true;
        return [];
    }

    /**
     * Profiles are the user's own work, so a file this build cannot read is moved aside rather
     * than deleted, and the launcher starts with none.
     */
    private read(): Profile[] {
        if (!fs.existsSync(this.filePath)) {
            log("Profiles", `No profiles file at ${this.filePath}, starting with none`);
            return [];
        }

        const read = tryReadJsonFile<unknown>("Profiles", this.filePath);
        if (!read.ok) {
            return this.reject(read.reason);
        }

        const stamp = inspectStamp("Profiles", this.filePath, read.value, FORMAT, FORMAT_VERSION);
        if (stamp.state === "mismatch") {
            return this.reject(stamp.reason);
        }

        // Before stamping, the file was a bare array. Anything else unstamped is not ours.
        const entries = stamp.state === "legacy"
            ? read.value
            : (read.value as StampedProfiles).profiles;

        if (!Array.isArray(entries)) {
            return this.reject(
                stamp.state === "legacy"
                    ? "an unstamped profiles file has to be an array of profiles and this one is not"
                    : `"profiles" must be an array, not ${typeof entries}`
            );
        }

        let profiles: Profile[];
        try {
            profiles = entries.map((entry, index) => parseProfile(entry, `${this.filePath}[${index}]`));
        } catch (e) {
            log("Profiles", `A profile in ${this.filePath} could not be read: ${describeError(e)}`);
            return this.reject(userMessage(e));
        }

        log(
            "Profiles",
            `Loaded ${profiles.length} profile(s) from ${this.filePath}`
            + `${stamp.state === "legacy" ? " as an unstamped file, it gets a stamp on the next save" : ""}: `
            + `${profiles.map(p => `"${p.name}" (${p.uuid}, ${p.channel}, ${p.mods.length} mods)`).join("; ") || "none"}`
        );
        return profiles;
    }

    save(profiles: Profile[]): void {
        if (!this.loaded) {
            log(
                "Profiles",
                `REFUSING to write ${profiles.length} profile(s) to ${this.filePath}: it has not been read yet, `
                + "so this save holds startup state rather than the user's profiles"
            );
            return;
        }

        // Not logged: this runs on every profile-editor keystroke and every card drag. The
        // create/edit/delete actions behind it are logged where the user performed them.
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        writeJsonAtomic(this.filePath, { ...stampFields(FORMAT, FORMAT_VERSION), profiles });
        this.syncShortcuts(profiles);
    }

    syncShortcuts(profiles: Profile[]): void {
        if (!this.loaded || window.process.platform !== "linux") return;
        const { ipcRenderer } = window.require("electron") as typeof import("electron");
        void ipcRenderer.invoke(PROFILE_SHORTCUTS_SYNC, profiles.map(profile => {
            const installed = this.installedVersion(profile);
            const versionLabel = installed && automaticVersionChannel(profile.versionUuid)
                ? `${profile.versionLabel} (${installed.version.toString()})` : profile.versionLabel;
            return { uuid: profile.uuid, name: profile.name, versionLabel, versionPath: installed?.path ?? null };
        }))
            .catch(error => log("Profiles", `Could not update application-menu shortcuts: ${describeError(error)}`));
    }
}
