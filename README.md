# Amethyst Launcher

Launcher for Minecraft Bedrock mods created with AmethystAPI

## 📚 Getting Started

### **Requirements**

**OS**: Windows 10 (Minimum)\
**Other**: Minecraft Bedrock Edition

> [!IMPORTANT]
> Amethyst Launcher won't work if you do not own Minecraft Bedrock Edition

### Installation

1. Download the latest installer version
   from [releases](https://github.com/FrederoxDev/Amethyst-Launcher/releases/latest)
2. Run the installer and follow the installation steps
3. Start the launcher

### Linux tool setup

On x86_64 Linux, open **Settings → Tools** to verify [UMU Launcher](https://github.com/raonygamer/umu-launcher), [ProtonGDK](https://github.com/raonygamer/gdk-proton), and [Xodus](https://github.com/raonygamer/xodus) separately. UMU and ProtonGDK use their release downloads. Xodus builds from source, with an editable upstream.

Xodus compiles with the job count returned by `nproc`. Its source (including Git history) and Cargo artifacts stay in `tools/xodus.build`, outside the installation staging folder. Failed builds reuse completed work on retry; `tools/xodus.build/source` also supports `git diff`.

The launcher checks for missing build dependencies and installs them with the native package
manager (`apt-get`, `dnf`, `pacman`, `zypper`, or `apk`). Administrator prompts use `pkexec`,
or an available sudo askpass, cached sudo authorization, or a terminal running sudo/doas.
If no supported prompt or package manager is available, setup explains how to proceed manually.
Rust must meet the version required by Xodus's source manifest; older distro Rust packages may
need a toolchain update before building.

Only Xodus dependency installation needs administrator rights. Xodus builds and installs in
`~/.amethyst/launcher/tools/` as the current user, while the launcher is running. Verification
checks existing builds and downloads/builds missing or broken tools. Builds can take considerable
time and temporary disk space. A failed rebuild preserves the previous installation.
Successful verification is saved separately for each installed revision. Launch checks UMU, ProtonGDK and Xodus;
downloads, imports, licence retrieval and account login check Xodus. These actions automatically
verify tools that have not succeeded yet, and share an in-progress verification rather than starting
duplicate builds. Settings can explicitly repeat verification for each tool. Xodus checks for source updates and builds a newer revision when available.

Setup also enables `xodus-service` as the user service `amethyst-xodus.service`. It starts on
login and restarts after exiting, inheriting your desktop session’s `HOME` and
`XDG_RUNTIME_DIR`. Account IPC uses `$XDG_RUNTIME_DIR/xodus.sock`. On desktops without a
working systemd user manager, setup uses desktop autostart with a restart loop instead.
Setup verifies that the service opens `~/.amethyst/runtime/xodus.sock` before reporting success.

Linux launches use UMU with ProtonGDK and each profile's `~/.amethyst/launcher/profile_data/<profile UUID>/prefix`. UMU/Proton manages prefix setup. Game launches inherit the session environment without launcher overrides for `HOME` or `XDG_RUNTIME_DIR`. The launcher waits for acknowledgment of the online-features warning when both Xodus and its account session are unavailable. Game output remains available in Console.

Explicit profile environment variables are reapplied at Proton's entry point after Steam's container starts. Without explicit profile entries, HOME and runtime retain the defaults supplied by the session and container.

## 🕹️ Usage

### Live console

The terminal icon near the bottom of the sidebar opens the live **Console**. It shows launcher
activity, setup and compiler output, download progress, and game stdout/stderr as they arrive.
Scroll up to pause automatic scrolling, or use **Follow latest** to return to new output.
Search, copy, and clear operate on the recent output in this view; clearing keeps saved log files.
Filter by level, source, or component alongside text search. Copy includes only the visible output.

The download icon opens **Downloads and actions**, with separate progress for simultaneous builds,
downloads and other work. Downloads show transferred bytes and current speed; cancellable transfers
have a Cancel button. Closing the popup leaves work running.

### Linux account

On Linux, the account button near the bottom of the sidebar shows your Xbox avatar, with your gamertag in its tooltip.
Open **Account** to view the current Xodus session, email and service connection status. The launcher
checks `xodus-service` over its local socket and uses that session to retrieve the Xbox profile.
Status refreshes automatically and can also be refreshed manually. Authentication tokens stay in
the main process.

Automatic account/profile refreshes run hourly and reuse an in-memory cache. **Refresh** forces a real request. **Log out of Xodus** calls `xodus-cli logout`; successful login/logout clears cached account data and refreshes immediately. Profile rate limits are shown explicitly, with automatic retries backed off while the last known avatar stays visible for the same account.

On Linux, the launcher reads a small XVD header and asks `xodus-cli license` for its content licence before downloading the full game. Decryption obtains the licence again. A Xodus entitlement denial shows an ownership error; connection failures remain separate errors. Windows continues using its existing keys.

If the account is unavailable, select **Log in with Xodus** to open the installed `xodus-cli login`
window. It uses the same Amethyst home and runtime directories as the service. Account status
refreshes when the window closes. Prepare the Linux tools first if Xodus is not installed.

Xodus does not expose email over IPC, so the launcher reads only its saved account metadata using
`secret-tool` (included in Linux setup dependencies). Missing metadata or an unavailable profile service is shown on the
page. Account and Linux tool controls appear only on Linux; Console is available on Windows too.

### Launching

Closing the window keeps Amethyst running in the background so builds, downloads and game output
continue. Use the tray menu to reopen the launcher or **Quit Amethyst Launcher** to exit fully.
Profile links launch without bringing the launcher window forward, including a cold start.

On Linux, profiles also appear in the application menu. Their shortcuts are stored in
`$XDG_DATA_HOME/applications` (normally `~/.local/share/applications`), are named
**Minecraft - &lt;profile name&gt;**, show the version description, and use `minecraftIcon.ico` from
that profile's installed game folder. Until its game icon is available, they use the launcher icon.
They launch `amethyst-launcher://launchprofile/<UUID>`. Saving profile edits
updates the shortcut; deleting a profile removes it. Existing profiles are synchronized on startup.
Installing a new Latest/Preview version also refreshes its shortcut icon and version description.

You can launch the game from the **Launcher Page**, which can be accessed by clicking on the **Crafting Table Icon** in
the navigation bar.

To launch the game, click the **'Launch Game'** button.

To change the selected profile, click on the **'Profiles'** dropdown next to the **'Launch Game'** button, and select
the desired one.

Choose **Latest Version** or **Preview Version** in the version picker to follow the release or
preview channel automatically. Each launch fetches a fresh version list and installs the newest
matching version if needed. These choices require an online update check; fixed versions keep
their existing behavior. Updates retain your profile selection and do not delete older installs.

> [!NOTE]
> When launching, the launcher will search for the version specified by the selected profile. If no installed version is
> found, it will automatically install the specified version.

### Profiles

You can view and create profiles in the **Profile Manager**, which can be accessed by clicking on the **Chest Icon** in
the navigation bar.

To create a new profile, click the **'Create New Profile'** button at the bottom of the **Profile Manager**.
You will then need to input your profile's name, and select the version and runtime that it uses. If you are using a
modded runtime, then you can also select which mods the profile will use.

The profile editor's **Environment variables** field saves automatically and applies when that profile launches on Linux or Windows. Enter one `NAME=value` per line, for example `WINEDEBUG=-all` or `DXVK_HUD=fps`. Values are literal: omit shell quotes and do not use shell expansion. On Linux, the launcher manages `WINEPREFIX` and `PROTONPATH`; other entries override the launch defaults.

> #### Vanilla Profile Example:
>
> **- Profile Name**: Vanilla 1.21\
> **- Minecraft Version**: 1.21.2.2\
> **- Runtime**: Vanilla

> #### Modded Profile Example:
>
> **- Profile Name**: Amethyst 1.21\
> **- Minecraft Version**: 1.21.0.3\
> **- Runtime**: AmethystRuntime@1.3.1

To edit an existing profile, click on the desired profile in the **Profile Manager**, change the profile's settings and
then click the **'Save Profile'** button, or if you want to delete the profile, click the **'Delete Profile'** button.

### Mods & Runtimes

You can view installed mods and runtimes in the **Mod Manager**, which can be accessed by clicking on the **Shulker Icon
** in the navigation bar.

To import a new mod or runtime, you can either do it automatically or manually.

**Automatically:** Select the mod or runtimes `.zip` file, or unzipped folder, and drag it into the launcher.

**Manually:** Click the **'Open Mod Folder'** button at the bottom of the **Mod Manager**. This will open the launcher's
mods folder in a new file explorer window.
Then, copy the mod's `.zip` file into the mods folder, and unzip it.

> [!IMPORTANT]
> Make sure your mods folder structure looks like this
>
> ```
> Mods
> └── Mod
>     ├── File
>     ├── File
>     └── File
> ```
>
> and **NOT** this
>
> ```
> Mods
> └── Mod
>     └── Mod
>         ├── File
>         ├── File
>         └── File
> ```

> [!NOTE]
> Mods only support specific versions, and may not support the latest versions of minecraft.

### Versions

You can view currently installed versions in the **Version Manager**, which can be accessed by clicking on the **Portal
Icon** in the navigation bar.

In the **Version Manager**, you can delete versions, view where they are installed, or view extra info about them.

> [!NOTE]
> Deleting a version will **NOT** remove the profiles that are using that version. This will only remove the installed
> version from your local storage device.
