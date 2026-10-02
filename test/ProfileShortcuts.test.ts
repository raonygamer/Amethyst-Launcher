import assert from "node:assert/strict";
import { it } from "node:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { createProfileShortcutSync, profileDesktopEntry } from "../src/main/linux/ProfileShortcuts.ts";
import { rendererBundle } from "./helpers/RendererBundle.ts";

it("creates, updates and deletes only managed shortcuts, including rapid profile edits", async () => {
    const dataHome = await fs.mkdtemp(path.join(os.tmpdir(), "amethyst-shortcuts-"));
    try {
        const icon = path.join(dataHome, "source.png"); await fs.writeFile(icon, "fixture");
        const sync = createProfileShortcutSync({ dataHome, command: ["/opt/My Launcher/AppImage"], iconSource: icon });
        const versionPath = path.join(dataHome, "Minecraft 1");
        const nextVersionPath = path.join(dataHome, "Minecraft 2");
        for (const folder of [versionPath, nextVersionPath]) {
            await fs.mkdir(folder); await fs.writeFile(path.join(folder, "minecraftIcon.ico"), "fixture icon");
        }
        const profile = { uuid: "profile-uuid", name: "Survival", versionLabel: "Latest Version", versionPath };
        const shortcuts = path.join(dataHome, "applications");
        await sync([profile]);
        const target = path.join(shortcuts, "amethyst-profile-profile-uuid.desktop");
        const text = await fs.readFile(target, "utf8");
        assert.match(text, /Name=Minecraft - Survival\nComment=Survival — Latest Version\n/);
        assert.ok(text.includes(`Icon=${path.join(versionPath, "minecraftIcon.ico")}\n`));
        assert.match(text, /Exec="\/opt\/My Launcher\/AppImage" "amethyst-launcher:\/\/launchprofile\/profile-uuid"/);
        if (process.platform === "linux") {
            try { execFileSync("desktop-file-validate", [target]); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        }
        await fs.writeFile(path.join(shortcuts, "other.desktop"), "unrelated");
        await fs.writeFile(path.join(shortcuts, "amethyst-profile-unmanaged.desktop"), "unmanaged");
        await Promise.all([sync([{ ...profile, name: "First edit" }]), sync([{ ...profile, name: "Creative", versionLabel: "Preview Version", versionPath: nextVersionPath }])]);
        const updated = await fs.readFile(target, "utf8");
        assert.match(updated, /Name=Minecraft - Creative\nComment=Creative — Preview Version/);
        assert.ok(updated.includes(`Icon=${path.join(nextVersionPath, "minecraftIcon.ico")}\n`));
        await sync([]);
        assert.deepEqual((await fs.readdir(shortcuts)).sort(), ["amethyst-profile-unmanaged.desktop", "other.desktop"]);
        assert.equal(await fs.readFile(path.join(dataHome, "icons/hicolor/128x128/apps/amethyst-launcher.png"), "utf8"), "fixture");
    } finally { await fs.rm(dataHome, { recursive: true, force: true }); }
});

it("escapes desktop fields and Exec arguments without allowing path or field injection", () => {
    const text = profileDesktopEntry({ uuid: "../a b%", name: "Game\nExec=evil", versionLabel: "1\r2" }, ["/tmp/a $b`c\"d%/launcher", "/tmp/repo path"]);
    assert.match(text, /Name=Minecraft - Game\\nExec=evil\nComment=/);
    assert.match(text, /launchprofile\/\.\.%%2Fa%%20b%%25/);
    assert.ok(text.includes('\\\\$'));
    assert.ok(text.includes('\\\\`'));
    assert.ok(text.includes('\\\\"'));
    assert.equal(text.split("\n").filter(line => line.startsWith("Exec=")).length, 1);
});

it("syncs shortcuts after successful profile persistence and skips Windows", async () => {
    const events: string[] = [];
    let failWrite = false;
    const testWindow = { process: { platform: "linux" }, require: (name: string) => name === "fs" ? { existsSync: () => false, mkdirSync: () => {} } : name === "path" ? path : { ipcRenderer: { invoke: async (_channel: string, profiles: unknown[]) => { events.push(`sync:${profiles.length}`); } } } };
    const { ProfileStore } = await rendererBundle("src/renderer/src/scripts/ProfileStore.ts", {
        "./LauncherLog": "export const log=()=>{};",
        "./Utility": "export const inspectStamp=()=>({});export const quarantineFile=()=>false;export const stampFields=()=>({});export const tryReadJsonFile=()=>({});export const writeJsonAtomic=()=>fixture.write();",
    }, { write: () => { if (failWrite) throw Error("disk full"); events.push("save"); } }, testWindow) as typeof import("../src/renderer/src/scripts/ProfileStore.ts");
    const store = new ProfileStore("/tmp/profiles.json");
    store.load(); store.save([]); assert.deepEqual(events, ["save", "sync:0"]);
    events.length = 0; failWrite = true; assert.throws(() => store.save([]), /disk full/); assert.deepEqual(events, []);
    failWrite = false; testWindow.process.platform = "win32"; store.save([]); assert.deepEqual(events, ["save"]);
});
