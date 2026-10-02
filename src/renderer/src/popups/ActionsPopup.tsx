import { PopupPanel } from "@renderer/components/PopupPanel";
import { usePopupClose } from "@renderer/components/PopupCloseContext";
import type { PopupUseArguments } from "@renderer/states/PopupStore";
import { ProgressBar } from "@renderer/states/ProgressBarStore";
import { removePendingDownload, useDownloadStore } from "@renderer/states/DownloadStore";
import { formatBytes } from "@shared/net/TransferRate";
import "@renderer/styles/components/ActionsPopup.css";

export function ActionsPopup({ submit: rawSubmit }: PopupUseArguments<void>) {
    const animateClose = usePopupClose();
    const tasks = ProgressBar.useState(state => state.tasks);
    const downloads = useDownloadStore(state => state.downloads);
    const remove = useDownloadStore(state => state.removeDownload);
    const clearCompleted = useDownloadStore(state => state.clearCompleted);
    const activeDownloads = downloads.filter(item => !["done", "error"].includes(item.status));
    const actions = tasks.filter(task => task.currentStatus !== "downloading" || activeDownloads.length === 0);
    return (
        <PopupPanel title="Downloads and actions" size="xxl" onClose={() => animateClose(() => rawSubmit())}
            boxClassName="actions-popup" bodyClassName="popup-body scrollbar">
            <div className="actions-summary minecraft-seven">
                <p>{activeDownloads.length} downloads / installs · {actions.length} other actions</p>
                <button type="button" onClick={clearCompleted} disabled={!downloads.some(item => ["done", "error"].includes(item.status))}>Clear finished</button>
            </div>
            {actions.length === 0 && downloads.length === 0 && <p className="minecraft-seven actions-empty">No current actions.</p>}
            {actions.map(task => (
                <div key={task.id} className="action-card">
                    <div className="action-heading minecraft-seven"><strong>{task.message || "Preparing…"}</strong><span>{task.currentStatus}</span></div>
                    <progress aria-label={task.message || "Task progress"} max={1} value={task.progress > 0 ? Math.min(1, task.progress) : undefined} />
                </div>
            ))}
            {downloads.map(item => {
                const active = item.status === "downloading" || item.status === "queued";
                return <div key={item.id} className={`action-card${item.status === "error" ? " action-card--error" : ""}`}>
                    <div className="action-heading minecraft-seven"><strong>{item.name}</strong><span>{item.status}</span></div>
                    <progress aria-label={`${item.name} progress`} max={1}
                        value={item.status === "extracting" || (active && !item.total) ? undefined : Math.min(1, Math.max(0, item.progress))} />
                    <div className="action-details minecraft-seven">
                        <span>{formatBytes(item.transferred ?? 0)}{item.total ? ` / ${formatBytes(item.total)}` : ""}
                            {active && ` · ${formatBytes(item.bytesPerSecond ?? 0)}/s`}
                            {active && !!item.total && ` · ${Math.round(item.progress * 100)}%`}</span>
                        {active && item.abortController && <button type="button" onClick={() => {
                            item.abortController?.abort();
                            removePendingDownload(item.id);
                            remove(item.id);
                        }}>Cancel</button>}
                        {["done", "error"].includes(item.status) && <button type="button" onClick={() => remove(item.id)}>Dismiss</button>}
                    </div>
                </div>;
            })}
        </PopupPanel>
    );
}
