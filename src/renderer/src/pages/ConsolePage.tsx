import { memo, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { formatEntry } from "@shared/diagnostics/Log";
import type { LiveLogEntry } from "@shared/diagnostics/LiveConsole";
import { useLiveConsoleStore } from "@renderer/states/LiveConsoleStore";
import { ProgressBar } from "@renderer/states/ProgressBarStore";

import "@renderer/styles/pages/ConsolePage.css";

const STATUS_LABELS = {
    idle: "Idle",
    other: "Working",
    downloading: "Downloading",
    extracting: "Extracting",
    decrypting: "Decrypting",
    launching: "Launching",
    importing: "Importing",
    deleting: "Deleting",
};

const ConsoleEntry = memo(function ConsoleEntry({ entry }: { entry: LiveLogEntry }) {
    return <div className={`console-entry console-entry--${entry.level.toLowerCase()}`}>{formatEntry(entry)}</div>;
});

export function ConsolePage() {
    const entries = useLiveConsoleStore(state => state.entries);
    const connected = useLiveConsoleStore(state => state.connected);
    const clear = useLiveConsoleStore(state => state.clear);
    const { tasks } = ProgressBar.useState();
    const [query, setQuery] = useState("");
    const [level, setLevel] = useState("");
    const [source, setSource] = useState("");
    const [scope, setScope] = useState("");
    const deferredQuery = useDeferredValue(query.trim().toLowerCase());
    const [following, setFollowing] = useState(true);
    const [copyStatus, setCopyStatus] = useState("");
    const output = useRef<HTMLDivElement>(null);
    const follow = useRef(true);
    const manuallyPaused = useRef(false);

    const sources = useMemo(() => [...new Set([...entries.map(entry => entry.source), ...(source ? [source] : [])])].sort(), [entries, source]);
    const scopes = useMemo(() => [...new Set([...entries.map(entry => entry.scope), ...(scope ? [scope] : [])])].sort(), [entries, scope]);
    const filtering = !!(deferredQuery || level || source || scope);
    const visibleEntries = useMemo(() => entries.filter(entry =>
        (!level || entry.level === level) && (!source || entry.source === source) && (!scope || entry.scope === scope)
        && (!deferredQuery || formatEntry(entry).toLowerCase().includes(deferredQuery))), [entries, deferredQuery, level, source, scope]);

    useLayoutEffect(() => {
        if (follow.current && output.current) output.current.scrollTop = output.current.scrollHeight;
    }, [visibleEntries]);

    useEffect(() => {
        if (!copyStatus) return;
        const timer = setTimeout(() => setCopyStatus(""), 3000);
        return () => clearTimeout(timer);
    }, [copyStatus]);

    const toggleFollowing = () => {
        follow.current = !follow.current;
        manuallyPaused.current = !follow.current;
        setFollowing(follow.current);
        if (follow.current && output.current) output.current.scrollTop = output.current.scrollHeight;
    };

    const clearView = () => {
        clear();
        follow.current = true;
        manuallyPaused.current = false;
        setFollowing(true);
    };

    const copyOutput = async () => {
        try {
            await navigator.clipboard.writeText(visibleEntries.map(formatEntry).join("\n"));
            setCopyStatus("Copied to clipboard");
        } catch {
            setCopyStatus("Could not copy. Select the output to copy it manually.");
        }
    };

    return (
        <section className="console-page" aria-labelledby="console-title">
            <div className="console-header">
                <div className="console-heading">
                    <h1 id="console-title" className="minecraft-seven console-title">Console</h1>
                    <span className={`minecraft-seven console-connection${connected ? " console-connection--live" : ""}`}>
                        <span aria-hidden="true" className="console-connection-dot" />
                        {connected ? "Live" : "Connecting…"}
                    </span>
                </div>
                <span className="minecraft-seven console-description">Launcher, tools and games</span>
            </div>

            <div className="console-toolbar">
                <input
                    type="search"
                    className="minecraft-seven console-search"
                    placeholder="Search output…"
                    aria-label="Search console output"
                    value={query}
                    onChange={event => setQuery(event.target.value)}
                    spellCheck={false}
                />
                <button
                    type="button"
                    className="minecraft-seven console-button"
                    aria-pressed={following}
                    title={following ? "Pause automatic scrolling" : "Resume scrolling to the latest output"}
                    onClick={toggleFollowing}
                >
                    {following ? "Following latest" : "Follow latest"}
                </button>
                <button type="button" className="minecraft-seven console-button" disabled={visibleEntries.length === 0} onClick={copyOutput}>
                    Copy shown
                </button>
                <button
                    type="button"
                    className="minecraft-seven console-button"
                    title="Clear this view. Saved log files are kept."
                    disabled={entries.length === 0}
                    onClick={clearView}
                >
                    Clear view
                </button>
            </div>

            <div className="console-filters minecraft-seven">
                <label>Level <select value={level} onChange={event => setLevel(event.target.value)}>
                    <option value="">All levels</option>
                    {["INFO", "WARN", "ERROR", "DEBUG"].map(value => <option key={value}>{value}</option>)}
                </select></label>
                <label>Source <select value={source} onChange={event => setSource(event.target.value)}>
                    <option value="">All sources</option>
                    {sources.map(value => <option key={value}>{value}</option>)}
                </select></label>
                <label>Component <select value={scope} onChange={event => setScope(event.target.value)}>
                    <option value="">All components</option>
                    {scopes.map(value => <option key={value}>{value}</option>)}
                </select></label>
                <button type="button" className="console-button" disabled={!filtering}
                    onClick={() => { setLevel(""); setSource(""); setScope(""); setQuery(""); }}>Reset filters</button>
            </div>

            {tasks.length > 0 && <div className="console-tasks scrollbar">{tasks.map(({ id, currentStatus, message, progress }) => {
                const progressValue = Number.isFinite(progress) && progress > 0 ? Math.min(1, progress) : undefined;
                return (
                <div className="console-task" key={id}>
                    <div className="minecraft-seven console-task-text">
                        <span className="console-task-status">{currentStatus === "idle" ? "Working" : STATUS_LABELS[currentStatus]}</span>
                        <span className="console-task-message">{message || "Task in progress…"}</span>
                        {progressValue !== undefined && <span>{Math.round(progressValue * 100)}%</span>}
                    </div>
                    <progress className="console-task-progress" aria-label={message || "Current task progress"} max={1} value={progressValue} />
                </div>
                );
            })}</div>}

            <div
                ref={output}
                className="console-output scrollbar"
                role="region"
                aria-label="Live console output"
                tabIndex={0}
                onScroll={event => {
                    // A queued event from our last scroll-to-bottom must not undo Pause.
                    if (manuallyPaused.current) return;
                    const target = event.currentTarget;
                    const atBottom = target.scrollHeight - target.scrollTop - target.clientHeight < 24;
                    follow.current = atBottom;
                    setFollowing(atBottom);
                }}
            >
                {visibleEntries.length === 0 ? (
                    <p className="console-empty">
                        {filtering ? "No output matches your filters." : "Waiting for output. Builds, downloads and game activity appear here as they happen."}
                    </p>
                ) : visibleEntries.map(entry => <ConsoleEntry key={entry.id} entry={entry} />)}
            </div>

            <div className="minecraft-seven console-footer">
                <span>
                    {visibleEntries.length.toLocaleString()}{filtering ? ` of ${entries.length.toLocaleString()}` : ""} recent entries
                    {!following && " · Auto-scroll paused"}
                </span>
                <span role="status">{copyStatus}</span>
            </div>
        </section>
    );
}
