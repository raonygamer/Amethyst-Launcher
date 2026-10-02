import { NET_XVD_HEADER } from "@shared/net/DownloadIpc";
import { xvdContentId } from "@shared/linux/XodusLicence";
import { useXodusAccountStore } from "@renderer/states/XodusAccountStore";
import { LauncherTools } from "./tools/LauncherTools";

/** Run before any game bytes are downloaded or an imported archive is copied. */
export async function requireDownloadAccount(): Promise<void> {
    if (window.process.platform !== "linux") return;
    await LauncherTools.Xodus.ensureVerified();
    await useXodusAccountStore.getState().refresh();
    const account = useXodusAccountStore.getState().snapshot;
    if (account?.service !== "connected" || account.session !== "signed_in") {
        throw new Error("Sign in with Xodus in the Account tab before downloading or importing Minecraft on Linux. Xodus must be running.");
    }
}

export async function gameLicenceKeys(archive: string, amethystData: string): Promise<Record<string, string>> {
    if (window.process.platform === "linux") {
        await requireDownloadAccount();
        return LauncherTools.Xodus.licenceKeys(archive, amethystData);
    }
    if (window.process.platform === "win32") return (await import("./WindowsDecryption")).CIK_KEYS;
    throw new Error("Game licence retrieval is not supported on this platform.");
}


/** Only a small header is fetched before Xodus confirms the actual content entitlement. */
export async function requireDownloadLicence(url: string, amethystData: string): Promise<void> {
    if (window.process.platform !== "linux") return;
    await requireDownloadAccount();
    const { ipcRenderer } = window.require("electron") as typeof import("electron");
    const header = await ipcRenderer.invoke(NET_XVD_HEADER, url) as Uint8Array;
    await LauncherTools.Xodus.requireContentLicence(xvdContentId(Buffer.from(header)), amethystData);
}
