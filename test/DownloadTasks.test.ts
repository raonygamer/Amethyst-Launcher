import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { it } from "node:test";
import { rendererBundle } from "./helpers/RendererBundle.ts";
import { TransferRate } from "../src/shared/net/TransferRate.ts";
import { NET_DOWNLOAD_PROGRESS, NET_DOWNLOAD_ABORT, type DownloadOutcome, type DownloadRequest } from "../src/shared/net/DownloadIpc.ts";

it("measures transfer rates, settles to zero when stalled, and resets on retry", () => {
    const rate = new TransferRate(0);
    assert.equal(rate.update(1024, 1000), 1024);
    assert.equal(rate.update(2048, 2000), 1024);
    for (let time = 3000; time <= 7000; time += 1000) rate.update(2048, time);
    assert.equal(rate.update(2048, 8000), 0);
    assert.equal(rate.update(0, 9000), 0);
    assert.equal(rate.update(2048, 10000), 2048);
});

it("tracks concurrent transfers independently, cancels only the selected one, and clears rate timers", async () => {
    const requests: { request: DownloadRequest; finish(value: DownloadOutcome): void }[] = [];
    const cancelled: string[] = [];
    const timers = new Set<() => void>();
    const items = new Map<string, Record<string, unknown>>();
    const fixture = { store: {
        addDownload: (item: { id: string }) => { items.set(item.id, item); },
        updateDownload: (id: string, update: Record<string, unknown>) => { if (items.has(id)) Object.assign(items.get(id)!, update); },
    } };
    const ipc = Object.assign(new EventEmitter(), {
        invoke: (_channel: string, request: DownloadRequest) => new Promise<DownloadOutcome>(finish => requests.push({ request, finish })),
        send: (channel: string, id: string) => { assert.equal(channel, NET_DOWNLOAD_ABORT); cancelled.push(id); },
    });
    const { Downloader } = await rendererBundle("src/renderer/src/scripts/backend/Downloader.ts", {
        "@renderer/scripts/LauncherLog": "export const log=()=>{};",
        "@renderer/states/DownloadStore": "export const useDownloadStore={getState:()=>fixture.store};",
    }, fixture, {
        require: () => ({ ipcRenderer: ipc }),
        setInterval: (fn: () => void) => { timers.add(fn); return fn; },
        clearInterval: (fn: () => void) => { timers.delete(fn); },
    }) as typeof import("../src/renderer/src/scripts/backend/Downloader.ts");
    const first = Downloader.downloadFile("https://example.test/a", "/tmp/a");
    const second = Downloader.downloadFile("https://example.test/b", "/tmp/b");
    const rejected = assert.rejects(second, { name: "AbortError" });
    ipc.emit(NET_DOWNLOAD_PROGRESS, {}, { id: requests[0].request.id, transferred: 100, total: 200 });
    ipc.emit(NET_DOWNLOAD_PROGRESS, {}, { id: requests[1].request.id, transferred: 30, total: 0 });
    assert.equal(items.get(requests[0].request.id)?.progress, 0.5);
    assert.equal(items.get(requests[1].request.id)?.total, 0);
    (items.get(requests[1].request.id)?.abortController as AbortController).abort();
    assert.deepEqual(cancelled, [requests[1].request.id]);
    requests[1].finish({ kind: "aborted", message: "Cancelled" }); await rejected;
    assert.equal(timers.size, 1);
    requests[0].finish({ kind: "done", bytes: 200 }); await first;
    assert.equal(timers.size, 0);
    assert.equal(items.get(requests[0].request.id)?.status, "done");
    assert.equal(items.get(requests[0].request.id)?.bytesPerSecond, 0);
});
