export type LinuxTool = "xodus";
export type PackageManager = "apt-get" | "dnf" | "pacman" | "zypper" | "apk";

export interface Command {
    command: string;
    args: string[];
}

interface Dependency {
    tools: LinuxTool[];
    probe: Command;
    executableOnly?: boolean;
    packages: Record<PackageManager, string[]>;
}

const xodus: LinuxTool[] = ["xodus"];

function dependency(tools: LinuxTool[], probe: Command, apt: string, fedora: string, arch: string, suse: string, alpine: string): Dependency {
    return { tools, probe, packages: {
        "apt-get": apt.split(" "), dnf: fedora.split(" "), pacman: arch.split(" "), zypper: suse.split(" "), apk: alpine.split(" "),
    } };
}

const binary = (command: string): Command => ({ command, args: ["--version"] });
const library = (name: string): Command => ({ command: "pkg-config", args: ["--exists", name] });

/** Probe capabilities, so an alternative provider or an already configured system needs no elevation. */
export const LINUX_DEPENDENCIES: Dependency[] = [
    dependency(xodus, binary("git"), "git", "git", "git", "git", "git"),
    dependency(xodus, binary("gcc"), "build-essential", "gcc gcc-c++ make", "base-devel", "gcc gcc-c++ make", "build-base"),
    dependency(xodus, binary("g++"), "g++", "gcc-c++", "gcc", "gcc-c++", "g++"),
    dependency(xodus, binary("pkg-config"), "pkg-config", "pkgconf-pkg-config", "pkgconf", "pkgconf-pkg-config", "pkgconf"),
    dependency(["xodus"], binary("rustc"), "rustc", "rust", "rust", "rust", "rust"),
    dependency(["xodus"], binary("cargo"), "cargo", "cargo", "rust", "cargo", "cargo"),
    dependency(["xodus"], binary("protoc"), "protobuf-compiler", "protobuf-compiler", "protobuf", "protobuf-devel", "protobuf-dev"),
    dependency(["xodus"], binary("cmake"), "cmake", "cmake", "cmake", "cmake", "cmake"),
    // secret-tool has no successful --version/--help command. Only probe its presence;
    // credential lookup belongs to the account reader, never the build/logging runner.
    { ...dependency(["xodus"], binary("secret-tool"), "libsecret-tools", "libsecret", "libsecret", "libsecret-tools", "libsecret"), executableOnly: true },
    dependency(["xodus"], library("gtk+-3.0"), "libgtk-3-dev", "gtk3-devel", "gtk3", "gtk3-devel", "gtk+3.0-dev"),
    dependency(["xodus"], library("webkit2gtk-4.1"), "libwebkit2gtk-4.1-dev", "webkit2gtk4.1-devel", "webkit2gtk-4.1", "webkit2gtk3-devel", "webkit2gtk-4.1-dev"),
    dependency(["xodus"], library("openssl"), "libssl-dev", "openssl-devel", "openssl", "libopenssl-devel", "openssl-dev"),
    dependency(xodus, library("dbus-1"), "libdbus-1-dev", "dbus-devel", "dbus", "dbus-1-devel", "dbus-dev"),
];

/** ID and ID_LIKE choose the native manager on machines with multiple managers installed. */
export function selectPackageManager(osRelease: string, available: PackageManager[]): PackageManager | null {
    const fields = Object.fromEntries(osRelease.split("\n").filter(line => /^(ID|ID_LIKE)=/.test(line))
        .map(line => { const at = line.indexOf("="); return [line.slice(0, at), line.slice(at + 1).replace(/["']/g, "")]; }));
    for (const id of `${fields.ID ?? ""} ${fields.ID_LIKE ?? ""}`.split(/\s+/)) {
        const manager: PackageManager | undefined = {
            debian: "apt-get", ubuntu: "apt-get", linuxmint: "apt-get", pop: "apt-get",
            arch: "pacman", manjaro: "pacman", endeavouros: "pacman",
            fedora: "dnf", rhel: "dnf", centos: "dnf", rocky: "dnf", almalinux: "dnf",
            opensuse: "zypper", "opensuse-tumbleweed": "zypper", "opensuse-leap": "zypper", suse: "zypper",
            alpine: "apk",
        }[id] as PackageManager | undefined;
        if (manager && available.includes(manager)) return manager;
    }
    return available.length === 1 ? available[0] : null;
}

export function packageInstallCommand(manager: PackageManager, packages: string[]): Command {
    const flags: Record<PackageManager, string[]> = {
        "apt-get": ["install", "-y"], dnf: ["install", "-y"],
        pacman: ["-S", "--needed", "--noconfirm"], zypper: ["--non-interactive", "install"], apk: ["add"],
    };
    return { command: manager, args: [...flags[manager], ...new Set(packages)] };
}

export function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'"'"'`)}'`;
}
