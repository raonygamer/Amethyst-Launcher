import type { Profile } from "./Profile";
import { automaticVersionChannel } from "./AutomaticVersion";
import type { InstalledVersion } from "../versions/InstalledVersion";

export function installedProfileVersion(profile: Profile, installed: readonly InstalledVersion[], latestUuid?: string): InstalledVersion | null {
    const channel = automaticVersionChannel(profile.versionUuid);
    if (latestUuid) return installed.find(version => version.uuid === latestUuid) ?? null;
    if (channel) return installed.filter(version => version.channel === channel).sort((a, b) =>
        (b.version.major - a.version.major) || (b.version.minor - a.version.minor)
        || (b.version.patch - a.version.patch) || (b.version.build - a.version.build))[0] ?? null;
    return installed.find(version => version.uuid === profile.versionUuid) ?? null;
}
