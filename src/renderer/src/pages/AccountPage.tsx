import { Navigate } from "react-router-dom";
import { AccountAvatar } from "@renderer/components/AccountButton";
import { useXodusAccountStore } from "@renderer/states/XodusAccountStore";

import "@renderer/styles/pages/AccountPage.css";

function LinuxAccountPage() {
    const snapshot = useXodusAccountStore(state => state.snapshot);
    const loading = useXodusAccountStore(state => state.loading);
    const error = useXodusAccountStore(state => state.error);
    const refresh = useXodusAccountStore(state => state.refresh);
    const signingIn = useXodusAccountStore(state => state.signingIn);
    const signingOut = useXodusAccountStore(state => state.signingOut);
    const logout = useXodusAccountStore(state => state.logout);
    const login = useXodusAccountStore(state => state.login);
    const profile = snapshot?.profile;
    const connected = snapshot?.service === "connected";
    const signedIn = snapshot?.session === "signed_in";
    const checking = !snapshot && loading;

    return (
        <section className="account-page scrollbar" aria-labelledby="account-title">
            <div className="account-header">
                <div>
                    <h1 id="account-title" className="minecraft-seven account-title">Account</h1>
                    <p className="minecraft-seven account-subtitle">Your Xbox session through Xodus</p>
                </div>
                <button
                    type="button"
                    className="minecraft-seven account-refresh"
                    disabled={loading || signingIn || signingOut}
                    onClick={() => { void refresh(true); }}
                >
                    {loading ? "Refreshing…" : "Refresh"}
                </button>
            </div>

            <div className="account-card">
                <div className="account-profile">
                    <AccountAvatar avatarUrl={profile?.avatarUrl ?? null} gamertag={profile?.gamertag ?? null} />
                    <div className="account-profile-heading">
                        <h2 className="minecraft-seven account-gamertag">
                            {profile?.gamertag || (signedIn ? "Xbox account" : checking ? "Checking account…" : "Account unavailable")}
                        </h2>
                        <span className="minecraft-seven account-profile-status">
                            {signedIn ? "Signed in" : checking ? "Checking sign-in status" : "Sign-in status unavailable"}
                        </span>
                    </div>
                </div>

                <dl className="minecraft-seven account-details">
                    <div className="account-detail">
                        <dt>Email</dt>
                        <dd>
                            <span className="account-email">{profile?.email || "Not available"}</span>
                            {!profile?.email && snapshot?.emailDetail && <p className="account-detail-note">{snapshot.emailDetail}</p>}
                        </dd>
                    </div>
                    <div className="account-detail">
                        <dt>Xodus service</dt>
                        <dd className="account-service-status">
                            <span aria-hidden="true" className={`account-connection-dot${connected ? " account-connection-dot--connected" : ""}`} />
                            {connected ? "Connected" : checking ? "Checking connection…" : "Disconnected"}
                        </dd>
                    </div>
                </dl>

                {snapshot?.detail && <p className="minecraft-seven account-detail-note account-session-detail">{snapshot.detail}</p>}
                {signedIn && <div className="account-login">
                    <button type="button" className="minecraft-seven account-refresh"
                        disabled={loading || signingIn || signingOut} onClick={() => { void logout(); }}>
                        {signingOut ? "Logging out…" : "Log out of Xodus"}
                    </button>
                </div>}
                {!signedIn && (
                    <div className="account-login">
                        <button type="button" className="minecraft-seven account-refresh"
                            disabled={loading || signingIn || signingOut} onClick={() => { void login(); }}>
                            {signingIn ? "Signing in…" : "Log in with Xodus"}
                        </button>
                        {signingIn && <p role="status" className="minecraft-seven account-detail-note">Preparing Xodus or waiting for sign-in to finish…</p>}
                    </div>
                )}
                {error && <p role="alert" className="minecraft-seven account-error">{error}</p>}
            </div>

            <p className="minecraft-seven account-updated" role="status">
                {snapshot ? <>Last checked <time dateTime={new Date(snapshot.updatedAt).toISOString()}>{new Date(snapshot.updatedAt).toLocaleString()}</time></> : "Waiting for account status…"}
            </p>
        </section>
    );
}

export function AccountPage() {
    return window.process.platform === "linux" ? <LinuxAccountPage /> : <Navigate to="/" replace />;
}
