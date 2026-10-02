import assert from "node:assert/strict";
import type { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { describe, it } from "node:test";
import {
    createXodusAccountReader,
    encodeXodusMessage,
    parseXodusEmailMetadata,
    parseXodusMsaToken,
    readXodusEmail,
    requestXodusMessage,
    type XodusAccountDependencies,
} from "../src/main/linux/XodusAccount.ts";

class FakeSocket extends EventEmitter {
    destroyed = false;
    writes: Buffer[] = [];
    private onWrite: (socket: FakeSocket, frame: Buffer) => void;
    constructor(onWrite: (socket: FakeSocket, frame: Buffer) => void) {
        super();
        this.onWrite = onWrite;
    }
    write(frame: Buffer): boolean {
        this.writes.push(frame);
        queueMicrotask(() => this.onWrite(this, frame));
        return true;
    }
    destroy(): void { this.destroyed = true; }
}

function connection(onWrite: (socket: FakeSocket, frame: Buffer) => void): { connect: () => Socket; socket: FakeSocket } {
    const socket = new FakeSocket(onWrite);
    return {
        socket,
        connect: () => {
            queueMicrotask(() => socket.emit("connect"));
            return socket as unknown as Socket;
        },
    };
}

describe("Xodus XML IPC", () => {
    it("writes the native little-endian header and reassembles fragmented responses", async () => {
        const reply = Buffer.from("🎮 ping");
        const { socket, connect } = connection(socket => {
            const frame = encodeXodusMessage(2, reply);
            for (const byte of frame) socket.emit("data", Buffer.from([byte]));
        });
        assert.deepEqual(await requestXodusMessage("/test/xodus.sock", 1, reply, { connect }), reply);
        assert.equal(socket.writes[0].readUInt32LE(0), 0x58445358);
        assert.equal(socket.writes[0].readUInt16LE(4), 1);
        assert.equal(socket.writes[0].readUInt16LE(6), reply.length);
        assert.equal(socket.destroyed, true);
    });

    it("accepts an empty framed token response", async () => {
        const { connect } = connection(socket => socket.emit("data", encodeXodusMessage(4, Buffer.alloc(0))));
        assert.equal((await requestXodusMessage("/test/xodus.sock", 3, Buffer.alloc(0), { connect })).length, 0);
    });

    it("rejects bad magic, wrong message types, excess bytes, and oversized frames", async () => {
        const badMagic = encodeXodusMessage(2, Buffer.from("reply"));
        badMagic.writeUInt32LE(0, 0);
        for (const response of [badMagic, encodeXodusMessage(4, Buffer.from("reply")), Buffer.alloc(0x10008), Buffer.concat([encodeXodusMessage(2, Buffer.alloc(0)), Buffer.from("excess")])]) {
            const { socket, connect } = connection(socket => socket.emit("data", response));
            await assert.rejects(requestXodusMessage("/test/xodus.sock", 1, Buffer.alloc(0), { connect }), /valid response/);
            assert.equal(socket.destroyed, true);
        }
        assert.throws(() => encodeXodusMessage(3, Buffer.alloc(0x10000)), /Invalid Xodus request/);
    });

    it("rejects incomplete closes, transport errors and stalled requests without leaking errors", async () => {
        for (const event of ["end", "close", "error"]) {
            const { socket, connect } = connection(socket => {
                socket.emit("data", Buffer.from([0x58]));
                socket.emit(event, Error("private transport error contents"));
            });
            await assert.rejects(requestXodusMessage("/test/xodus.sock", 1, Buffer.alloc(0), { connect }), error => {
                assert.equal(String(error).includes("private transport"), false);
                return true;
            });
            assert.equal(socket.destroyed, true);
        }
        const { socket, connect } = connection(() => {});
        await assert.rejects(requestXodusMessage("/test/xodus.sock", 1, Buffer.alloc(0), { connect, timeoutMs: 5 }));
        assert.equal(socket.destroyed, true);
    });

    it("parses token text entities while rejecting malformed XML and external entities", () => {
        assert.equal(parseXodusMsaToken(Buffer.from('<MSATokenResponse><Token>d=one&amp;two&#x2b;&#43;</Token><Expiry>42</Expiry><DeviceRps/><DeviceExpiry>0</DeviceExpiry></MSATokenResponse>')), "d=one&two++");
        assert.equal(parseXodusMsaToken(Buffer.alloc(0)), null);
        assert.equal(parseXodusMsaToken(Buffer.from("<MSATokenResponse><Token/></MSATokenResponse>")), null);
        for (const value of [
            '<!DOCTYPE MSATokenResponse [<!ENTITY leak SYSTEM "file:///test">]><MSATokenResponse><Token>&leak;</Token></MSATokenResponse>',
            "<MSATokenResponse><Token>one</Token><Token>two</Token></MSATokenResponse>",
            "<MSATokenResponse><Token>one&unknown;</Token></MSATokenResponse>",
            "<MSATokenResponse><Token><nested/></Token></MSATokenResponse>",
        ]) assert.throws(() => parseXodusMsaToken(Buffer.from(value)));
    });
});

const MSA_TOKEN = "d=fixture-private-msa";
const USER_TOKEN = "fixture-private-user-token";
const XSTS_TOKEN = "fixture-private-xsts-token";
const XUID = "2533274791381930";
const msaResponse = Buffer.from(`<MSATokenResponse><Token>${MSA_TOKEN}</Token><Expiry>42</Expiry><DeviceRps/><DeviceExpiry>0</DeviceExpiry></MSATokenResponse>`);

function fixture(overrides: Partial<XodusAccountDependencies> = {}): {
    read: ReturnType<typeof createXodusAccountReader>;
    calls: { url: string; init: RequestInit }[];
} {
    const calls: { url: string; init: RequestInit }[] = [];
    const read = createXodusAccountReader({ runtime: "/run/user/test",
        platform: "linux", home: "/test/home", now: () => 123,
        request: async (socket, type, payload) => {
            assert.equal(socket, "/run/user/test/xodus.sock");
            if (type === 1) return payload;
            assert.equal(type, 3);
            assert.match(payload.toString(), /<MSAFullTrust>true<\/MSAFullTrust>/);
            assert.match(payload.toString(), /<AllowUi>false<\/AllowUi>/);
            return msaResponse;
        },
        readEmail: async () => "person@example.test",
        fetch: async (input, init) => {
            const url = String(input);
            calls.push({ url, init: init! });
            assert.equal(init?.redirect, "error");
            assert.ok(init?.signal);
            if (url.includes("user.auth")) return Response.json({ Token: USER_TOKEN });
            if (url.includes("xsts.auth")) return Response.json({ Token: XSTS_TOKEN, DisplayClaims: { xui: [{ uhs: "123", xid: XUID, gtg: "TokenGamertag" }] } });
            return Response.json({ profileUsers: [{ id: XUID, settings: [
                { id: "Gamertag", value: "CurrentGamertag" },
                { id: "GameDisplayPicRaw", value: "http://images-eds.xboxlive.com/image?test=1" },
            ] }] });
        },
        ...overrides,
    });
    return { read, calls };
}

describe("Xodus account display data", () => {
    it("returns the current identity and avatar while keeping every token in main", async () => {
        const { read, calls } = fixture();
        const snapshot = await read();
        assert.deepEqual(snapshot, {
            service: "connected", session: "signed_in", updatedAt: 123, detail: null, emailDetail: null,
            profile: { gamertag: "CurrentGamertag", avatarUrl: "https://images-eds.xboxlive.com/image?test=1", email: "person@example.test", xuid: XUID },
        });
        for (const token of [MSA_TOKEN, USER_TOKEN, XSTS_TOKEN]) assert.equal(JSON.stringify(snapshot).includes(token), false);
        assert.equal(JSON.parse(String(calls[0].init.body)).Properties.RpsTicket, MSA_TOKEN);
        assert.deepEqual(JSON.parse(String(calls[1].init.body)).Properties.UserTokens, [USER_TOKEN]);
        assert.equal(new Headers(calls[2].init.headers).get("Authorization"), `XBL3.0 x=123;${XSTS_TOKEN}`);
        assert.equal(new Headers(calls[2].init.headers).get("x-xbl-contract-version"), "2");
        assert.deepEqual(JSON.parse(String(calls[2].init.body)), { userIds: [XUID], settings: ["Gamertag", "GameDisplayPicRaw"] });
    });

    it("does no IPC, keyring or network work on other platforms", async () => {
        const unexpected = async (): Promise<never> => { throw Error("Unexpected external access"); };
        for (const platform of ["win32", "darwin"]) {
            const { read } = fixture({ platform, request: unexpected, fetch: unexpected, readEmail: unexpected });
            assert.equal((await read()).service, "unsupported");
        }
    });

    it("distinguishes service disconnection from unavailable account sessions", async () => {
        const disconnected = fixture({ request: async () => { throw Error(MSA_TOKEN); } });
        const result = await disconnected.read();
        assert.equal(result.service, "disconnected");
        assert.equal(result.profile, null);
        assert.equal(JSON.stringify(result).includes(MSA_TOKEN), false);
        const unavailable = fixture({ request: async (_socket, type, payload) => type === 1 ? payload : Buffer.alloc(0) });
        const empty = await unavailable.read();
        assert.equal(empty.service, "connected");
        assert.equal(empty.session, "unavailable");
        assert.equal(empty.profile, null);
        assert.equal(unavailable.calls.length, 0);
    });

    it("sanitizes network errors and oversized authentication responses", async () => {
        for (const fetch of [
            async (): Promise<Response> => { throw Error(MSA_TOKEN); },
            async (): Promise<Response> => new Response(MSA_TOKEN, { status: 401 }),
            async (): Promise<Response> => new Response("x".repeat(512 * 1024 + 1)),
        ]) {
            const { read } = fixture({ fetch });
            const result = await read();
            assert.equal(result.service, "connected");
            assert.equal(result.session, "unavailable");
            assert.equal(result.profile, null);
            assert.equal(JSON.stringify(result).includes(MSA_TOKEN), false);
        }
    });

    it("retains verified gamertag when profile lookup or optional email lookup fails", async () => {
        let request = 0;
        const { read } = fixture({
            fetch: async () => {
                if (++request === 1) return Response.json({ Token: USER_TOKEN });
                if (request === 2) return Response.json({ Token: XSTS_TOKEN, DisplayClaims: { xui: [{ uhs: "123", xid: XUID, gtg: "CurrentGamertag" }] } });
                throw Error(XSTS_TOKEN);
            },
            readEmail: async () => { throw Error("locked keyring"); },
        });
        const snapshot = await read();
        assert.equal(snapshot.session, "signed_in");
        assert.equal(snapshot.profile?.gamertag, "CurrentGamertag");
        assert.equal(snapshot.profile?.email, null);
        assert.ok(snapshot.emailDetail);
        assert.equal(JSON.stringify(snapshot).includes(XSTS_TOKEN), false);
    });

    it("never reuses a profile after the account changes or loses its session", async () => {
        let active = true;
        const { read } = fixture({ request: async (_path, type, payload) => type === 1 ? payload : active ? msaResponse : Buffer.alloc(0) });
        const pending = read();
        assert.equal(read(), pending);
        assert.equal((await pending).session, "signed_in");
        active = false;
        const next = await read();
        assert.equal(next.session, "unavailable");
        assert.equal(next.profile, null);
    });

    it("does not display another user's profile or an unsafe avatar URL", async () => {
        for (const [profileId, avatarUrl] of [["other-user", "https://images-eds.xboxlive.com/image"], [XUID, "file:///private"], [XUID, "https://127.0.0.1/private"], [XUID, "https://xboxlive.com.attacker.test/image"]]) {
            let request = 0;
            const { read } = fixture({ fetch: async () => {
                if (++request === 1) return Response.json({ Token: USER_TOKEN });
                if (request === 2) return Response.json({ Token: XSTS_TOKEN, DisplayClaims: { xui: [{ uhs: "123", xid: XUID, gtg: "VerifiedGamertag" }] } });
                return Response.json({ profileUsers: [{ id: profileId, settings: [{ id: "Gamertag", value: "OtherGamertag" }, { id: "GameDisplayPicRaw", value: avatarUrl }] }] });
            } });
            const snapshot = await read();
            assert.equal(snapshot.profile?.avatarUrl, null);
            if (profileId !== XUID) assert.equal(snapshot.profile?.gamertag, "VerifiedGamertag");
        }
    });

    it("limits the email helper to one metadata entry with bounded execution and no shell", async () => {
        let calls = 0;
        const execute = (command: string, args: string[], options: Record<string, unknown>, callback: (error: Error | null, stdout: string, stderr: string) => void): unknown => {
            calls++;
            assert.equal(command, "/usr/bin/secret-tool");
            assert.deepEqual(args, ["lookup", "service", "Xodus Service", "username", "user-DA"]);
            assert.equal(options.timeout, 3_000);
            assert.equal(options.maxBuffer, 16 * 1024);
            assert.equal(options.killSignal, "SIGKILL");
            assert.equal(options.shell, undefined);
            callback(null, JSON.stringify({ puid: "fixture", username: "person@example.test" }), "");
            return {};
        };
        assert.equal(await readXodusEmail(execute as unknown as typeof execFile), "person@example.test");
        assert.equal(calls, 1);
    });

    it("only extracts a valid login email from user metadata", () => {
        assert.equal(parseXodusEmailMetadata(JSON.stringify({ username: "person@example.test", puid: "fixture" })), "person@example.test");
        for (const value of ["malformed", JSON.stringify({ username: "phone-number" }), JSON.stringify({ username: "a@example.test\nprivate" }), JSON.stringify({ token: MSA_TOKEN })]) {
            assert.equal(parseXodusEmailMetadata(value), null);
        }
    });
});

it("caches profile data, preserves avatars during 429 backoff, and honors Retry-After", async () => {
    let now = 1_000, profiles = 0;
    const { read } = fixture({ now: () => now, fetch: async url => {
        if (String(url).includes("user.auth")) return Response.json({ Token: USER_TOKEN });
        if (String(url).includes("xsts.auth")) return Response.json({ Token: XSTS_TOKEN, DisplayClaims: { xui: [{ uhs: "123", xid: XUID }] } });
        if (++profiles > 1) return new Response(XSTS_TOKEN, { status: 429, headers: { "Retry-After": "7200" } });
        return Response.json({ profileUsers: [{ id: XUID, settings: [{ id: "GameDisplayPicRaw", value: "https://images-eds.xboxlive.com/image" }] }] });
    } });
    const first = await read();
    assert.ok(first.profile?.avatarUrl);
    now += 30_000;
    await read();
    assert.equal(profiles, 1, "polling does not refetch fresh profiles");
    now += 60 * 60_000;
    const limited = await read();
    assert.equal(profiles, 2);
    assert.equal(limited.session, "signed_in");
    assert.equal(limited.profile?.avatarUrl, first.profile?.avatarUrl);
    assert.match(limited.detail!, /rate-limited.*429/);
    assert(!JSON.stringify(limited).includes(XSTS_TOKEN));
    now += 7_199_999;
    assert.match((await read()).detail!, /429/);
    assert.equal(profiles, 2);
    now++;
    await read();
    assert.equal(profiles, 3);
});

it("backs off without Retry-After and never shows a previous account's cached avatar", async () => {
    let now = 0, profiles = 0, xuid = XUID;
    const { read } = fixture({ now: () => now, request: async (_path, type, payload) => type === 1 ? payload : Buffer.from(`<MSATokenResponse><Token>d=${xuid}</Token></MSATokenResponse>`), fetch: async url => {
        if (String(url).includes("user.auth")) return Response.json({ Token: USER_TOKEN });
        if (String(url).includes("xsts.auth")) return Response.json({ Token: XSTS_TOKEN, DisplayClaims: { xui: [{ uhs: "123", xid: xuid }] } });
        if (++profiles > 1) return new Response(null, { status: 429 });
        return Response.json({ profileUsers: [{ id: XUID, settings: [{ id: "GameDisplayPicRaw", value: "https://images-eds.xboxlive.com/image" }] }] });
    } });
    assert.ok((await read()).profile?.avatarUrl);
    now += 60 * 60_000;
    await read();
    xuid = "2533274791381931";
    assert.equal((await read()).profile?.avatarUrl, null);
    now += 3_599_999;
    await read();
    assert.equal(profiles, 2);
    now++;
    await read();
    assert.equal(profiles, 3);
    now += 7_199_999;
    await read();
    assert.equal(profiles, 3, "repeated throttling doubles the cooldown");
    now++;
    await read();
    assert.equal(profiles, 4);
});

it("manual refresh bypasses caches and cooldown while automatic calls reuse cached identity", async () => {
    let profiles = 0, auth = 0;
    const { read } = fixture({ fetch: async url => {
        if (String(url).includes("user.auth")) { auth++; return Response.json({ Token: USER_TOKEN }); }
        if (String(url).includes("xsts.auth")) return Response.json({ Token: XSTS_TOKEN, DisplayClaims: { xui: [{ uhs: "123", xid: XUID }] } });
        profiles++;
        if (profiles === 2) return new Response(null, { status: 429 });
        return Response.json({ profileUsers: [{ id: XUID, settings: [{ id: "Gamertag", value: `Player${profiles}` }] }] });
    } });
    assert.equal((await read()).profile?.gamertag, "Player1");
    await read();
    assert.equal(auth, 1);
    assert.equal(profiles, 1);
    assert.match((await read(true)).detail!, /429/);
    assert.equal(auth, 2);
    await read();
    assert.equal(profiles, 2, "automatic retries respect rate limits");
    const refreshed = await read(true);
    assert.equal(auth, 3);
    assert.equal(profiles, 3, "manual retry makes a real request");
    assert.equal(refreshed.profile?.gamertag, "Player3");
    assert.equal(refreshed.detail, null);
});
