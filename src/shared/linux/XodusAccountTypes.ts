export const XODUS_ACCOUNT_REFRESH = "XODUS_ACCOUNT_REFRESH";
export const XODUS_ACCOUNT_LOGOUT = "XODUS_ACCOUNT_LOGOUT";
export const XODUS_ACCOUNT_LOGIN = "XODUS_ACCOUNT_LOGIN";
export const XODUS_ENSURE_RUNNING = "XODUS_ENSURE_RUNNING";
export const XODUS_RESTART = "XODUS_RESTART";
export const XODUS_ACCOUNT_LIBRARY = "XODUS_ACCOUNT_LIBRARY";

export interface XboxOwnedGame {
    id: string;
    title: string;
    productId: string | null;
    acquired: string | null;
    imageUrl: string | null;
}

export interface XboxOwnedGames {
    games: XboxOwnedGame[];
    status: "available" | "unavailable";
    detail: string | null;
    updatedAt: number;
}

export interface XodusLoginResult {
    ok: boolean;
    message: string | null;
}

/** Account display data only. Authentication tokens stay in the main process. */
export interface XodusAccountSnapshot {
    service: "connected" | "disconnected" | "unsupported";
    session: "signed_in" | "unavailable";
    profile: {
        gamertag: string | null;
        avatarUrl: string | null;
        email: string | null;
        xuid: string | null;
        gamerscore?: number;
        accountTier?: string;
        tenure?: number;
    } | null;
    detail: string | null;
    emailDetail: string | null;
    updatedAt: number;
}
