import type { XboxOwnedGame } from "../../shared/linux/XodusAccountTypes.ts";
import { requestJson } from "./XboxHttp.ts";

const INVENTORY = "https://inventory.xboxlive.com/users/me/inventory";
const GAME_TYPES = new Set([
    "Game",
    "GameV2",
    "ArcadeGame",
    "XboxOriginalGame",
    "MetroGame",
    "MobileGame",
    "XnaCommunityGame",
]);
const object = (v: unknown): Record<string, unknown> | null =>
    v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const text = (v: unknown): string | null =>
    typeof v === "string" && v.length > 0 && v.length < 2048 && !/\p{Cc}/u.test(v) ? v : null;

export function parseOwnedGame(value: unknown): XboxOwnedGame | null {
    const item = object(value);
    if (!item || !GAME_TYPES.has(String(item.itemType)) || item.trial !== false || item.state !== "Enabled")
        return null;
    // Time-limited access (including subscription benefits) is not permanent ownership.
    if (item.endDate) {
        const end = Date.parse(String(item.endDate));
        if (!Number.isFinite(end) || new Date(end).getUTCFullYear() < 9999) return null;
    }
    const productId = text(item.productId);
    const titleId = text(item.titleId);
    const id = productId || text(item.url) || titleId;
    if (!id) return null;
    const date = text(item.obtained);
    return {
        id,
        productId,
        title: text(item.name) || text(item.title) || (titleId ? `Xbox title ${titleId}` : productId || "Xbox game"),
        acquired: date && Number.isFinite(Date.parse(date)) ? new Date(date).toISOString() : null,
        imageUrl: null,
    };
}

/** Query entitlements, not played-title history. Never follow response URLs with credentials. */
export async function fetchOwnedGames(fetcher: typeof fetch, authorization: string): Promise<XboxOwnedGame[]> {
    const games = new Map<string, XboxOwnedGame>();
    let continuation: string | null = null;
    const seen = new Set<string>();
    for (let page = 0; page < 50; page++) {
        const url = new URL(INVENTORY);
        url.searchParams.set("availability", "Available");
        url.searchParams.set("state", "Enabled");
        url.searchParams.set("expandSatisfyingEntitlements", "true");
        if (continuation) url.searchParams.set("continuationToken", continuation);
        const data = object(await requestJson(fetcher, url.href, undefined, authorization, "3"));
        if (!Array.isArray(data?.items)) throw new Error("Xbox inventory unavailable.");
        for (const item of data.items) {
            const game = parseOwnedGame(item);
            if (game) games.set(game.id, game);
        }
        continuation = text(object(data.pagingInfo)?.continuationToken);
        if (!continuation) {
            const result = [...games.values()];
            await addCatalogDetails(fetcher, result);
            return result.sort((a, b) => a.title.localeCompare(b.title));
        }
        if (seen.has(continuation)) throw new Error("Xbox inventory pagination did not finish.");
        seen.add(continuation);
    }
    throw new Error("Xbox inventory exceeds the supported page limit.");
}

async function addCatalogDetails(fetcher: typeof fetch, games: XboxOwnedGame[]): Promise<void> {
    const ids = [
        ...new Set(
            games.map(game => game.productId).filter((id): id is string => Boolean(id && /^[A-Z0-9]{12}$/i.test(id)))
        ),
    ];
    for (let at = 0; at < ids.length; at += 10) {
        try {
            const url = new URL("https://displaycatalog.mp.microsoft.com/v7.0/products");
            url.searchParams.set("bigIds", ids.slice(at, at + 10).join(","));
            url.searchParams.set("market", "US");
            url.searchParams.set("languages", "en-us");
            const data = object(await requestJson(fetcher, url.href, undefined));
            if (!Array.isArray(data?.Products)) continue;
            for (const product of data.Products.map(object)) {
                const local = Array.isArray(product?.LocalizedProperties)
                    ? object(product.LocalizedProperties[0])
                    : null;
                const images = Array.isArray(local?.Images) ? local.Images.map(object) : [];
                const image =
                    images.find(image => image?.ImagePurpose === "Poster") ??
                    images.find(image => image?.ImagePurpose === "BoxArt");
                const uri = text(image?.Uri);
                let imageUrl: string | null = null;
                if (uri) {
                    const parsed = new URL(uri.startsWith("//") ? `https:${uri}` : uri);
                    if (
                        parsed.protocol === "https:" &&
                        !parsed.username &&
                        !parsed.password &&
                        ["microsoft.com", "s-microsoft.com", "xboxlive.com", "xbox.com"].some(
                            host => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`)
                        )
                    )
                        imageUrl = parsed.href;
                }
                for (const game of games.filter(game => game.productId === product?.ProductId)) {
                    game.title = text(local?.ProductTitle) ?? game.title;
                    game.imageUrl = imageUrl;
                }
            }
        } catch {
            break;
        } // Keep ownership results if optional catalog metadata is unavailable.
    }
}
