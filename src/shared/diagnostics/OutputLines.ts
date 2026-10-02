/** Decodes independent UTF-8 chunks and bounds output that never contains a newline. */
export function outputLines(onLine: (line: string) => void, maxLineLength = 16_384): {
    push(chunk: Uint8Array): void;
    flush(): void;
} {
    const decoder = new TextDecoder();
    let pending = "";
    let skipLineFeed = false;
    let ended = false;

    const consume = (text: string): void => {
        if (!text) return;
        if (skipLineFeed && text.startsWith("\n")) text = text.slice(1);
        skipLineFeed = false;
        pending += text;
        let start = 0;
        for (const match of pending.matchAll(/\r\n|\r|\n/g)) {
            const line = pending.slice(start, match.index);
            for (let offset = 0; offset < line.length; offset += maxLineLength) {
                onLine(line.slice(offset, offset + maxLineLength));
            }
            if (!line) onLine("");
            start = match.index + match[0].length;
            skipLineFeed = match[0] === "\r" && start === pending.length;
        }
        pending = pending.slice(start);
        while (pending.length >= maxLineLength) {
            onLine(pending.slice(0, maxLineLength));
            pending = pending.slice(maxLineLength);
        }
    };

    return {
        push(chunk) {
            if (!ended) consume(decoder.decode(chunk, { stream: true }));
        },
        flush() {
            if (ended) return;
            consume(decoder.decode());
            ended = true;
            if (pending) onLine(pending);
            pending = "";
        },
    };
}
