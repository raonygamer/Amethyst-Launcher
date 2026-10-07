import { execFile } from "node:child_process";

// libsecret handles Secret Service Prompt/Completed on one D-Bus connection.
// Password entry stays in the desktop's dialog; no secrets are read or printed.
export const KEYRING_UNLOCK_SCRIPT = `
import sys, threading
try:
    import gi
    gi.require_version('Secret', '1')
    from gi.repository import Secret, Gio
except (ImportError, ValueError):
    sys.exit(6)
cancel = Gio.Cancellable()
timer = threading.Timer(180, cancel.cancel)
timer.daemon = True
timer.start()
try:
    service = Secret.Service.get_sync(Secret.ServiceFlags.NONE, cancel)
    collection = Secret.Collection.for_alias_sync(service, 'default', Secret.CollectionFlags.NONE, cancel)
    if collection is None:
        sys.exit(3)
    if collection.get_locked():
        count, unlocked = service.unlock_sync([collection], cancel)
        if count < 1:
            sys.exit(4)
except Exception:
    sys.exit(4 if cancel.is_cancelled() else 5)
finally:
    timer.cancel()
`;

export const KEYRING_ERRORS: Record<number, string> = {
    3: "No default keyring is available. Open your desktop's Passwords and Keys or Wallet manager, select a default keyring, and try again.",
    4: "Keyring unlocking was cancelled. Unlock it to start Xodus, then try again.",
    5: "The desktop keyring is unavailable. Open your Passwords and Keys or Wallet manager and unlock the default keyring. If it is missing, restore or create it there, then try again.",
    6: "Keyring unlocking needs Python GObject and libsecret bindings. Verify Xodus in Settings → Tools to install them.",
};

export class KeyringUnlockError extends Error {}

export function unlockXodusKeyring(execute: typeof execFile = execFile): Promise<void> {
    return new Promise((resolve, reject) => {
        execute("python3", ["-c", KEYRING_UNLOCK_SCRIPT], { timeout: 190_000, maxBuffer: 4096 }, error => {
            if (!error) resolve();
            else reject(new KeyringUnlockError(KEYRING_ERRORS[Number(error.code)] ?? "Could not unlock the desktop keyring. Unlock it in your keyring manager and try again."));
        });
    });
}
