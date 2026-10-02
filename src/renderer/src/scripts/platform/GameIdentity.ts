import type { Channel } from "@renderer/scripts/domain/Channel";

export const CHANNEL_IDS: Record<Channel, { displayName: string; protocol: string; titleId: string; storeId: string; msaAppId: string }> = {
    release: {
        displayName: "Minecraft for Windows",
        protocol: "minecraft",
        titleId: "35760C07",
        storeId: "9NBLGGH2JHXJ",
        msaAppId: "0000000040159362",
    },
    preview: {
        displayName: "Minecraft Preview for Windows",
        protocol: "minecraft-preview",
        titleId: "717D695F",
        storeId: "9P5X4QVLC2XR",
        msaAppId: "00000000403FC600",
    },
};
