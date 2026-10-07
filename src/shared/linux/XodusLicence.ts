import { run } from "../diagnostics/ProcessRunner.ts";
import type { Execute } from "./LinuxBuild.ts";

const require = (globalThis as unknown as { require: NodeRequire }).require;
const fs = require("fs") as typeof import("fs");
const os = require("os") as typeof import("os");
const path = require("path") as typeof import("path");

function guid(bytes: Buffer): string {
    return [bytes.readUInt32LE(0).toString(16).padStart(8, "0"),
        bytes.readUInt16LE(4).toString(16).padStart(4, "0"),
        bytes.readUInt16LE(6).toString(16).padStart(4, "0"),
        bytes.subarray(8, 10).toString("hex"), bytes.subarray(10, 16).toString("hex")].join("-");
}

/** Xodus's XvdFile::content_id uses the header VDUUID, not the download URL's UUID. */
export async function readXvdContentId(archive: string): Promise<string> {
    const file = await fs.promises.open(archive, "r");
    try {
        const header = Buffer.alloc(0x230);
        const { bytesRead } = await file.read(header, 0, header.length, 0);
        return xvdContentId(header.subarray(0, bytesRead));
    } finally { await file.close(); }
}

/** Accepts a local or bounded remote XVD header, never a catalogue UUID. */
export function xvdContentId(header: Buffer): string {
    if (header.length < 0x230 || header.toString("ascii", 0x200, 0x208) !== "msft-xvd") {
        throw new Error("Cannot request a licence: the archive has an invalid XVD header.");
    }
    const id = guid(header.subarray(0x220, 0x230));
    if (id === "00000000-0000-0000-0000-000000000000") throw new Error("The archive has no content ID.");
    return id;
}

/** CLI output can contain credentials; consume only its private binary CIK files. */
export async function acquireXodusCiks(executable: string, archive: string, amethystData: string, execute: Execute = run): Promise<Record<string, string>> {
    return acquireXodusContentCiks(executable, await readXvdContentId(archive), amethystData, execute);
}

class XodusLicenceError extends Error {
    readonly retryable: boolean;
    constructor(message: string, retryable = false) {
        super(message);
        this.retryable = retryable;
    }
}

/** Match known failures, but never include raw output: even panic messages can contain tokens. */
function licenceFailure(output: string, code: number): XodusLicenceError {
    if (/not entitled to this content/i.test(output)) {
        return new XodusLicenceError("This Xodus account does not own Minecraft or have an active entitlement for this version. Sign in with an account that owns it before downloading or decrypting the game.");
    }
    if (/Unable to initialize credentials|PlatformFailure|IsLocked|org\.freedesktop\.(?:DBus|Secret)\.Error/i.test(output)) {
        return new XodusLicenceError("Xodus could not access the desktop keyring. Unlock it in your Passwords and Keys or Wallet manager, then try again.");
    }
    if (/\b429\b|too many requests/i.test(output)) {
        return new XodusLicenceError("Microsoft has rate-limited the Xodus licence request. Wait a few minutes before trying again.");
    }
    if (/\b(?:401|403)\b|Invalid STS token|Unspported user token|Unsupported (?:user )?token|Failed to get exchange MS token|\bNotFound\b|\bNoEntry\b/i.test(output)) {
        return new XodusLicenceError("Xodus could not authenticate the licence request. Sign in again with Xodus in the Account tab, then retry.");
    }
    if (/error decoding response body|LicenseContentResponse|could not parse base64 game SPLicense/i.test(output)) {
        return new XodusLicenceError("Xodus could not read Microsoft's licence response. Try again; if this persists, update Xodus in Settings → Tools. This response does not confirm whether you own the game.", true);
    }
    if (/error sending request|request error|dns error|connection (?:refused|reset|closed)|network is unreachable|operation timed out/i.test(output)) {
        return new XodusLicenceError("Xodus could not reach Microsoft's licensing service. Check your connection and try again.", true);
    }
    if (/Failed to get ms user token/i.test(output)) {
        return new XodusLicenceError("Xodus could not refresh the Microsoft login for licensing. Sign in again with Xodus in the Account tab, then retry.");
    }
    if (/Failed to (?:get device creds|auth device|parse SPLicense|save device)/i.test(output)) {
        return new XodusLicenceError("Xodus could not prepare its device credentials. Unlock your desktop keyring and verify Xodus in Settings → Tools, then retry.");
    }
    return new XodusLicenceError(`Xodus could not obtain a game licence (exit ${code}). Verify Xodus in Settings → Tools and sign in again in the Account tab. This failure does not confirm whether you own the game.`);
}

export async function acquireXodusContentCiks(executable: string, contentId: string, _amethystData: string, execute: Execute = run): Promise<Record<string, string>> {
    if (!/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(contentId)) throw new Error("Invalid game content ID.");
    for (let attempt = 0; ; attempt++) {
        try {
            return await acquireContentCiksAttempt(executable, contentId, execute);
        } catch (error) {
            if (attempt !== 0 || !(error instanceof XodusLicenceError) || !error.retryable) throw error;
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }
}

async function acquireContentCiksAttempt(executable: string, contentId: string, execute: Execute): Promise<Record<string, string>> {
    // A retry must never accept partial key files left by the failed attempt.
    const folder = await fs.promises.mkdtemp(path.join(os.tmpdir(), "amethyst-ciks-"));
    try {
        const env: NodeJS.ProcessEnv = { XODUS_LOG: "off" };
        const result = await execute(executable, ["license", contentId, folder], { env, cwd: os.homedir(), timeoutMs: 120_000 });
        if (result.spawnError) throw new Error("Could not start Xodus. Verify Xodus in Settings → Tools.");
        if (result.timedOut) throw new Error("The Xodus licence request timed out. Check your connection and try again.");
        if (result.code !== 0) throw licenceFailure(result.output, result.code);
        const keys: Record<string, string> = {};
        for (const name of await fs.promises.readdir(folder)) {
            if (!/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}\.cik$/i.test(name)) continue;
            const file = await fs.promises.open(path.join(folder, name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
            try {
                const stat = await file.stat();
                if (!stat.isFile() || stat.size !== 48) throw new Error("Xodus returned an invalid CIK file.");
                const bytes = await file.readFile();
                const id = guid(bytes.subarray(0, 16));
                if (`${id}.cik` !== name.toLowerCase()) throw new Error("Xodus returned a mismatched CIK identifier.");
                // XVDTool's -cikdata loads a complete .cik record: little-endian GUID + key.
                keys[id] = bytes.toString("hex");
            } finally { await file.close(); }
        }
        if (!Object.keys(keys).length) throw new Error("Xodus returned no CIKs for this game licence.");
        return keys;
    } finally { await fs.promises.rm(folder, { recursive: true, force: true }); }
}
