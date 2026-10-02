import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { startXodusAccountPolling, useXodusAccountStore } from "@renderer/states/XodusAccountStore";

import "@renderer/styles/pages/AccountPage.css";

export function AccountAvatar({ avatarUrl, gamertag }: { avatarUrl: string | null; gamertag: string | null }) {
    const [failedUrl, setFailedUrl] = useState<string | null>(null);
    return (
        <span className="account-avatar">
            {avatarUrl && avatarUrl !== failedUrl ? (
                <img
                    src={avatarUrl}
                    alt={gamertag ? `${gamertag}'s profile picture` : "Xbox profile picture"}
                    referrerPolicy="no-referrer"
                    draggable={false}
                    onError={() => setFailedUrl(avatarUrl)}
                />
            ) : (
                <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                    <circle cx="16" cy="11" r="5" />
                    <path d="M6 28v-3a10 10 0 0 1 20 0v3" />
                </svg>
            )}
        </span>
    );
}

function LinuxAccountButton() {
    const location = useLocation();
    const snapshot = useXodusAccountStore(state => state.snapshot);
    const loading = useXodusAccountStore(state => state.loading);
    const profile = snapshot?.profile;
    const connected = snapshot?.service === "connected";
    const connection = connected ? "Service connected" : !snapshot && loading ? "Checking connection" : "Service disconnected";
    const label = profile?.gamertag || "Account";

    useEffect(() => startXodusAccountPolling(), []);

    return (
        <Link
            to="/account"
            draggable={false}
            title={`${label} · ${connection}`}
            aria-label={`${label}, ${connection}`}
            aria-current={location.pathname === "/account" ? "page" : undefined}
            className={`app-logs-button app-account-button${location.pathname === "/account" ? " app-logs-button--active" : ""}`}
        >
            <span className="app-account-avatar">
                <AccountAvatar avatarUrl={profile?.avatarUrl ?? null} gamertag={profile?.gamertag ?? null} />
                <span aria-hidden="true" className={`account-connection-dot${connected ? " account-connection-dot--connected" : ""}`} />
            </span>
        </Link>
    );
}

export function AccountButton() {
    return window.process.platform === "linux" ? <LinuxAccountButton /> : null;
}
