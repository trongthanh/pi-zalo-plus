// /zalo command handlers — manage the Zalo bot from the pi TUI.
//
// Zalo-specific bot management commands: on/off, pair/unpair, open/locked,
// reset, and status. Pattern adapted from
// pi-telegram-plus/lib/commands/telegram-commands.ts.

import type { CommandRegistry, SessionDeps, ZaloConfigDeps } from "./register.ts";
import type { ZaloConfig } from "../types.ts";
import { ensurePairingCode, isZaloEnabled } from "../config.ts";
import { formatPairingInstructions } from "../pairing.ts";

/**
 * Register TUI /zalo command and chat-native zalo command handler.
 *
 * The TUI /zalo command (registered via pi.registerCommand) uses ctx.ui.notify
 * to display in the terminal. The chat-native handler (used from Zalo messages)
 * sends replies via the transport directly.
 */
export function registerZaloCommands(
  registry: CommandRegistry,
  _sessionDeps: SessionDeps,
  configDeps?: ZaloConfigDeps,
): void {
  registry.registerCommand("zalo", {
    description: "Zalo bot: status, pair/unpair, on/off, reset",
    handler: async (args: string, ctx: any) => {
      const ui = ctx.ui;
      if (!configDeps) {
        ui.notify("Zalo config not available", "error");
        return;
      }
      const { getConfig, persistConfig } = configDeps;
      const config = getConfig();
      const sub = args.trim().toLowerCase();

      if (!sub || sub === "status") {
        const enabled = !!config.zaloToken && isZaloEnabled(config);
        const lines = [
          `Zalo bot: ${enabled ? "enabled" : "disabled"}`,
          `Bot: ${config.botName ?? "unknown"}`,
          `Access: ${config.openAccess === true ? "open (any user)" : config.allowedUserId !== undefined ? `paired (${config.allowedUserId})` : `unpaired (pairing code: ${config.pairingCode ?? "n/a"})`}`,
          `Message mode: ${config.messageMode ?? "steer"}`,
          `Tool render: ${config.tool ?? "brief"}`,
          `Thinking render: ${config.thinking ?? "brief"}`,
        ].filter(Boolean);
        ui.notify(lines.join("\n"), "info");
        return;
      }
      if (sub === "on" || sub === "off") {
        await persistConfig({ ...config, zaloEnabled: sub === "on" });
        ui.notify(`Zalo bot ${sub === "on" ? "enabled" : "disabled"}.`, "info");
        return;
      }
      if (sub === "pair") {
        const paired = ensurePairingCode({ ...config, openAccess: false, allowedUserId: undefined });
        await persistConfig(paired);
        ui.notify(formatPairingInstructions(paired), "warning");
        return;
      }
      if (sub === "unpair") {
        const paired = ensurePairingCode({ ...config, openAccess: false, allowedUserId: undefined });
        await persistConfig(paired);
        ui.notify("Zalo user unpaired. " + formatPairingInstructions(paired), "warning");
        return;
      }
      if (sub === "open") {
        await persistConfig({ ...config, openAccess: true, allowedUserId: undefined, pairingCode: undefined });
        ui.notify("Zalo bot set to open-access mode: any user can talk to it.", "info");
        return;
      }
      if (sub === "locked") {
        const paired = ensurePairingCode({ ...config, openAccess: false, allowedUserId: undefined });
        await persistConfig(paired);
        ui.notify("Zalo bot locked to pairing. " + formatPairingInstructions(paired), "warning");
        return;
      }
      if (sub === "reset") {
        await persistConfig({ ...config, lastUpdateId: undefined });
        ui.notify("Zalo update offset reset — the next poll replays undelivered updates.", "info");
        return;
      }
      ui.notify("Usage: /zalo [status|on|off|pair|unpair|open|locked|reset]", "info");
    },
  });
}

/** Build the chat-native /zalo command handler (replies via transport). */
export function buildChatZaloCommandHandler(
  getConfig: () => ZaloConfig,
  persistConfig: (config: ZaloConfig) => Promise<void>,
  _getActiveChatId: () => string | undefined,
  sendReply: (text: string) => void,
): (args: string) => Promise<void> {
  return async (args) => {
    const config = getConfig();
    const reply = sendReply;
    const sub = args.trim().toLowerCase();

    if (!sub || sub === "status") {
      const enabled = !!config.zaloToken && isZaloEnabled(config);
      reply([
        "<b>π Zalo status</b>",
        `Bot: ${config.botName ?? "unknown"}`,
        `Enabled: ${enabled ? "yes" : "no"}`,
        `Access: ${config.openAccess === true ? "open (any user)" : config.allowedUserId !== undefined ? `paired (${config.allowedUserId})` : `unpaired (code: ${config.pairingCode ?? "n/a"})`}`,
      ].filter(Boolean).join("\n"));
      return;
    }
    if (sub === "on" || sub === "off") {
      await persistConfig({ ...config, zaloEnabled: sub === "on" });
      reply(`Zalo bot ${sub === "on" ? "enabled" : "disabled"}.`);
      return;
    }
    if (sub === "pair" || sub === "unpair" || sub === "locked") {
      const paired = ensurePairingCode({ ...config, openAccess: false, allowedUserId: undefined });
      await persistConfig(paired);
      reply(
        sub === "pair"
          ? formatPairingInstructions(paired)
          : sub === "unpair"
            ? "Zalo user unpaired. " + formatPairingInstructions(paired)
            : "Zalo bot locked to pairing. " + formatPairingInstructions(paired),
      );
      return;
    }
    if (sub === "open") {
      await persistConfig({ ...config, openAccess: true, allowedUserId: undefined, pairingCode: undefined });
      reply("Zalo bot set to open-access mode: any user can talk to it.");
      return;
    }
    if (sub === "reset") {
      await persistConfig({ ...config, lastUpdateId: undefined });
      reply("Zalo update offset reset — the next poll replays undelivered updates.");
      return;
    }
    reply("Usage: /zalo [status|help|on|off|pair|unpair|open|locked|reset]");
  };
}
