import assert from "node:assert/strict";
import { it } from "node:test";
import { fetchOwnedGames, parseOwnedGame } from "../src/main/linux/XboxOwnedGames.ts";
import { createXodusAccountReader } from "../src/main/linux/XodusAccount.ts";

const item = { productId: "9TESTGAME001", itemType: "GameV2", trial: false, state: "Enabled", endDate: "9999-12-31T00:00:00Z", obtained: "2024-01-01T00:00:00Z" };

it("keeps permanent game entitlements, excluding trials, subscriptions, expired rights and DLC", () => {
    assert.equal(parseOwnedGame(item)?.productId, item.productId);
    for (const change of [{ trial: true }, { trial: undefined }, { itemType: "Subscription" }, { itemType: "GameContent" }, { state: "Expired" }, { endDate: "2028-01-01T00:00:00Z" }]) {
        assert.equal(parseOwnedGame({ ...item, ...change }), null);
    }
});

it("paginates inventory without forwarding credentials to catalog or response URLs", async () => {
    const calls: URL[] = [];
    const games = await fetchOwnedGames(async (input, init) => {
        const url = new URL(String(input));
        calls.push(url);
        if (url.hostname === "displaycatalog.mp.microsoft.com") {
            assert.equal(new Headers(init?.headers).has("Authorization"), false);
            return Response.json({ Products: [{ ProductId: item.productId, LocalizedProperties: [{ ProductTitle: "Example Game", Images: [{ ImagePurpose: "Poster", Uri: "//store-images.s-microsoft.com/image/test" }] }] }] });
        }
        assert.equal(url.hostname, "inventory.xboxlive.com");
        assert.equal(new Headers(init?.headers).get("Authorization"), "PRIVATE_AUTH");
        assert.equal(init?.method, "GET");
        if (!url.searchParams.has("continuationToken")) return Response.json({ items: [item], pagingInfo: { continuationToken: "https://untrusted.test/?token=secret" } });
        assert.equal(url.searchParams.get("continuationToken"), "https://untrusted.test/?token=secret");
        return Response.json({ items: [item, { ...item, productId: "trial", trial: true }], pagingInfo: {} });
    }, "PRIVATE_AUTH");
    assert.equal(calls.length, 3);
    assert.equal(games.length, 1);
    assert.equal(games[0].title, "Example Game");
    assert.equal(games[0].imageUrl, "https://store-images.s-microsoft.com/image/test");
    assert.equal(JSON.stringify(games).includes("PRIVATE_AUTH"), false);
});

it("uses licensing authorization and caches owned games per account for an hour, with real manual refresh", async () => {
    let now = 100, inventory = 0, xuid = "123", fail = false;
    const reader = createXodusAccountReader({ platform: "linux", home: "/unused", runtime: "/unused", now: () => now, readEmail: async () => null,
        request: async (_socket, type, payload) => type === 1 ? payload : Buffer.from(`<MSATokenResponse><Token>MSA_${xuid}</Token></MSATokenResponse>`),
        fetch: async (input, init) => {
            const url = String(input);
            if (url.includes("user.auth")) return Response.json({ Token: "USER_TOKEN" });
            if (url.includes("xsts.auth")) {
                const body = JSON.parse(String(init?.body));
                assert.ok(["http://xboxlive.com", "http://licensing.xboxlive.com"].includes(body.RelyingParty));
                const licensing = body.RelyingParty.includes("licensing");
                return Response.json({ Token: licensing ? "INVENTORY_TOKEN" : "PROFILE_TOKEN", DisplayClaims: { xui: [licensing ? { uhs: "hash" } : { xid: xuid, uhs: "hash" }] } });
            }
            if (url.includes("profile.xboxlive")) return Response.json({ profileUsers: [{ id: xuid, settings: [{ id: "Gamerscore", value: "12345" }, { id: "TenureLevel", value: "5" }, { id: "AccountTier", value: "Gold" }] }] });
            if (url.includes("inventory.xboxlive")) {
                inventory++;
                assert.equal(new Headers(init?.headers).get("Authorization"), "XBL3.0 x=hash;INVENTORY_TOKEN");
                return fail ? new Response("PRIVATE_ERROR", { status: 403 }) : Response.json({ items: [], pagingInfo: {} });
            }
            throw Error("unexpected network request");
        },
    });
    const snapshot = await reader();
    assert.equal(snapshot.profile?.gamerscore, 12345);
    assert.equal(snapshot.profile?.tenure, 5);
    assert.equal(snapshot.profile?.accountTier, "Gold");
    const empty = await reader.ownedGames();
    assert.equal(empty.status, "unavailable", "empty legacy inventory must not be reported as zero owned games");
    assert.match(empty.detail!, /does not mean you own no games/);
    await reader.ownedGames(); assert.equal(inventory, 1);
    await reader.ownedGames(true); assert.equal(inventory, 2);
    now += 60 * 60_000 + 1;
    await reader.ownedGames(); assert.equal(inventory, 3);
    xuid = "456";
    await reader.ownedGames(); assert.equal(inventory, 4);
    fail = true;
    const result = await reader.ownedGames(true);
    assert.equal(result.status, "unavailable");
    assert.match(result.detail!, /HTTP 403/);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_ERROR|INVENTORY_TOKEN/);
});
