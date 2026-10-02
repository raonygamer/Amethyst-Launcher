import { spawn } from "node:child_process";
import { constants, promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { XodusLoginResult } from "../../shared/linux/XodusAccountTypes.ts";

interface LoginDependencies {
    platform: string;
    home: string;
    env: NodeJS.ProcessEnv;
    access: typeof fs.access;
    spawn: typeof spawn;
}

/** Run the installed tool as the desktop user; no rebuild or privilege prompt at login. */
function createXodusAccountAction(action: "login" | "logout", overrides: Partial<LoginDependencies> = {}): () => Promise<XodusLoginResult> {
    const deps: LoginDependencies = {
        platform: process.platform, home: homedir(), env: process.env,
        access: fs.access, spawn, ...overrides,
    };
    let pending: Promise<XodusLoginResult> | undefined;
    const login = async (): Promise<XodusLoginResult> => {
        if (deps.platform !== "linux") return { ok: false, message: `Xodus ${action} is only available on Linux.` };
        const data = path.join(deps.home, ".amethyst");
        const executable = path.join(data, "launcher/tools/xodus/bin/xodus-cli");
        try {
            await deps.access(executable, constants.X_OK);
        } catch {
            return { ok: false, message: `Xodus is not ready. Verify Xodus in Settings → Tools, then try ${action} again.` };
        }
        const env: NodeJS.ProcessEnv = { ...deps.env, XODUS_LOG: "warn" };
        return new Promise(resolve => {
            try {
                // Authentication output may include credentials. Only lifecycle status is logged.
                const child = deps.spawn(executable, [action], {
                    env, cwd: deps.home, stdio: "ignore", shell: false,
                    timeout: action === "login" ? 15 * 60_000 : 30_000, killSignal: "SIGKILL",
                });
                child.once("error", () => resolve({ ok: false, message: `Could not run Xodus ${action}. Check that the Linux tools and desktop session are available.` }));
                child.once("close", (code, signal) => resolve(code === 0 && !signal
                    ? { ok: true, message: null }
                    : { ok: false, message: `Xodus ${action} did not complete. Try again.` }));
            } catch {
                resolve({ ok: false, message: `Could not run Xodus ${action}. Verify Xodus in Settings → Tools.` });
            }
        });
    };
    return () => {
        if (!pending) pending = login().finally(() => { pending = undefined; });
        return pending;
    };
}

export const createXodusLogin = (overrides: Partial<LoginDependencies> = {}): (() => Promise<XodusLoginResult>) => createXodusAccountAction("login", overrides);
export const createXodusLogout = (overrides: Partial<LoginDependencies> = {}): (() => Promise<XodusLoginResult>) => createXodusAccountAction("logout", overrides);
export const loginToXodus = createXodusLogin();
export const logoutOfXodus = createXodusLogout();
