import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { it } from "node:test";
import { DEFAULT_LINUX_TOOL_SETTINGS as defaults, readLinuxToolSettings, toolBuildSettings } from "../src/shared/linux/LinuxToolSettings.ts";
(globalThis as unknown as { require: NodeRequire }).require = createRequire(import.meta.url);
const { sourceRevision } = await import("../src/shared/linux/LinuxBuild.ts");

it("loads defaults and preserves custom Xodus upstreams", () => {
    assert.deepEqual(readLinuxToolSettings(undefined), defaults);
    const custom = { xodusUpstream: "example/xodus" };
    assert.deepEqual(readLinuxToolSettings(custom), custom);
    assert.equal(toolBuildSettings("xodus", custom).upstream, "https://github.com/example/xodus.git");
    assert.throws(() => toolBuildSettings("xodus", { xodusUpstream: "--upload-pack=bad" }), /upstream/);
});

it("resolves custom upstream default branches", async () => {
    const revision = "a".repeat(40);
    const settings = { xodusUpstream: "https://example.com/xodus.git" };
    assert.equal(await sourceRevision("xodus", 5000, async (command, args) => {
        assert.equal(command, "git");
        assert.deepEqual(args, ["ls-remote", settings.xodusUpstream, "HEAD"]);
        const stdout = `${revision}\tHEAD\n`;
        return { command, args, loggableArgs: args, code: 0, stdout, stderr: "", output: stdout, durationMs: 0, timedOut: false };
    }, () => {}, settings), revision);
});
