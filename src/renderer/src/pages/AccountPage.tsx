import { useEffect, useRef, useState } from "react";
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
    const restarting = useXodusAccountStore(state => state.restarting);
    const restart = useXodusAccountStore(state => state.restart);
    const library = useXodusAccountStore(state => state.library);
    const libraryLoading = useXodusAccountStore(state => state.libraryLoading);
    const loadLibrary = useXodusAccountStore(state => state.loadLibrary);
    const [filter, setFilter] = useState("");
    const busy = loading || signingIn || signingOut || restarting;
    const profile = snapshot?.profile;
    const connected = snapshot?.service === "connected";
    const signedIn = snapshot?.session === "signed_in";
    const checking = !snapshot && loading;
    const libraryCheck = useRef({ xuid: profile?.xuid, after: 0 });
    useEffect(() => {
        if (libraryCheck.current.xuid !== profile?.xuid) libraryCheck.current = { xuid: profile?.xuid, after: 0 };
        if (
            signedIn &&
            !busy &&
            !libraryLoading &&
            (!library || (Date.now() >= libraryCheck.current.after && Date.now() - library.updatedAt >= 60 * 60_000))
        ) {
            // A cached rate-limit response can be older than an hour; do not retry it in a render loop.
            libraryCheck.current.after = Date.now() + 60 * 60_000;
            void loadLibrary();
        }
    }, [signedIn, profile?.xuid, snapshot?.updatedAt, library, libraryLoading, busy, loadLibrary]);
    const games =
        library?.games.filter(game => game.title.toLocaleLowerCase().includes(filter.toLocaleLowerCase())) ?? [];
    const refreshAll = async (): Promise<void> => {
        await refresh(true);
        await loadLibrary(true);
    };

    return (
        <section className="account-page scrollbar" aria-labelledby="account-title">
            <div className="account-header">
                <div>
                    <h1 id="account-title" className="minecraft-seven account-title">
                        Account
                    </h1>
                    <p className="minecraft-seven account-subtitle">Your Xbox session through Xodus</p>
                </div>
                <div className="account-actions">
                    <button
                        type="button"
                        className="minecraft-seven account-refresh"
                        disabled={busy || libraryLoading}
                        onClick={() => {
                            void restart();
                        }}
                        aria-busy={restarting}
                    >
                        {restarting ? "Restarting…" : "Restart Xodus"}
                    </button>
                    <button
                        type="button"
                        className="minecraft-seven account-refresh"
                        disabled={busy || libraryLoading}
                        onClick={() => {
                            void refreshAll();
                        }}
                    >
                        {loading || libraryLoading ? "Refreshing…" : "Refresh"}
                    </button>
                </div>
            </div>

            <div className="account-overview">
                <div className="account-card">
                    <div className="account-profile">
                        <AccountAvatar avatarUrl={profile?.avatarUrl ?? null} gamertag={profile?.gamertag ?? null} />
                        <div className="account-profile-heading">
                            <h2 className="minecraft-seven account-gamertag">
                                {profile?.gamertag ||
                                    (signedIn
                                        ? "Xbox account"
                                        : checking
                                          ? "Checking account…"
                                          : "Account unavailable")}
                            </h2>
                            <span className="minecraft-seven account-profile-status">
                                {signedIn
                                    ? "Signed in"
                                    : checking
                                      ? "Checking sign-in status"
                                      : "Sign-in status unavailable"}
                            </span>
                        </div>
                    </div>

                    <dl className="minecraft-seven account-details">
                        <div className="account-detail">
                            <dt>Email</dt>
                            <dd>
                                <span className="account-email">{profile?.email || "Not available"}</span>
                                {!profile?.email && snapshot?.emailDetail && (
                                    <p className="account-detail-note">{snapshot.emailDetail}</p>
                                )}
                            </dd>
                        </div>
                        <div className="account-detail">
                            <dt>Xodus service</dt>
                            <dd className="account-service-status">
                                <span
                                    aria-hidden="true"
                                    className={`account-connection-dot${connected ? " account-connection-dot--connected" : ""}`}
                                />
                                {connected ? "Connected" : checking ? "Checking connection…" : "Disconnected"}
                            </dd>
                        </div>
                    </dl>

                    {snapshot?.detail && (
                        <p className="minecraft-seven account-detail-note account-session-detail">{snapshot.detail}</p>
                    )}
                    {signedIn && (
                        <div className="account-login">
                            <button
                                type="button"
                                className="minecraft-seven account-refresh"
                                disabled={busy || libraryLoading}
                                onClick={() => {
                                    void logout();
                                }}
                            >
                                {signingOut ? "Logging out…" : "Log out of Xodus"}
                            </button>
                        </div>
                    )}
                    {!signedIn && (
                        <div className="account-login">
                            <button
                                type="button"
                                className="minecraft-seven account-refresh"
                                disabled={busy || libraryLoading}
                                onClick={() => {
                                    void login();
                                }}
                            >
                                {signingIn ? "Signing in…" : "Log in with Xodus"}
                            </button>
                            {signingIn && (
                                <p role="status" className="minecraft-seven account-detail-note">
                                    Preparing Xodus or waiting for sign-in to finish…
                                </p>
                            )}
                        </div>
                    )}
                    {restarting && (
                        <p role="status" className="minecraft-seven account-detail-note">
                            Restarting Xodus. Complete any keyring or permission prompt.
                        </p>
                    )}
                    {error && (
                        <p role="alert" className="minecraft-seven account-error">
                            {error}
                        </p>
                    )}
                </div>

                <aside className="account-card account-stats" aria-label="Xbox account details">
                    <h2 className="minecraft-seven account-section-title">Xbox profile</h2>
                    <dl className="minecraft-seven account-stat-grid">
                        <div>
                            <dt>Gamerscore</dt>
                            <dd>{profile?.gamerscore?.toLocaleString() ?? "Not available"}</dd>
                        </div>
                        <div>
                            <dt>Account tier</dt>
                            <dd>{profile?.accountTier ?? "Not available"}</dd>
                        </div>
                        <div>
                            <dt>Xbox tenure</dt>
                            <dd>
                                {profile?.tenure !== undefined
                                    ? `${profile.tenure} ${profile.tenure === 1 ? "year" : "years"}`
                                    : "Not available"}
                            </dd>
                        </div>
                        <div>
                            <dt>Xbox account ID</dt>
                            <dd className="account-xuid">{profile?.xuid ?? "Not available"}</dd>
                        </div>
                    </dl>
                </aside>
            </div>

            <section
                className="account-card account-library"
                aria-labelledby="owned-games-title"
                aria-busy={libraryLoading}
            >
                <div className="account-library-heading">
                    <h2 id="owned-games-title" className="minecraft-seven account-section-title">
                        Owned games{library?.games.length ? ` (${library.games.length} confirmed)` : ""}
                    </h2>
                    {library?.games.length ? (
                        <input
                            className="minecraft-seven account-game-search"
                            type="search"
                            aria-label="Search owned games"
                            placeholder="Search your games…"
                            value={filter}
                            onChange={event => setFilter(event.target.value)}
                        />
                    ) : null}
                </div>
                <p className="minecraft-seven account-detail-note" role="status">
                    {!signedIn
                        ? "Sign in through Xodus to see your owned Xbox games."
                        : libraryLoading
                          ? "Loading your Xbox library…"
                          : (library?.detail ?? "Your Xbox library has not been loaded yet.")}
                </p>
                {signedIn && library?.status === "available" && (
                    <>
                        {games.length ? (
                            <ul className="account-game-grid">
                                {games.map(game => (
                                    <li key={game.id} className="account-game">
                                        {game.imageUrl ? (
                                            <img
                                                src={game.imageUrl}
                                                alt=""
                                                loading="lazy"
                                                referrerPolicy="no-referrer"
                                            />
                                        ) : (
                                            <span aria-hidden="true" className="account-game-icon">
                                                ▧
                                            </span>
                                        )}
                                        <div>
                                            <h3 className="minecraft-seven">{game.title}</h3>
                                            {game.acquired && (
                                                <p className="minecraft-seven account-detail-note">
                                                    Added {new Date(game.acquired).toLocaleDateString()}
                                                </p>
                                            )}
                                        </div>
                                    </li>
                                ))}
                            </ul>
                        ) : (
                            <p className="minecraft-seven account-detail-note">
                                {filter
                                    ? "No games match your search."
                                    : "No purchases could be confirmed by this lookup. This does not mean you own no games."}
                            </p>
                        )}
                    </>
                )}
            </section>

            <p className="minecraft-seven account-updated" role="status">
                {snapshot ? (
                    <>
                        Last checked{" "}
                        <time dateTime={new Date(snapshot.updatedAt).toISOString()}>
                            {new Date(snapshot.updatedAt).toLocaleString()}
                        </time>
                    </>
                ) : (
                    "Waiting for account status…"
                )}
            </p>
        </section>
    );
}

export function AccountPage() {
    return window.process.platform === "linux" ? <LinuxAccountPage /> : <Navigate to="/" replace />;
}
