import { requestJson, XboxHttpError } from "./XboxHttp.ts";
import { fetchOwnedGames } from "./XboxOwnedGames.ts";
import { execFile } from "node:child_process";
import { createConnection, type Socket } from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import type { XodusAccountSnapshot, XboxOwnedGames } from "../../shared/linux/XodusAccountTypes.ts";

const XML_MAGIC = 0x58445358;
const MAX_PAYLOAD_BYTES = 0xffff;
const MSA_REQUEST = "<MSATokenRequest><ClientId>000000004424da1f</ClientId><AllowUi>false</AllowUi><MSAFullTrust>true</MSAFullTrust></MSATokenRequest>";
const USER_AUTH = "https://user.auth.xboxlive.com/user/authenticate";
const XSTS_AUTH = "https://xsts.auth.xboxlive.com/xsts/authorize";
const PROFILE = "https://profile.xboxlive.com/users/batch/profile/settings";
const EMAIL_UNAVAILABLE = "The saved Microsoft account email is unavailable on this system.";

export function encodeXodusMessage(type: number, payload: Buffer): Buffer {
    if (!Number.isInteger(type) || type < 1 || type > 0xffff || payload.length > MAX_PAYLOAD_BYTES) {
        throw new Error("Invalid Xodus request.");
    }
    const frame = Buffer.alloc(8 + payload.length);
    frame.writeUInt32LE(XML_MAGIC, 0);
    frame.writeUInt16LE(type, 4);
    frame.writeUInt16LE(payload.length, 6);
    payload.copy(frame, 8);
    return frame;
}

/** Each exchange has an absolute deadline, including connect and fragmented reads. */
export function requestXodusMessage(
    socketPath: string,
    type: number,
    payload: Buffer,
    options: { timeoutMs?: number; connect?: (socketPath: string) => Socket } = {},
): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        let socket: Socket | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let complete = false;
        let received = Buffer.alloc(0);
        const finish = (value?: Buffer): void => {
            if (complete) return;
            complete = true;
            clearTimeout(timer);
            socket?.destroy();
            if (value === undefined) reject(new Error("Xodus did not return a valid response."));
            else resolve(value);
        };
        try {
            const frame = encodeXodusMessage(type, payload);
            socket = (options.connect ?? (target => createConnection(target)))(socketPath);
            timer = setTimeout(() => finish(), options.timeoutMs ?? 30_000);
            socket.on("error", () => finish());
            socket.on("close", () => finish());
            socket.on("end", () => finish());
            socket.on("connect", () => {
                try { socket?.write(frame); } catch { finish(); }
            });
            socket.on("data", (chunk: Buffer) => {
                if (complete) return;
                if (received.length + chunk.length > MAX_PAYLOAD_BYTES + 8) return finish();
                received = Buffer.concat([received, chunk]);
                if (received.length < 8) return;
                if (received.readUInt32LE(0) !== XML_MAGIC || received.readUInt16LE(4) !== type + 1) return finish();
                const expected = received.readUInt16LE(6) + 8;
                if (received.length > expected) return finish();
                if (received.length === expected) finish(received.subarray(8));
            });
        } catch {
            finish();
        }
    });
}

function decodeXmlText(value: string): string {
    if (value.includes("<")) throw new Error("Invalid Xodus token response.");
    return value.replace(/&([^;]+);|&/g, (_entity, name: string | undefined) => {
        const known: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
        if (name && Object.hasOwn(known, name)) return known[name];
        if (name && /^#(?:[0-9]+|x[0-9a-fA-F]+)$/.test(name)) {
            const point = name.startsWith("#x") ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
            if (point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)) return String.fromCodePoint(point);
        }
        throw new Error("Invalid Xodus token response.");
    });
}

/** Parse only the flat XML structure emitted by Xodus; no DTDs or external entities. */
export function parseXodusMsaToken(payload: Buffer): string | null {
    if (payload.length === 0) return null;
    const xml = new TextDecoder("utf-8", { fatal: true }).decode(payload).trim();
    const root = /^(?:<\?xml\s[^?]*\?>\s*)?<MSATokenResponse>([\s\S]*)<\/MSATokenResponse>$/.exec(xml);
    if (!root) throw new Error("Invalid Xodus token response.");
    const fields = new Map<string, string>();
    let rest = root[1].trim();
    while (rest) {
        const field = /^<(Token|Expiry|DeviceRps|DeviceExpiry)>([^<]*)<\/\1>/.exec(rest)
            ?? /^<(Token|Expiry|DeviceRps|DeviceExpiry)\s*\/>/.exec(rest);
        if (!field || fields.has(field[1])) throw new Error("Invalid Xodus token response.");
        fields.set(field[1], decodeXmlText(field[2] ?? ""));
        rest = rest.slice(field[0].length).trim();
    }
    const token = fields.get("Token");
    if (token === undefined) throw new Error("Invalid Xodus token response.");
    return token.trim() ? token : null;
}

function record(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown, max = 256): string | null {
    return typeof value === "string" && value.length > 0 && value.length <= max && !/\p{Cc}/u.test(value)
        ? value : null;
}

export function parseXodusEmailMetadata(raw: string): string | null {
    try {
        const email = text(record(JSON.parse(raw))?.username, 320);
        return email && /^[^\s@]+@[^\s@]+$/.test(email) ? email : null;
    } catch {
        return null;
    }
}

/** Only the non-token user metadata entry is queried. Never use the output-logging runner. */
export function readXodusEmail(execute: typeof execFile = execFile): Promise<string | null> {
    return new Promise(resolve => {
        execute("/usr/bin/secret-tool", ["lookup", "service", "Xodus Service", "username", "user-DA"], {
            encoding: "utf8", timeout: 3_000, killSignal: "SIGKILL", maxBuffer: 16 * 1024, windowsHide: true,
        }, (error, stdout) => resolve(error ? null : parseXodusEmailMetadata(stdout)));
    });
}

function avatar(value: unknown): string | null {
    const candidate = text(value, 4096);
    if (!candidate) return null;
    try {
        const url = new URL(candidate);
        const trusted = ["xboxlive.com", "xbox.com", "xboxservices.com"].some(host => url.hostname === host || url.hostname.endsWith(`.${host}`));
        if (!trusted || url.username || url.password || (url.port && url.port !== "443")) return null;
        if (url.protocol === "http:") url.protocol = "https:";
        return url.protocol === "https:" ? url.href : null;
    } catch {
        return null;
    }
}

const PROFILE_CACHE_MS = 60 * 60_000;
const PROFILE_BACKOFF_MS = 60 * 60_000;

function retryDelay(value: string | null, now: number): number {
    if (!value) return 0;
    const seconds = Number(value);
    const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
    return Number.isFinite(delay) ? Math.max(0, delay) : 0;
}

export interface XodusAccountDependencies {
    platform: string;
    home: string;
    runtime: string | undefined;
    request: typeof requestXodusMessage;
    fetch: typeof fetch;
    readEmail: () => Promise<string | null>;
    now: () => number;
}

/** Main-process only: responses contain display fields, never authentication credentials. */
export function createXodusAccountReader(overrides: Partial<XodusAccountDependencies> = {}): { (force?: boolean): Promise<XodusAccountSnapshot>; clearCache(): void; ownedGames(force?: boolean): Promise<XboxOwnedGames> } {
    const dependencies: XodusAccountDependencies = {
        platform: process.platform, home: homedir(), runtime: process.env.XDG_RUNTIME_DIR, request: requestXodusMessage,
        fetch: globalThis.fetch, readEmail: readXodusEmail, now: Date.now, ...overrides,
    };
    let inFlight: Promise<XodusAccountSnapshot> | null = null;
    let cachedProfile: { xuid: string; gamertag: string | null; avatarUrl: string | null; gamerscore?: number; accountTier?: string; tenure?: number; expires: number } | null = null;
    let libraryCache: { xuid: string; result: XboxOwnedGames; expires: number } | null = null;
    let libraryPending: Promise<XboxOwnedGames> | null = null;
    let cacheGeneration = 0;
    let profileRetryAt = 0;
    let profileFailures = 0;
    let profileFailureDetail: string | null = null;
    let identityCache: { msaToken: string; userToken: string; expires: number; xstsToken: string; uhs: string; xuid: string; gamertag: string | null } | null = null;
    const identity = async (msaToken: string, force: boolean): Promise<NonNullable<typeof identityCache>> => {
        if (!force && identityCache?.msaToken === msaToken && dependencies.now() < identityCache.expires) return identityCache;
        identityCache = null;
        const userAuth = record(await requestJson(dependencies.fetch, USER_AUTH, {
            RelyingParty: "http://auth.xboxlive.com", TokenType: "JWT",
            Properties: { AuthMethod: "RPS", SiteName: "user.auth.xboxlive.com", RpsTicket: msaToken },
        }));
        const userToken = text(userAuth?.Token, MAX_PAYLOAD_BYTES);
        if (!userToken) throw new Error("Xbox account lookup failed.");
        const xsts = record(await requestJson(dependencies.fetch, XSTS_AUTH, {
            RelyingParty: "http://xboxlive.com", TokenType: "JWT",
            Properties: { SandboxId: "RETAIL", UserTokens: [userToken] },
        }));
        const xstsToken = text(xsts?.Token, MAX_PAYLOAD_BYTES);
        const claims = record(xsts?.DisplayClaims)?.xui;
        const claim = Array.isArray(claims) ? record(claims[0]) : null;
        const uhs = text(claim?.uhs);
        const rawXuid = text(claim?.xid, 20);
        const xuid = rawXuid && /^[0-9]+$/.test(rawXuid) ? rawXuid : null;
        if (!xstsToken || !uhs || !xuid) throw new Error("Xbox account lookup failed.");
        const expiry = Date.parse(typeof xsts?.NotAfter === "string" ? xsts.NotAfter : "");
        identityCache = { msaToken, userToken, xstsToken, uhs, xuid, gamertag: text(claim?.gtg) ?? text(claim?.mgt),
            expires: Math.min(dependencies.now() + PROFILE_CACHE_MS, Number.isFinite(expiry) ? expiry : Infinity) };
        return identityCache;
    };
    const read = async (force: boolean): Promise<XodusAccountSnapshot> => {
        const snapshot: XodusAccountSnapshot = {
            service: dependencies.platform === "linux" ? "disconnected" : "unsupported",
            session: "unavailable", profile: null, detail: null, emailDetail: null, updatedAt: dependencies.now(),
        };
        if (dependencies.platform !== "linux") return snapshot;
        if (!dependencies.runtime) {
            snapshot.detail = "The desktop session has no XDG_RUNTIME_DIR for Xodus.";
            return snapshot;
        }
        const socketPath = path.join(dependencies.runtime, "xodus.sock");
        try {
            const ping = Buffer.from("amethyst-account");
            const pong = await dependencies.request(socketPath, 1, ping, { timeoutMs: 3_000 });
            if (!pong.equals(ping)) throw new Error("Invalid Xodus ping.");
            snapshot.service = "connected";
        } catch {
            snapshot.detail = "Xodus service is not reachable. Verify Xodus in Settings → Tools to start it.";
            return snapshot;
        }
        try {
            const msaToken = parseXodusMsaToken(await dependencies.request(socketPath, 3, Buffer.from(MSA_REQUEST)));
            if (!msaToken) {
                cachedProfile = null;
                identityCache = null;
                snapshot.detail = "Xodus is connected, but no usable account session was returned. Sign in with Xodus or try refreshing.";
                return snapshot;
            }
            const { xstsToken, uhs, xuid, gamertag } = await identity(msaToken, force);
            snapshot.session = "signed_in";
            snapshot.profile = { gamertag, avatarUrl: null, email: null, xuid };
            if (cachedProfile?.xuid !== xuid) cachedProfile = null;
            if (cachedProfile) {
                snapshot.profile.gamertag = cachedProfile.gamertag ?? snapshot.profile.gamertag;
                snapshot.profile.avatarUrl = cachedProfile.avatarUrl;
                snapshot.profile.gamerscore = cachedProfile.gamerscore;
                snapshot.profile.accountTier = cachedProfile.accountTier;
                snapshot.profile.tenure = cachedProfile.tenure;
            }
            const now = dependencies.now();
            if (!force && now < profileRetryAt) {
                snapshot.detail = profileFailureDetail;
            } else if (force || !cachedProfile || now >= cachedProfile.expires) try {
                const data = record(await requestJson(dependencies.fetch, PROFILE, {
                    userIds: [xuid], settings: ["Gamertag", "GameDisplayPicRaw", "Gamerscore", "AccountTier", "TenureLevel"],
                }, `XBL3.0 x=${uhs};${xstsToken}`));
                const users = data?.profileUsers;
                const user = Array.isArray(users) ? users.map(record).find(value => value?.id === xuid) : null;
                if (!Array.isArray(user?.settings)) throw new Error("Xbox profile unavailable.");
                for (const setting of user.settings.map(record)) {
                    if (setting?.id === "Gamertag") snapshot.profile.gamertag = text(setting.value) ?? snapshot.profile.gamertag;
                    if (setting?.id === "GameDisplayPicRaw") snapshot.profile.avatarUrl = avatar(setting.value);
                    if (setting?.id === "AccountTier") snapshot.profile.accountTier = text(setting.value) ?? undefined;
                    if (setting?.id === "Gamerscore" || setting?.id === "TenureLevel") {
                        const number = typeof setting.value === "string" && /^\d+$/.test(setting.value) ? Number(setting.value) : NaN;
                        if (Number.isSafeInteger(number)) {
                            if (setting.id === "Gamerscore") snapshot.profile.gamerscore = number;
                            else snapshot.profile.tenure = number;
                        }
                    }
                }
                cachedProfile = { xuid, gamertag: snapshot.profile.gamertag, avatarUrl: snapshot.profile.avatarUrl,
                    gamerscore: snapshot.profile.gamerscore, accountTier: snapshot.profile.accountTier, tenure: snapshot.profile.tenure,
                    expires: dependencies.now() + PROFILE_CACHE_MS };
                profileRetryAt = 0;
                profileFailures = 0;
                profileFailureDetail = null;
            } catch (error) {
                const limited = error instanceof XboxHttpError && error.status === 429;
                const delay = limited
                    ? Math.max(Math.min(PROFILE_BACKOFF_MS * 2 ** Math.min(profileFailures++, 4), 24 * 60 * 60_000),
                        retryDelay(error.retryAfter, dependencies.now()))
                    : PROFILE_BACKOFF_MS;
                profileRetryAt = dependencies.now() + delay;
                profileFailureDetail = limited
                    ? `Signed in through Xodus. Xbox has rate-limited profile updates (HTTP 429). Retrying after ${new Date(profileRetryAt).toLocaleTimeString()}.`
                    : `Signed in through Xodus. Xbox profile details could not be refreshed${error instanceof XboxHttpError ? ` (HTTP ${error.status})` : ""}. Retrying automatically.`;
                snapshot.detail = profileFailureDetail;
            }
            try {
                const email = await dependencies.readEmail();
                snapshot.profile.email = email && /^[^\s@]+@[^\s@]+$/.test(email) && email.length <= 320 ? email : null;
            } catch {
                // A missing helper, locked keyring or absent metadata never hides the Xbox session.
            }
            snapshot.emailDetail = snapshot.profile.email ? null : EMAIL_UNAVAILABLE;
        } catch {
            snapshot.detail = "Xodus is connected, but the account session could not be verified. Check your connection or sign in with Xodus, then refresh.";
        }
        snapshot.updatedAt = dependencies.now();
        return snapshot;
    };
    const ownedGames = async (force = false): Promise<XboxOwnedGames> => {
        const generation = cacheGeneration;
        const snapshot = await read(false);
        const current = identityCache;
        if (snapshot.session !== "signed_in" || !current) {
            libraryCache = null;
            return { games: [], status: "unavailable", detail: "Sign in through Xodus to view your owned games.", updatedAt: dependencies.now() };
        }
        if (!force && libraryCache?.xuid === current.xuid && dependencies.now() < libraryCache.expires) return libraryCache.result;
        let retry = PROFILE_CACHE_MS;
        let result: XboxOwnedGames;
        try {
            const xsts = record(await requestJson(dependencies.fetch, XSTS_AUTH, {
                RelyingParty: "http://licensing.xboxlive.com", TokenType: "JWT",
                Properties: { SandboxId: "RETAIL", UserTokens: [current.userToken] },
            }));
            const token = text(xsts?.Token, MAX_PAYLOAD_BYTES);
            const claims = record(xsts?.DisplayClaims)?.xui;
            // The licensing token exposes the user hash, but may omit the XUID.
            const claim = Array.isArray(claims) ? claims.map(record).find(c => c?.uhs === current.uhs
                && (c?.xid === undefined || c.xid === current.xuid)) : null;
            const uhs = text(claim?.uhs);
            if (!token || !uhs) throw new Error("Xbox inventory authorization unavailable.");
            const games = await fetchOwnedGames(dependencies.fetch, `XBL3.0 x=${uhs};${token}`);
            // A successful empty legacy inventory is not an account-wide ownership
            // answer. Modern Store purchases can be invisible to this token/endpoint.
            result = { games, status: games.length ? "available" : "unavailable", detail: games.length
                ? "Confirmed purchases returned by Xbox. This is a partial library; other Store purchases and shared games may not appear."
                : "Your owned-game library could not be retrieved. This does not mean you own no games.", updatedAt: dependencies.now() };
        } catch (error) {
            const status = error instanceof XboxHttpError ? error.status : null;
            if (error instanceof XboxHttpError) retry = Math.max(retry, retryDelay(error.retryAfter, dependencies.now()));
            result = { games: [], status: "unavailable", updatedAt: dependencies.now(), detail: status === 429
                ? "Xbox has rate-limited library updates. Try again later."
                : `Xbox could not return your owned games${status ? ` (HTTP ${status})` : ""}. This does not mean your library is empty.` };
        }
        if (generation === cacheGeneration && identityCache?.xuid === current.xuid) libraryCache = { xuid: current.xuid, result, expires: dependencies.now() + retry };
        return result;
    };
    return Object.assign((force = false) => {
        if (!inFlight) inFlight = read(force).finally(() => { inFlight = null; });
        return inFlight;
    }, { ownedGames: (force = false) => {
        if (!libraryPending) libraryPending = ownedGames(force).finally(() => { libraryPending = null; });
        return libraryPending;
    }, clearCache: () => {
        cacheGeneration++;
        libraryCache = null;
        cachedProfile = null;
        identityCache = null;
        profileRetryAt = 0;
        profileFailures = 0;
        profileFailureDetail = null;
    } });
}

export const getXodusAccountSnapshot = createXodusAccountReader();
