import { ActionType, AppStatusType, BLOCKED_ACTIONS } from "@renderer/scripts/AppStatus";
import { log } from "@renderer/scripts/LauncherLog";
import { SetStateAction, StateUtils } from "./StateUtils";
import { create } from "zustand";

export interface ProgressTask {
    id: number;
    currentStatus: AppStatusType;
    message: string;
    progress: number;
    show: boolean;
}

interface ProgressBarState {
    tasks: readonly ProgressTask[];
    busy: boolean;
    currentStatus: AppStatusType;
    message: string;
    progress: number;
    show: boolean;

    setStatus(status: AppStatusType): void;
    setMessage(message: SetStateAction<string>): void;
    setProgress(progress: SetStateAction<number>): void;
    setShow(show: SetStateAction<boolean>): void;
    /** Apply multiple field updates in a single zustand `set()` so subscribers see one consistent change. */
    update(partial: Partial<Pick<ProgressBarState, "busy" | "currentStatus" | "message" | "progress" | "show">>): void;
    reset(): void;
};

type ProgressResetOptions = {
    status: boolean;
    message: boolean;
    progress: boolean;
    show: boolean;
}

export const FULL_PROGRESS_RESET_OPTIONS: ProgressResetOptions = {
    status: true,
    message: true,
    progress: true,
    show: true
}

let lastProgressMessage = "";
let lastProgressLogTime = 0;

/** Keep task details in the console without logging every byte counter or elapsed second. */
function logProgressMessage(message: string, flush = false): void {
    const text = message.replace(/ \(\d+m \d+s elapsed\)$/, "");
    if (!text || text === lastProgressMessage) return;
    const now = Date.now();
    if (!flush && now - lastProgressLogTime < 1000) return;
    lastProgressMessage = text;
    lastProgressLogTime = now;
    log("Progress", text);
}

export class ProgressBar {
    private static state = create<ProgressBarState>((set) => ({
        tasks: [],
        busy: false,
        currentStatus: "idle",
        message: "",
        progress: 0,
        show: false,

        // Status gates other tasks. Message logging is throttled; numeric progress is not logged.
        setStatus(status) {
            set((state) => {
                const next = StateUtils.resolveSetStateAction(status, state.currentStatus);
                if (next !== state.currentStatus) log("Progress", `Status: ${state.currentStatus} -> ${next}`);
                return { currentStatus: next };
            });
        },
        setMessage(message) {
            set((state) => {
                const next = StateUtils.resolveSetStateAction(message, state.message);
                if (next !== state.message) logProgressMessage(next);
                return { message: next };
            });
        },
        setProgress(progress) {
            set((state) => ({
                progress: StateUtils.resolveSetStateAction(progress, state.progress)
            }));
        },
        setShow(show) {
            set((state) => ({
                show: StateUtils.resolveSetStateAction(show, state.show)
            }));
        },
        update(partial) {
            set((state) => {
                if (partial.currentStatus !== undefined && partial.currentStatus !== state.currentStatus) {
                    log("Progress", `Status: ${state.currentStatus} -> ${partial.currentStatus}`);
                }
                return partial;
            });
        },
        reset() {
            set({
                busy: false,
                currentStatus: "idle",
                message: "",
                progress: 0,
                show: false
            });
        }
    }));

    static getState(): ProgressBarState {
        return this.state.getState();
    };

    static useState(): ProgressBarState;
    static useState<T>(selector: (state: ProgressBarState) => T): T;
    static useState<T>(selector?: (state: ProgressBarState) => T): T | ProgressBarState {
        return selector ? this.state(selector) : this.state();
    }

    private static nextId = 0;
    private static active = new Map<number, ProgressTask>();
    private static ownerReset = FULL_PROGRESS_RESET_OPTIONS;

    /** Each operation owns its setters, including nested or overlapping operations. */
    private static enter(show: boolean, reset: ProgressResetOptions): ProgressBarState {
        if (this.active.size === 0) this.ownerReset = reset;
        const task: ProgressTask = { id: ++this.nextId, currentStatus: "other", message: "", progress: 0, show };
        this.active.set(task.id, task);
        let lastMessage = "";
        let lastLog = 0;
        const update = (partial: Partial<ProgressTask>): void => {
            if (!this.active.has(task.id)) return;
            Object.assign(task, partial);
            if (partial.message !== undefined) {
                const message = task.message.replace(/ \(\d+m \d+s elapsed\)$/, "");
                if (message && message !== lastMessage && Date.now() - lastLog >= 1000) {
                    log("Progress", message);
                    lastMessage = message;
                    lastLog = Date.now();
                }
            }
            this.publish(task);
        };
        this.publish(task);
        return {
            ...this.getState(),
            get currentStatus() { return task.currentStatus; },
            get message() { return task.message; },
            get progress() { return task.progress; },
            get show() { return task.show; },
            setStatus: status => update({ currentStatus: status }),
            setMessage: value => update({ message: StateUtils.resolveSetStateAction(value, task.message) }),
            setProgress: value => update({ progress: StateUtils.resolveSetStateAction(value, task.progress) }),
            setShow: value => update({ show: StateUtils.resolveSetStateAction(value, task.show) }),
            update: partial => update(partial),
            reset: () => update({ currentStatus: "idle", message: "", progress: 0, show: false }),
            // Captured ID is intentionally private to this lifecycle.
            taskId: task.id,
        } as ProgressBarState & { taskId: number };
    }

    private static publish(focus?: ProgressTask): void {
        const tasks = [...this.active.values()].map(task => ({ ...task }));
        const current = focus?.show ? focus : [...tasks].reverse().find(task => task.show) ?? tasks.at(-1);
        this.state.setState({ tasks, busy: tasks.length > 0,
            ...(current ? { currentStatus: current.currentStatus, message: current.message,
                progress: current.progress, show: tasks.some(task => task.show) } : {}),
        });
    }

    private static leave(context: ProgressBarState): void {
        const id = (context as ProgressBarState & { taskId: number }).taskId;
        const task = this.active.get(id);
        if (!task) return;
        if (task.message) log("Progress", task.message);
        this.active.delete(id);
        this.publish();
        if (this.active.size > 0) return;
        const reset = this.ownerReset;
        this.getState().update({ busy: false,
            ...(reset.status ? { currentStatus: "idle" as const } : {}),
            ...(reset.message ? { message: "" } : {}),
            ...(reset.progress ? { progress: 0 } : {}),
            ...(reset.show ? { show: false } : {}),
        });
    }

    static run(callback: (state: ProgressBarState) => void, show = true, resetOptions = FULL_PROGRESS_RESET_OPTIONS): void {
        const context = this.enter(show, resetOptions);
        try { callback(context); } finally { this.leave(context); }
    }

    static async runAsync(callback: (state: ProgressBarState) => Promise<void>, show = true, resetOptions = FULL_PROGRESS_RESET_OPTIONS): Promise<void> {
        const context = this.enter(show, resetOptions);
        try { await callback(context); } finally { this.leave(context); }
    }

    static reset(): void {
        // A caller finishing or failing cannot erase unrelated work still in progress.
        if (this.active.size > 0) { this.publish(); return; }
        this.getState().reset();
    }

    static isBusy(): boolean {
        return this.getState().busy;
    }

    /** React hook variant of {@link isBusy} — subscribes so callers re-render when busy flips. */
    static useIsBusy(): boolean {
        return this.useState(s => s.busy);
    }

    static canDoAction(actionType: ActionType): boolean {
        const state = this.getState();
        const statuses = state.tasks.length ? state.tasks.map(task => task.currentStatus) : [state.currentStatus];
        return statuses.every(status => !BLOCKED_ACTIONS[status].includes(actionType));
    }

    /**
     * React hook variant of {@link canDoAction} — subscribes to status changes
     * so the calling component re-renders when the answer flips.
     */
    static useCanDoAction(actionType: ActionType): boolean {
        return this.useState(state => (state.tasks.length ? state.tasks.map(task => task.currentStatus) : [state.currentStatus])
            .every(status => !BLOCKED_ACTIONS[status].includes(actionType)));
    }
}
