import { type Channel, isChannel } from "./Channel.ts";

export interface Profile {
    uuid: string;
    name: string;
    channel: Channel;
    /** Concrete version UUID or an AutomaticVersion selector. Empty means no selection. */
    versionUuid: string;
    /** Display text only — never used to resolve a version. */
    versionLabel: string;
    /**
     * The user's Modded/Vanilla choice, and the only thing that decides it. Which of `mods` is the
     * runtime is read off the mods folder at the moment it matters, never stored: a stored copy is
     * a second answer to a question the folder already answers, and the two went out of step.
     */
    modded: boolean;
    mods: string[];
    /** Literal NAME=value entries, one per line; absent in older profiles. */
    environmentVariables?: string;
}

export function isModded(profile: Profile): boolean {
    return profile.modded;
}

export function parseProfile(raw: unknown, where: string): Profile {
    if (typeof raw !== "object" || raw === null) throw new Error(`${where}: profile is not an object`);
    const o = raw as Record<string, unknown>;

    const text = (key: string, allowEmpty = false): string => {
        const value = o[key];
        if (typeof value !== "string") throw new Error(`${where}: "${key}" must be a string`);
        if (!allowEmpty && value === "") throw new Error(`${where}: "${key}" must not be empty`);
        return value;
    };

    if (!isChannel(o.channel)) throw new Error(`${where}: "channel" must be "release" or "preview"`);
    if (!Array.isArray(o.mods) || !o.mods.every(m => typeof m === "string")) {
        throw new Error(`${where}: "mods" must be an array of strings`);
    }

    if (o.environmentVariables !== undefined && typeof o.environmentVariables !== "string") {
        throw new Error(`${where}: "environmentVariables" must be a string`);
    }
    const mods = o.mods as string[];

    return {
        uuid: text("uuid"),
        name: text("name"),
        channel: o.channel,
        versionUuid: text("versionUuid", true),
        versionLabel: text("versionLabel", true),
        modded: readModded(o, mods),
        mods,
        ...(o.environmentVariables !== undefined ? { environmentVariables: o.environmentVariables as string } : {}),
    };
}

/** Profiles written before `modded` existed carry the choice in a runtime mod name, or "Vanilla". */
function readModded(o: Record<string, unknown>, mods: string[]): boolean {
    if (typeof o.modded === "boolean") return o.modded;
    const legacyRuntime = typeof o.runtime === "string" ? o.runtime.trim().toLowerCase() : "";
    return mods.length > 0 || (legacyRuntime !== "" && legacyRuntime !== "vanilla");
}
