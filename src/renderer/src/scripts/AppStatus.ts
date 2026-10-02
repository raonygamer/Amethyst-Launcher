export type AppStatusType =
    | "other"
    | "idle"
    | "downloading"
    | "extracting"
    | "decrypting"
    | "launching"
    | "importing"
    | "deleting";

export type ActionType = "launch" | "download" | "extract" | "decrypt";

export const BLOCKED_ACTIONS: Record<AppStatusType, ActionType[]> = {
    idle: [],
    downloading: ["launch", "extract", "decrypt"],
    extracting: ["launch", "extract", "decrypt"],
    decrypting: ["launch", "extract", "decrypt"],
    launching: ["launch", "download", "extract", "decrypt"],
    importing: ["launch", "download", "extract", "decrypt"],
    deleting: ["launch", "download", "extract", "decrypt"],
    // Keep launches/file mutations exclusive, but allow independent downloads to overlap.
    other: ["launch", "extract", "decrypt"],
};
