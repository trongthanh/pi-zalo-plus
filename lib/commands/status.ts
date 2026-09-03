// /status command — show bot and session status.
//
// Adapted from pi-telegram-plus/lib/commands/info.ts for Zalo
// (string chat IDs, no threads).

import type { CommandRegistry, InfoDeps } from "./register.ts";
import type { ZaloConfig } from "../types.ts";
import { isZaloEnabled } from "../config.ts";

function buildStatusHtml(config: ZaloConfig): string {
  const enabled = !!config.zaloToken && isZaloEnabled(config);
  const lines = [
    "<b>π Zalo status</b>",
    `Bot: ${config.botName ?? "unknown"}`,
    `Enabled: ${enabled ? "yes" : "no"}`,
    `Access: ${config.openAccess === true ? "open (any user)" : config.allowedUserId !== undefined ? `paired (${config.allowedUserId})` : `unpaired (code: ${config.pairingCode ?? "n/a"})`}`,
    `Message mode: ${config.messageMode ?? "steer"}`,
    `Tool render: ${config.tool ?? "brief"}`,
    `Thinking render: ${config.thinking ?? "brief"}`,
  ].join("\n");
  return lines;
}

export function registerStatusCommand(
  registry: CommandRegistry,
  getConfig: () => ZaloConfig,
  deps?: InfoDeps,
): void {
  registry.registerCommand("status", {
    description: "Show bot and session status",
    handler: async (_args: string, ctx: any) => {
      const ui = ctx.ui;
      const html = buildStatusHtml(getConfig());

      // Try direct send via transport first (richer HTML rendering)
      const transport = deps?.getTransport?.();
      const turn = deps?.getActiveTurn?.();
      const chatId = turn?.chatId ?? deps?.getActiveChatId?.();
      if (transport && chatId !== undefined) {
        await transport.sendText(chatId, html).catch(() => {
          ui.notify(html.replace(/<[^>]+>/g, ""), "info");
        });
        return;
      }
      ui.notify(html, "info");
    },
  });
}

/** Build a chat-native /status handler (replies via transport). */
export function buildChatStatusHandler(
  getConfig: () => ZaloConfig,
  _getActiveChatId: () => string | undefined,
  sendReply: (text: string) => void,
): () => void {
  return () => {
    const config = getConfig();
    sendReply(buildStatusHtml(config));
  };
}
