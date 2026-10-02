import { spawnGameWithOutput } from "@shared/diagnostics/GameProcess";
import { launcherLogPath, writeLauncherLog } from "./RendererLog";

const path = window.require("path") as typeof import("path");
const os = window.require("os") as typeof import("os");

export function spawnLoggedGame(
    executable: string,
    args: string[],
    options: { cwd?: string; env?: NodeJS.ProcessEnv },
): import("child_process").ChildProcess {
    const launcherLog = launcherLogPath();
    const { process: game, outputClosed } = spawnGameWithOutput(executable, args, options, {
        directory: launcherLog ? path.dirname(launcherLog) : path.join(os.tmpdir(), "amethyst-game-logs"),
        onLine: (stream, line) => writeLauncherLog(stream === "stdout" ? "INFO" : "WARN", "Game", line),
        onDiagnostic: message => writeLauncherLog("INFO", "Game", message),
    });
    game.on("error", error => writeLauncherLog("ERROR", "Game", `${executable}: ${error.message}`));
    game.on("close", (code, signal) => {
        void outputClosed.then(() => {
            writeLauncherLog("INFO", "Game", `${executable} exited with code ${code}, signal ${signal}`);
        });
    });
    return game;
}
