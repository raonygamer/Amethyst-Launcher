/** A short rolling window includes idle time and resets when a retry starts at byte zero. */
export class TransferRate {
    private samples: { bytes: number; time: number }[];
    constructor(now = Date.now()) { this.samples = [{ bytes: 0, time: now }]; }
    update(bytes: number, now = Date.now()): number {
        const last = this.samples.at(-1)!;
        if (bytes < last.bytes || now < last.time) this.samples = [{ bytes, time: now }];
        else this.samples.push({ bytes, time: now });
        while (this.samples.length > 2 && this.samples[1].time < now - 3000) this.samples.shift();
        const first = this.samples[0];
        return now > first.time ? Math.max(0, (bytes - first.bytes) * 1000 / (now - first.time)) : 0;
    }
}

export function formatBytes(bytes: number): string {
    const safe = Math.max(0, Number.isFinite(bytes) ? bytes : 0);
    const index = Math.min(3, Math.floor(Math.log2(Math.max(1, safe)) / 10));
    return `${(safe / 1024 ** index).toFixed(index ? 1 : 0)} ${["B", "KiB", "MiB", "GiB"][index]}`;
}
