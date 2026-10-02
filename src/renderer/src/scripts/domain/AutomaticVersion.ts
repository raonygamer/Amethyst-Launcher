import type { Channel } from "./Channel.ts";

/** Persistent selectors; resolved to a concrete catalog UUID before every launch. */
export const AUTOMATIC_VERSIONS = [
    { versionUuid: "latest-release", channel: "release", label: "Latest Version" },
    { versionUuid: "latest-preview", channel: "preview", label: "Preview Version" },
] as const;

export function automaticVersionChannel(selector: string): Channel | null {
    return AUTOMATIC_VERSIONS.find(version => version.versionUuid === selector)?.channel ?? null;
}
