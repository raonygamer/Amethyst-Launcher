/** Read only the archive header needed by Xodus to identify the content licence. */
export async function fetchXvdHeader(url: string, fetcher: typeof fetch = fetch): Promise<Uint8Array> {
    const target = new URL(url);
    if (!["http:", "https:"].includes(target.protocol)) throw new Error("The game mirror must use HTTP or HTTPS.");
    const size = 0x230;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
        const response = await fetcher(url, { headers: { Range: `bytes=0-${size - 1}`, "Accept-Encoding": "identity" }, signal: controller.signal });
        if (![200, 206].includes(response.status) || !response.body) {
            await response.body?.cancel();
            throw new Error(`Could not read the game header for its Xodus licence check (HTTP ${response.status}).`);
        }
        if (response.status === 206 && !/^bytes 0-\d+\/(?:\d+|\*)$/.test(response.headers.get("content-range") ?? "")) {
            await response.body.cancel();
            throw new Error("The game mirror returned an invalid header range.");
        }
        const reader = response.body.getReader();
        const header = new Uint8Array(size);
        let offset = 0;
        try {
            while (offset < size) {
                const { value, done } = await reader.read();
                if (done) throw new Error("The game mirror returned an incomplete XVD header.");
                const count = Math.min(value.length, size - offset);
                header.set(value.subarray(0, count), offset);
                offset += count;
            }
            return header;
        } finally { await reader.cancel(); }
    } finally { clearTimeout(timeout); }
}
