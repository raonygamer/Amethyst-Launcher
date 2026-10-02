import { Popup } from "@renderer/states/PopupStore";
import { useDownloadStore } from "@renderer/states/DownloadStore";
import { ProgressBar } from "@renderer/states/ProgressBarStore";
import { ActionsPopup } from "@renderer/popups/ActionsPopup";

export function DownloadManagerButton() {
    const downloads = useDownloadStore(state => state.downloads);
    const tasks = ProgressBar.useState(state => state.tasks);
    const active = tasks.length + downloads.filter(item => !["done", "error"].includes(item.status)).length;
    return (
        <button type="button" className="download-manager-btn" title="Downloads and actions"
            aria-label={`Downloads and actions${active ? `, ${active} active` : ""}`}
            onClick={() => { if (!Popup.isOpen()) void Popup.ask<void>(props => <ActionsPopup {...props} />); }}>
            <svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
                <path d="M8 2v8M4.5 7.5L8 11l3.5-3.5M2 14h12" />
            </svg>
            {active > 0 && <span className="download-manager-badge" />}
        </button>
    );
}
