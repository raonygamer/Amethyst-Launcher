const MAX_HTTP_BYTES = 512 * 1024;

/** Keep only safe status metadata, never an Xbox error body or authentication headers. */
export class XboxHttpError extends Error {
    readonly status: number;
    readonly retryAfter: string | null;
    constructor(status: number, retryAfter: string | null) {
        super(`Xbox account lookup returned HTTP ${status}.`);
        this.status = status;
        this.retryAfter = retryAfter;
    }
}

export async function requestJson(
    fetcher: typeof fetch,
    url: string,
    body: unknown,
    auth?: string,
    contract?: string
): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);
    try {
        const response = await fetcher(url, {
            method: body === undefined ? "GET" : "POST",
            redirect: "error",
            signal: controller.signal,
            headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
                "x-xbl-contract-version": contract ?? (auth ? "2" : "1"),
                ...(auth ? { Authorization: auth } : {}),
            },
            body: JSON.stringify(body),
        });
        if (!response.ok) {
            await response.body?.cancel();
            throw new XboxHttpError(response.status, response.headers.get("retry-after"));
        }
        if (Number(response.headers.get("content-length")) > MAX_HTTP_BYTES || !response.body) {
            await response.body?.cancel();
            throw new Error("Xbox account lookup failed.");
        }
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        try {
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                bytes += value.byteLength;
                if (bytes > MAX_HTTP_BYTES) throw new Error("Xbox account lookup failed.");
                chunks.push(value);
            }
        } finally {
            await reader.cancel();
        }
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } finally {
        clearTimeout(timeout);
    }
}
