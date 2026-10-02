import { DEFAULT_LINUX_TOOL_SETTINGS, toolBuildSettings, type LinuxToolSettings } from "./LinuxToolSettings.ts";
import { run, type ProcessResult, type RunOptions } from "../diagnostics/ProcessRunner.ts";
import { LINUX_DEPENDENCIES, packageInstallCommand, selectPackageManager, shellQuote,
    type Command, type LinuxTool, type PackageManager } from "./LinuxDependencies.ts";

const require = (globalThis as unknown as { require: NodeRequire }).require;
const fs = require("fs") as typeof import("fs");
const os = require("os") as typeof import("os");
const path = require("path") as typeof import("path");

export const LINUX_SOURCES = {
    xodus: { repository: "raonygamer/xodus", branch: "main", executables: ["bin/xodus-cli", "bin/xodus-service"] },
} as const;

export type Execute = (command: string, args: string[], options?: RunOptions) => Promise<ProcessResult>;

/** Includes user-installed Rust, even when Electron was started from a desktop shortcut. */
export function buildEnvironment(): NodeJS.ProcessEnv {
    return { PATH: [path.join(os.homedir(), ".cargo", "bin"), path.join(os.homedir(), ".local", "bin"), process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"].join(path.delimiter) };
}

export function findExecutable(name: string): string | null {
    for (const folder of (buildEnvironment().PATH ?? "").split(path.delimiter)) {
        if (!folder || !path.isAbsolute(folder)) continue;
        const candidate = path.join(folder, name);
        try {
            fs.accessSync(candidate, fs.constants.X_OK);
            if (fs.statSync(candidate).isFile()) return candidate;
        } catch { /* Not installed in this PATH entry. */ }
    }
    return null;
}

export async function checked(command: string, args: string[], options: RunOptions = {}, execute: Execute = run): Promise<ProcessResult> {
    options.onLine?.(`Running: ${[command, ...args].map(shellQuote).join(" ")}`);
    const result = await execute(command, args, { ...options, env: { ...buildEnvironment(), ...options.env } });
    if (result.code !== 0 || result.timedOut || result.spawnError) {
        throw new Error(`${path.basename(command)} ${args.join(" ")} failed${result.timedOut ? " (timed out)" : ` (exit ${result.code})`}.\n\n`
            + (result.spawnError || result.output.slice(-6000) || "The process returned no details."));
    }
    options.onLine?.(`${path.basename(command)} completed in ${(result.durationMs / 1000).toFixed(1)}s`);
    return result;
}

export interface DependencyPlan {
    missing: string[];
    install: Command | null;
}

export async function inspectDependencies(tools: LinuxTool[], execute: Execute = run): Promise<DependencyPlan> {
    const available = (["apt-get", "dnf", "pacman", "zypper", "apk"] as PackageManager[]).filter(manager => findExecutable(manager));
    const manager = selectPackageManager(fs.readFileSync("/etc/os-release", "utf8"), available);
    const missing: string[] = [];
    const packages: string[] = [];
    for (const dependency of LINUX_DEPENDENCIES.filter(dep => dep.tools.some(tool => tools.includes(tool)))) {
        if (dependency.executableOnly) {
            if (findExecutable(dependency.probe.command)) continue;
        } else {
            const probe = await execute(dependency.probe.command, dependency.probe.args, { env: buildEnvironment(), timeoutMs: 10_000 });
            if (probe.code === 0 && !probe.timedOut && !probe.spawnError) continue;
        }
        missing.push(dependency.probe.command === "pkg-config" ? dependency.probe.args[1] : dependency.probe.command);
        if (manager) packages.push(...dependency.packages[manager]);
    }
    return { missing, install: manager && packages.length ? packageInstallCommand(manager, packages) : null };
}

/** Only the package manager runs as root; clones, builds and local installs run as the user. */
export async function installDependencies(command: Command, onLine: (line: string) => void, execute: Execute = run): Promise<void> {
    // Use a system binary, never a package-manager lookalike from a user-writable PATH.
    const manager = ["/usr/bin", "/usr/sbin", "/sbin", "/bin"].map(dir => path.join(dir, command.command)).find(file => {
        try { fs.accessSync(file, fs.constants.X_OK); return true; } catch { return false; }
    });
    if (!manager) throw new Error(`The system package manager ${command.command} could not be found.`);
    const options: RunOptions = { timeoutMs: 60 * 60_000, onLine };
    if (process.getuid?.() === 0) {
        await checked(manager, command.args, options, execute);
        return;
    }
    const pkexec = findExecutable("pkexec");
    if (pkexec) {
        const result = await execute(pkexec, [manager, ...command.args], options);
        const noAgent = /No authentication agent|No session for cookie|Error opening.*terminal|cannot open.*tty/i.test(result.output);
        if (result.code === 126 || (result.code === 127 && !noAgent)) {
            throw new Error("Administrator permission was cancelled or denied. No build was started.\n\n" + result.output.slice(-2000));
        }
        if (result.code === 0 && !result.timedOut && !result.spawnError) return;
        if (!noAgent || result.timedOut) {
            throw new Error(`Dependency installation failed.\n\n${result.spawnError || result.output.slice(-6000) || `Exit ${result.code}`}`);
        }
        onLine("No graphical authentication agent is available; trying the system's other administrator prompts.");
    }
    const sudo = findExecutable("sudo");
    if (sudo && process.env.SUDO_ASKPASS) {
        await checked(sudo, ["-A", manager, ...command.args], options, execute);
        return;
    }
    if (sudo && (await execute(sudo, ["-n", "true"], { timeoutMs: 10_000 })).code === 0) {
        await checked(sudo, ["-n", manager, ...command.args], options, execute);
        return;
    }
    const elevate = sudo ?? findExecutable("doas");
    // Use terminals that stay attached to their child. x-terminal-emulator can be a
    // daemonizing alternative, which would return before its install script finishes.
    const terminals = [
        { name: "gnome-terminal", args: ["--wait", "--"] },
        { name: "konsole", args: ["--nofork", "-e"] },
        { name: "xterm", args: ["-e"] },
    ];
    const terminal = terminals.find(entry => findExecutable(entry.name));
    if (!elevate || !terminal) {
        throw new Error("No administrator prompt is available. Install the dependencies in a terminal, then retry:\n\n"
            + ["sudo", manager, ...command.args].map(shellQuote).join(" "));
    }
    const temporary = await fs.promises.mkdtemp(path.join(os.tmpdir(), "amethyst-dependencies-"));
    const statusFile = path.join(temporary, "status");
    const script = path.join(temporary, "install.sh");
    try {
        await fs.promises.writeFile(script, "#!/bin/sh\n"
            + [elevate, manager, ...command.args].map(shellQuote).join(" ")
            + `\nresult=$?\nprintf '%s' "$result" > ${shellQuote(statusFile)}\n`
            + 'if [ "$result" -ne 0 ]; then printf "\\nInstallation failed. Press Enter to close.\\n"; read -r reply; fi\nexit "$result"\n', { mode: 0o700 });
        await execute(findExecutable(terminal.name)!, [...terminal.args, "/bin/sh", script], options);
        // Terminal emulators do not consistently propagate the child exit code.
        const status = await fs.promises.readFile(statusFile, "utf8").catch(() => "cancelled");
        if (status !== "0") throw new Error(`Dependency installation did not finish successfully (${status}). Retry and complete the administrator prompt.`);
    } finally {
        await fs.promises.rm(temporary, { recursive: true, force: true });
    }
}

export async function sourceRevision(tool: LinuxTool, timeoutMs: number, execute: Execute = run,
    onLine: (line: string) => void = () => {}, settings: LinuxToolSettings = DEFAULT_LINUX_TOOL_SETTINGS): Promise<string> {
    const source = LINUX_SOURCES[tool];
    const remote = toolBuildSettings(tool, settings).upstream;
    const branch = remote === toolBuildSettings(tool).upstream ? `refs/heads/${source.branch}` : "HEAD";
    const branchLabel = branch === "HEAD" ? "the upstream default branch" : source.branch;
    const result = await checked("git", ["ls-remote", remote, branch], { timeoutMs }, execute);
    const revision = result.stdout.trim().split(/\r?\n/)
        .map(line => line.split(/\s+/)).find(([, ref]) => ref === branch)?.[0] ?? "";
    if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error(`The upstream returned no valid ${branchLabel} revision for ${tool}.`);
    onLine(`Selected ${tool} ${branchLabel} (${revision}).`);
    return revision;
}

/** The service has no --help/--version switch: starting it would provision credentials and open a socket. */
export async function verifySource(tool: LinuxTool, folder: string, execute: Execute = run): Promise<void> {
    for (const executable of LINUX_SOURCES[tool].executables) {
        const file = path.join(folder, executable);
        await fs.promises.access(file, fs.constants.X_OK);
        const linkage = await checked("ldd", [file], { timeoutMs: 30_000 }, execute);
        if (/=>\s+not found/.test(linkage.output)) throw new Error(`${tool} is missing runtime libraries.\n\n${linkage.output}`);
        if (!executable.endsWith("xodus-service")) await checked(file, ["--version"], { timeoutMs: 30_000 }, execute);
    }
}

/** Keep the Git checkout and Cargo cache outside the disposable installation staging folder. */
export async function buildSource(tool: LinuxTool, revision: string, staging: string, installation: string,
    onStatus: (message: string) => void, onLine: (line: string) => void, execute: Execute = run,
    settings: LinuxToolSettings = DEFAULT_LINUX_TOOL_SETTINGS): Promise<void> {
    if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error("Invalid source revision.");
    const selected = toolBuildSettings(tool, settings);
    const workspace = `${installation}.build`;
    const checkout = path.join(workspace, "source");
    onLine(`Source and incremental build cache: ${workspace}`);
    await fs.promises.mkdir(checkout, { recursive: true });
    const options: RunOptions = { cwd: checkout, timeoutMs: 10 * 60_000, onLine };
    onStatus(`Fetching ${tool} source...`);
    await checked("git", ["init", "--quiet"], options, execute);
    await checked("git", ["config", "remote.origin.url", selected.upstream], options, execute);
    // Retain history for comparisons between upstream revisions as well as local edits.
    const deepen = fs.existsSync(path.join(checkout, ".git", "shallow")) ? ["--unshallow"] : [];
    await checked("git", ["fetch", ...deepen, "origin", revision], options, execute);
    await checked("git", ["checkout", "--detach", "FETCH_HEAD"], options, execute);
    await buildCheckout(tool, staging, installation, onStatus, onLine, execute, settings, workspace);
}

/** Separated so a build can be validated or resumed against an already fetched checkout. */
export async function buildCheckout(tool: LinuxTool, staging: string, installation: string,
    onStatus: (message: string) => void, onLine: (line: string) => void, execute: Execute = run,
    settings: LinuxToolSettings = DEFAULT_LINUX_TOOL_SETTINGS, workspace = `${installation}.build`): Promise<void> {
    const source = LINUX_SOURCES[tool];
    toolBuildSettings(tool, settings);
    await fs.promises.mkdir(staging, { recursive: true });
    const checkout = path.join(workspace, "source");
    const options: RunOptions = { cwd: checkout, timeoutMs: 10 * 60_000, onLine };
    const jobs = (await checked("nproc", [], { ...options, timeoutMs: 10_000 }, execute)).stdout.trim();
    if (!/^[1-9]\d*$/.test(jobs) || !Number.isSafeInteger(Number(jobs))) {
        throw new Error("nproc did not return a valid build job count.");
    }
    const buildOptions: RunOptions = { ...options, timeoutMs: 6 * 60 * 60_000 };
    onStatus(`Building ${tool} (${jobs} jobs)...`);
    const manifest = await fs.promises.readFile(path.join(checkout, "Cargo.toml"), "utf8");
    const required = manifest.match(/rust-version\s*=\s*"([\d.]+)"/)?.[1];
    const rust = await checked("rustc", ["--version"], options, execute);
    const installed = rust.stdout.match(/rustc (\d+\.\d+\.\d+)/)?.[1];
    if (required && (!installed || compareVersions(installed, required) < 0)) {
        throw new Error(`Xodus requires Rust ${required} or newer; found ${installed ?? "unknown"}. Update Rust, then retry.`);
    }
    await checked("cargo", ["build", "--release", "--workspace", "--locked", "--jobs", jobs], buildOptions, execute);
    await fs.promises.mkdir(path.join(staging, "bin"), { recursive: true });
    for (const executable of source.executables) {
        await fs.promises.copyFile(path.join(checkout, "target", "release", path.basename(executable)), path.join(staging, executable));
    }
    for (const executable of source.executables) await fs.promises.chmod(path.join(staging, executable), 0o755);
    // Keep the checkout (including .git), Cargo targets for retries and git diff.
}

function compareVersions(installed: string, required: string): number {
    const left = installed.split(".").map(Number);
    const right = required.split(".").map(Number);
    for (let i = 0; i < 3; i++) {
        const difference = (left[i] ?? 0) - (right[i] ?? 0);
        if (difference) return difference;
    }
    return 0;
}
