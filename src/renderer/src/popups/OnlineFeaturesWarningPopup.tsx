import { MinecraftButton } from "@renderer/components/MinecraftButton";
import { PopupPanel } from "@renderer/components/PopupPanel";
import { Popup } from "@renderer/states/PopupStore";

let pending: Promise<boolean> | null = null;

/** Keep one notice pending when several profiles are launched without dismissing it. */
export function showOnlineFeaturesWarning(): Promise<boolean> {
    pending ??= Popup.ask<boolean>(({ submit }) => (
        <PopupPanel
            title="Online features may be unavailable"
            onClose={() => submit(false)}
            size="sm"
            footerAlign="start"
            footer={<MinecraftButton text="OK" style={{ "--mc-button-container-h": "32px", "--mc-button-container-w": "120px" }} onClick={() => submit(true)} />}
        >
            <p className="minecraft-seven" style={{ fontSize: "12px", lineHeight: 1.5 }}>
                Xodus isn’t running and your account is unavailable. Online features may be unavailable.
                Select OK to launch Minecraft anyway.
            </p>
        </PopupPanel>
    )).finally(() => { pending = null; });
    return pending;
}
