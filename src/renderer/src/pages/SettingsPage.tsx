import { DEFAULT_LINUX_TOOL_SETTINGS, toolBuildSettings } from "@shared/linux/LinuxToolSettings";
import { TextInput } from "@renderer/components/TextInput";
import { useEffect, useState } from "react";

import { MinecraftRadialButtonPanel } from "@renderer/components/MinecraftRadialButtonPanel";
import { MinecraftToggle } from "@renderer/components/MinecraftToggle";
import { ReadOnlyTextBox } from "@renderer/components/ReadOnlyTextBox";
import { MinecraftButton } from "@renderer/components/MinecraftButton";
import { prepareLinuxTool, type LinuxSetupTool } from "@renderer/flows/LinuxToolsSetup";
import { ProgressBar } from "@renderer/states/ProgressBarStore";
import { confirmAction } from "@renderer/popups/ConfirmPopup";

import { describeError, userMessage } from "@shared/diagnostics/Log";
import { log } from "@renderer/scripts/LauncherLog";
import { useAppStore } from "@renderer/states/AppStore";

const fs = window.require("fs") as typeof import("fs");

export function GeneralSettingsTab() {
    const keepLauncherOpen = useAppStore(state => state.keepLauncherOpen);
    const setKeepLauncherOpen = useAppStore(state => state.setKeepLauncherOpen);
    const developerMode = useAppStore(state => state.developerMode);
    const setDeveloperMode = useAppStore(state => state.setDeveloperMode);
    const lastLaunchedProfileUuid = useAppStore(state => state.lastLaunchedProfileUuid);
    const UITheme = useAppStore(state => state.UITheme);
    const setUITheme = useAppStore(state => state.setUITheme);
    const platform = useAppStore(state => state.platform);
    const paths = platform.getPaths();
    const [launcherCfg, setLauncherCfg] = useState<string>("");
    useEffect(() => {
        let cancelled = false;
        fs.promises.readFile(paths.launcherConfigPath, "utf-8")
            .then(text => { if (!cancelled) setLauncherCfg(text); })
            .catch(e => {
                if (cancelled) return;
                if ((e as { code?: string }).code === "ENOENT") {
                    log("Settings", `No launcher config to show at ${paths.launcherConfigPath}`);
                    setLauncherCfg("No launcher config has been saved yet.");
                    return;
                }
                log("Settings", `Could not read ${paths.launcherConfigPath} for display: ${describeError(e)}`);
                setLauncherCfg(`${paths.launcherConfigPath}\n\nCould not be read: ${userMessage(e)}`);
            });
        return () => { cancelled = true; };
    }, [paths.launcherConfigPath, lastLaunchedProfileUuid, keepLauncherOpen, developerMode, UITheme]);

    return (
        <div className="settings-page settings-scroll-hidden">
            <div className="settings-section">
                <div className="settings-row">
                    <div>
                        <p className="minecraft-seven settings-title">Keep launcher open</p>
                        <p className="minecraft-seven settings-subtitle">
                            Prevents the launcher from closing after launching the game.
                        </p>
                    </div>
                    <div className="settings-toggle-wrap">
                        <MinecraftToggle isChecked={keepLauncherOpen} setIsChecked={setKeepLauncherOpen} />
                    </div>
                </div>
                <div className="settings-row">
                    <div>
                        <p className="minecraft-seven settings-title">Developer mode</p>
                        <p className="minecraft-seven settings-subtitle">
                            Enables hot-reloading and prompting to attach a debugger.
                        </p>
                    </div>
                    <div className="settings-toggle-wrap">
                        <MinecraftToggle isChecked={developerMode} setIsChecked={setDeveloperMode} />
                    </div>
                </div>
            </div>

            <div className="popup-divider" />

            <div className="settings-regular">
                <p className="minecraft-seven settings-title">UI Theme</p>
                <MinecraftRadialButtonPanel
                    elements={[
                        { text: "Light", value: "Light" },
                        { text: "Dark", value: "Dark" },
                        { text: "System", value: "System" },
                    ]}
                    default_selected_value={UITheme}
                    onChange={value => {
                        setUITheme(value);
                    }}
                />
            </div>

            <div className="minecraft-seven settings-debug">
                <p className="settings-debug-title">Debug Info</p>
                <p>Running Platform: {platform.getPlatformFullName()}</p>
                <p>Amethyst Folder: {paths.amethystPath}</p>
            </div>

            <div className="settings-regular">
                <ReadOnlyTextBox text={launcherCfg} label="Launcher Config" />
            </div>
        </div>
    );
}

export function ToolsSettingsTab({ onBeforeVerify }: { onBeforeVerify?: () => void }) {
    const savedSettings = useAppStore(state => state.linuxToolSettings);
    const saveSettings = useAppStore(state => state.setLinuxToolSettings);
    const [settings, setSettings] = useState(() => ({ ...savedSettings }));
    const [settingsError, setSettingsError] = useState("");
    const save = (): boolean => {
        try {
            toolBuildSettings("xodus", settings);
            saveSettings({ ...settings });
            setSettingsError("");
            return true;
        } catch (error) { setSettingsError(userMessage(error)); return false; }
    };
    const [running, setRunning] = useState<LinuxSetupTool | null>(null);
    const [message, setMessage] = useState("");
    const busy = ProgressBar.useIsBusy();
    const verify = async (tool: LinuxSetupTool): Promise<void> => {
        if (!save()) return;
        setRunning(tool);
        setMessage("");
        // Release the Settings popup so a dependency permission prompt can be displayed.
        onBeforeVerify?.();
        try {
            const result = await prepareLinuxTool(tool);
            setMessage(result);
            if (onBeforeVerify) await confirmAction({ title: `${tool === "xodus" ? "Xodus" : tool} ready`, message: result, confirmText: "Done", cancelText: "Close" });
        } catch (error) {
            log("LinuxSetup", describeError(error));
            useAppStore.getState().setError(userMessage(error));
        } finally { setRunning(null); }
    };
    return (
        <div className="settings-page settings-scroll-hidden">
            <div className="settings-regular minecraft-seven settings-tools-intro">
                <p>UMU Launcher and ProtonGDK are downloaded when needed. Xodus is built on this computer and verified before account and licence actions. Verify checks for updates; Xodus may ask for permission to install build dependencies.</p>
            </div>
            {([
                { id: "UMULauncher", name: "UMU Launcher", description: "Launches Minecraft through Proton using each profile’s Wine prefix." },
                { id: "GDKProton", name: "ProtonGDK", description: "The Proton build used by UMU to run Minecraft on Linux." },
                { id: "xodus", name: "Xodus", description: "Provides account login and game licences. Verification also sets up its background service." },
            ] as const).map(tool => (
                <div className="settings-regular settings-tool" key={tool.id}>
                    <div>
                        <p className="minecraft-seven settings-title">{tool.name}</p>
                        <p className="minecraft-seven settings-subtitle">{tool.description}</p>
                    </div>
                    <div className="settings-tool-verify"><MinecraftButton text={running === tool.id ? `Verifying ${tool.name}...` : `Verify ${tool.name}`}
                        disabled={running !== null || busy} onClick={() => { void verify(tool.id); }} /></div>
                    {tool.id === "xodus" && <div className="settings-tool-fields">
                        <TextInput label="Xodus upstream" text={settings.xodusUpstream}
                            setText={value => setSettings(current => ({ ...current, xodusUpstream: value }))} />
                    </div>}
                </div>
            ))}
            <div className="settings-regular minecraft-seven settings-tools-intro">
                <p>For Xodus, use a Git URL or owner/repository. Custom upstreams use their default branch.</p>
                <p>Save upstream changes, then Verify Xodus to rebuild now, or let the next action that needs Xodus rebuild it.</p>
            </div>
            <div className="settings-actions">
                <MinecraftButton text="Save changes" disabled={running !== null || busy} onClick={() => { if (save()) setMessage("Tool settings saved."); }} />
                <MinecraftButton text="Reset fields" disabled={running !== null || busy} onClick={() => { setSettings({ ...DEFAULT_LINUX_TOOL_SETTINGS }); setSettingsError(""); setMessage(""); }} />
            </div>
            {settingsError && <p role="alert" className="settings-regular minecraft-seven">{settingsError}</p>}
            {message && <p role="status" className="settings-regular minecraft-seven" style={{ whiteSpace: "pre-line" }}>{message}</p>}
        </div>
    );
}

export function SettingsTabs({ onBeforeVerify }: { onBeforeVerify?: () => void } = {}) {
    const [tab, setTab] = useState("general");
    const tabs = window.process.platform === "linux"
        ? [{ id: "general", title: "General" }, { id: "tools", title: "Tools" }]
        : [{ id: "general", title: "General" }];
    return (
        <div className="settings-tabs">
            <div className="settings-tab-list" role="tablist" aria-label="Settings">
                {tabs.map(item => (
                    <button key={item.id} type="button" role="tab" id={`settings-tab-${item.id}`}
                        aria-selected={tab === item.id} aria-controls={`settings-panel-${item.id}`}
                        tabIndex={tab === item.id ? 0 : -1}
                        onKeyDown={event => {
                            const index = tabs.findIndex(value => value.id === tab);
                            const next = event.key === "ArrowRight" ? (index + 1) % tabs.length
                                : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length
                                : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : -1;
                            if (next < 0) return;
                            event.preventDefault();
                            setTab(tabs[next].id);
                            document.getElementById(`settings-tab-${tabs[next].id}`)?.focus();
                        }}
                        className="minecraft-seven settings-tab" onClick={() => setTab(item.id)}>{item.title}</button>
                ))}
            </div>
            <div role="tabpanel" id={`settings-panel-${tab}`} aria-labelledby={`settings-tab-${tab}`}>
                {tab === "tools" ? <ToolsSettingsTab onBeforeVerify={onBeforeVerify} /> : <GeneralSettingsTab />}
            </div>
        </div>
    );
}

export function SettingsPage() {
    return <SettingsTabs />;
}
