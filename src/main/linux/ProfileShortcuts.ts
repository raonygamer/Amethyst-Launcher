import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { ProfileShortcut } from "../../shared/linux/ProfileShortcuts.ts";

const PREFIX = "amethyst-profile-";
const MARKER = "X-Amethyst-Managed=true";

function desktopValue(value: string): string {
    return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");
}

/** Desktop Exec has its own quoting and percent-field expansion; it is not a shell command. */
function execArgument(value: string): string {
    return `"${desktopValue(value.replace(/[\\"`$]/g, char => `\\${char}`).replace(/%/g, "%%"))}"`;
}

export function profileDesktopEntry(profile: ProfileShortcut, command: readonly string[], icon = "amethyst-launcher"): string {
    const url = `amethyst-launcher://launchprofile/${encodeURIComponent(profile.uuid)}`;
    return `[Desktop Entry]\nType=Application\nVersion=1.0\n`
        + `Name=${desktopValue(`Minecraft - ${profile.name}`)}\nComment=${desktopValue(`${profile.name} — ${profile.versionLabel || "No version selected"}`)}\n`
        + `Exec=${[...command, url].map(execArgument).join(" ")}\n`
        + `Icon=${desktopValue(icon)}\nTerminal=false\nCategories=Game;\nStartupNotify=false\n`
        + `${MARKER}\nX-Amethyst-Profile=${desktopValue(profile.uuid)}\n`;
}

function parseProfiles(input: unknown): ProfileShortcut[] {
    if (!Array.isArray(input)) throw new Error("Expected a list of profile shortcuts.");
    const seen = new Set<string>();
    return input.map(raw => {
        if (!raw || typeof raw !== "object") throw new Error("Invalid profile shortcut.");
        const profile = raw as ProfileShortcut;
        for (const key of ["uuid", "name", "versionLabel"] as const) {
            if (typeof profile[key] !== "string" || profile[key].includes("\0")) throw new Error(`Invalid shortcut ${key}.`);
        }
        if (!profile.uuid || seen.has(profile.uuid)) throw new Error("Shortcut UUIDs must be nonempty and unique.");
        if (profile.versionPath != null && (typeof profile.versionPath !== "string" || profile.versionPath.includes("\0") || !path.isAbsolute(profile.versionPath))) {
            throw new Error("Invalid shortcut version folder.");
        }
        seen.add(profile.uuid);
        return { uuid: profile.uuid, name: profile.name, versionLabel: profile.versionLabel, versionPath: profile.versionPath };
    });
}

async function versionIcon(folder: string | null | undefined): Promise<string> {
    if (folder) {
        try {
            const files = await fs.readdir(folder, { withFileTypes: true });
            for (const candidate of ["minecrafticon.ico", "minecrafticon.png", "logo.png", "storelogo.png"]) {
                const file = files.find(entry => entry.isFile() && entry.name.toLowerCase() === candidate);
                if (file) return path.join(folder, file.name);
            }
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    return "amethyst-launcher";
}

interface ShortcutOptions {
    dataHome: string;
    command: readonly string[];
    iconSource: string;
}

/** Serial snapshots keep rapid edits/deletions in order. Only launcher-owned entries are removed. */
export function createProfileShortcutSync(options: ShortcutOptions): (input: unknown) => Promise<void> {
    const applications = path.join(options.dataHome, "applications");
    let queue: Promise<void> = Promise.resolve();
    let iconInstalled = false;
    const sync = async (profiles: ProfileShortcut[]): Promise<void> => {
        await fs.mkdir(applications, { recursive: true });
        if (!iconInstalled) {
            const icon = path.join(options.dataHome, "icons/hicolor/128x128/apps/amethyst-launcher.png");
            await fs.mkdir(path.dirname(icon), { recursive: true });
            await fs.copyFile(options.iconSource, icon);
            iconInstalled = true;
        }
        const wanted = new Map<string, string>();
        for (const profile of profiles) {
            const id = /^[a-zA-Z0-9_-]{1,128}$/.test(profile.uuid) ? profile.uuid : createHash("sha256").update(profile.uuid).digest("hex");
            wanted.set(`${PREFIX}${id}.desktop`, profileDesktopEntry(profile, options.command, await versionIcon(profile.versionPath)));
        }
        for (const [name, content] of wanted) {
            const target = path.join(applications, name);
            try {
                const info = await fs.lstat(target);
                if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Cannot replace a non-file shortcut: ${target}`);
                const previous = await fs.readFile(target, "utf8");
                if (previous === content) continue;
                if (!previous.split("\n").includes(MARKER)) throw new Error(`Shortcut path is occupied by a file not managed by Amethyst: ${target}`);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            }
            const temporary = `${target}.${randomUUID()}.tmp`;
            try {
                await fs.writeFile(temporary, content, { mode: 0o644, flag: "wx" });
                await fs.rename(temporary, target);
            } finally { await fs.rm(temporary, { force: true }); }
        }
        for (const file of await fs.readdir(applications, { withFileTypes: true })) {
            if (!file.isFile() || !file.name.startsWith(PREFIX) || !file.name.endsWith(".desktop") || wanted.has(file.name)) continue;
            const target = path.join(applications, file.name);
            if ((await fs.readFile(target, "utf8")).split("\n").includes(MARKER)) await fs.unlink(target);
        }
    };
    return input => {
        const profiles = parseProfiles(input);
        const next = queue.then(() => sync(profiles));
        queue = next.catch(() => {});
        return next;
    };
}
