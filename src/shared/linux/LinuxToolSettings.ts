import type { LinuxTool } from "./LinuxDependencies.ts";

export const DEFAULT_LINUX_TOOL_SETTINGS = {
    xodusUpstream: "https://github.com/raonygamer/xodus.git",
};
export type LinuxToolSettings = typeof DEFAULT_LINUX_TOOL_SETTINGS;

export function readLinuxToolSettings(value: unknown): LinuxToolSettings {
    const saved = value && typeof value === "object" ? value as Record<string, unknown> : {};
    return Object.fromEntries(Object.entries(DEFAULT_LINUX_TOOL_SETTINGS).map(([key, fallback]) =>
        [key, typeof saved[key] === "string" ? saved[key] : fallback])) as LinuxToolSettings;
}

export function toolBuildSettings(tool: LinuxTool, settings = DEFAULT_LINUX_TOOL_SETTINGS): { upstream: string; configure: string[] } {
    let upstream = settings.xodusUpstream.trim();
    if (/^[\w.-]+\/[\w.-]+$/.test(upstream)) upstream = `https://github.com/${upstream.replace(/\.git$/, "")}.git`;
    if (!upstream || upstream.startsWith("-") || /[\r\n\0]/.test(upstream) || (!upstream.startsWith("/") && /\s/.test(upstream))
        || !/^(?:https?:\/\/|ssh:\/\/|git:\/\/|git@[^:]+:|\/)/.test(upstream)) {
        throw new Error(`${tool} upstream must be a Git repository URL, owner/repository, or an absolute local repository path.`);
    }
    return { upstream, configure: [] };
}
