export const PROFILE_SHORTCUTS_SYNC = "PROFILE_SHORTCUTS_SYNC";

export interface ProfileShortcut {
    uuid: string;
    name: string;
    versionLabel: string;
    versionPath?: string | null;
}
