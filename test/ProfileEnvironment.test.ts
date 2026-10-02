import assert from "node:assert/strict";
import { it } from "node:test";
import { parseProfileEnvironment, windowsGameEnvironment } from "../src/renderer/src/scripts/domain/ProfileEnvironment.ts";
import { parseProfile } from "../src/renderer/src/scripts/domain/Profile.ts";

it("parses literal environment entries including spaces, equals, empty values and shell characters", () => {
    assert.deepEqual(parseProfileEnvironment("\r\nWINEDEBUG=-all\r\nTEXT=hello world=42\nEMPTY=\nLITERAL=$(touch /tmp/no);'quoted'\nWINEDEBUG=+loaddll"), {
        WINEDEBUG: "+loaddll", TEXT: "hello world=42", EMPTY: "", LITERAL: "$(touch /tmp/no);'quoted'",
    });
    assert.deepEqual(parseProfileEnvironment(), {});
    for (const value of ["MISSING", "=value", "BAD NAME=value", "A=value\0"]) {
        assert.throws(() => parseProfileEnvironment(`OK=yes\n${value}`), /line 2 must use NAME=value/);
    }
});

it("preserves profile environment text across serialization and accepts older profiles", () => {
    const base = { uuid: "id", name: "Test", channel: "release", versionUuid: "", versionLabel: "", modded: false, mods: [] };
    assert.deepEqual(parseProfile(base, "test"), base);
    const profile = { ...base, environmentVariables: "DXVK_HUD=fps\nWINEDEBUG=-all" };
    assert.deepEqual(parseProfile(JSON.parse(JSON.stringify(profile)), "test"), profile);
    assert.throws(() => parseProfile({ ...base, environmentVariables: {} }, "test"), /must be a string/);
});

it("overrides inherited Windows variables case insensitively without mutating the launcher", () => {
    const inherited = { Path: "old", KEEP: "yes" };
    assert.deepEqual(windowsGameEnvironment(inherited, { PATH: "new", EMPTY: "" }), { KEEP: "yes", PATH: "new", EMPTY: "" });
    assert.deepEqual(windowsGameEnvironment(inherited, { PATH: "first", Path: "last" }), { KEEP: "yes", Path: "last" });
    assert.deepEqual(inherited, { Path: "old", KEEP: "yes" });
});
