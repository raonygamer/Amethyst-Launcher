import assert from "node:assert/strict";
import { it } from "node:test";
import { EventEmitter } from "node:events";
import type { BrowserWindow } from "electron";
import { isProfileLaunchUrl, keepWindowInBackground, revealWindow } from "../src/main/BackgroundWindow.ts";

it("hides the live window on close but allows an explicit quit", () => {
    const events: string[] = [];
    const window = Object.assign(new EventEmitter(), { hide: () => events.push("hide") });
    let quitting = false;
    keepWindowInBackground(window as unknown as BrowserWindow, () => quitting);
    window.emit("close", { preventDefault: () => events.push("prevent") });
    assert.deepEqual(events, ["prevent", "hide"]);
    events.length = 0; quitting = true;
    window.emit("close", { preventDefault: () => events.push("prevent") });
    assert.deepEqual(events, []);
});

it("profile deep links stay in the background and an explicit reopen restores the window", () => {
    assert.equal(isProfileLaunchUrl("amethyst-launcher://launchprofile/uuid"), true);
    for (const value of [null, "bad", "https://launchprofile/uuid", "amethyst-launcher://other/uuid"]) assert.equal(isProfileLaunchUrl(value), false);
    const events: string[] = [];
    revealWindow({ isMinimized: () => true, restore: () => events.push("restore"), show: () => events.push("show"), focus: () => events.push("focus") } as unknown as BrowserWindow);
    assert.deepEqual(events, ["restore", "show", "focus"]);
});
