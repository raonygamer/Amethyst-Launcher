import assert from "node:assert/strict";
import { it } from "node:test";
import { fetchXvdHeader } from "../src/main/net/XvdHeader.ts";

it("requests only the licence header and cancels a mirror that ignores ranges", async () => {
    let cancelled = false;
    const header = await fetchXvdHeader("https://example.test/game", async (_url, options) => {
        assert.equal(new Headers(options?.headers).get("Range"), "bytes=0-559");
        return new Response(new ReadableStream({
            start(controller) { controller.enqueue(new Uint8Array(4096).fill(42)); },
            cancel() { cancelled = true; },
        }), { status: 200 });
    });
    assert.equal(header.length, 560);
    assert.equal(header[559], 42);
    assert.equal(cancelled, true);
});

it("assembles a fragmented range and rejects incomplete, wrong-range and failed replies", async () => {
    const fetcher = async (): Promise<Response> => new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new Uint8Array(100)); controller.enqueue(new Uint8Array(460)); controller.close();
    } }), { status: 206, headers: { "Content-Range": "bytes 0-559/1000000" } });
    assert.equal((await fetchXvdHeader("https://example.test/game", fetcher)).length, 560);
    for (const response of [new Response(new Uint8Array(10)), new Response(null, { status: 403 }),
        new Response(new Uint8Array(560), { status: 206, headers: { "Content-Range": "bytes 100-659/1000000" } })]) {
        await assert.rejects(fetchXvdHeader("https://example.test/game", async () => response));
    }
});
