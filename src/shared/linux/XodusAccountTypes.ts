export const XODUS_ACCOUNT_REFRESH = "XODUS_ACCOUNT_REFRESH";
export const XODUS_ACCOUNT_LOGOUT = "XODUS_ACCOUNT_LOGOUT";
export const XODUS_ACCOUNT_LOGIN = "XODUS_ACCOUNT_LOGIN";

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
    } | null;
    detail: string | null;
    emailDetail: string | null;
    updatedAt: number;
}
