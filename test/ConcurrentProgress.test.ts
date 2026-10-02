import assert from "node:assert/strict";
import { it } from "node:test";
import { rendererBundle } from "./helpers/RendererBundle.ts";

it("isolates simultaneous progress and preserves active work when another operation fails or resets", async () => {
    const { ProgressBar } = await rendererBundle("src/renderer/src/states/ProgressBarStore.tsx", {
        "@renderer/scripts/LauncherLog": "export const log=()=>{};",
    }) as typeof import("../src/renderer/src/states/ProgressBarStore.tsx");
    let endA!: () => void;
    let endB!: () => void;
    let updateA!: (value: string | ((previous: string) => string)) => void;
    const a = ProgressBar.runAsync(async state => {
        state.setStatus("downloading"); state.setMessage("Download A"); state.setProgress(0.2);
        updateA = state.setMessage;
        await new Promise<void>(resolve => { endA = resolve; });
    });
    const b = ProgressBar.runAsync(async state => {
        state.setStatus("extracting"); state.setMessage("Extract B"); state.setProgress(0.8);
        await new Promise<void>(resolve => { endB = resolve; });
        throw Error("B failed");
    });
    const rejected = assert.rejects(b, /B failed/);
    updateA(previous => previous + " continues");
    assert.deepEqual(ProgressBar.getState().tasks.map(task => [task.message, task.progress]), [["Download A continues", 0.2], ["Extract B", 0.8]]);
    assert.equal(ProgressBar.canDoAction("download"), true);
    assert.equal(ProgressBar.canDoAction("launch"), false);
    endB(); await rejected;
    ProgressBar.reset();
    assert.equal(ProgressBar.getState().tasks.length, 1);
    assert.equal(ProgressBar.isBusy(), true);
    endA(); await a;
    assert.equal(ProgressBar.getState().tasks.length, 0);
    assert.equal(ProgressBar.isBusy(), false);
    assert.equal(ProgressBar.canDoAction("launch"), true);
    updateA("late callback");
    assert.equal(ProgressBar.getState().message, "");
});

it("nested work gets independent setters and cannot unblock a launching parent", async () => {
    const { ProgressBar } = await rendererBundle("src/renderer/src/states/ProgressBarStore.tsx", {
        "@renderer/scripts/LauncherLog": "export const log=()=>{};",
    }) as typeof import("../src/renderer/src/states/ProgressBarStore.tsx");
    await ProgressBar.runAsync(async parent => {
        parent.setStatus("launching"); parent.setMessage("Start game");
        await ProgressBar.runAsync(async child => {
            child.setStatus("idle"); child.setMessage("Child task");
            assert.equal(ProgressBar.canDoAction("download"), false);
            assert.equal(parent.message, "Start game");
        });
        assert.equal(ProgressBar.getState().message, "Start game");
    });
    assert.equal(ProgressBar.getState().show, false);
});
