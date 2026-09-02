// /help command — show available Zalo bot commands.
//
// Pattern adapted from pi-telegram-plus.

import type { CommandRegistry } from "./register.ts";

const HELP_TEXT = [
  "<b>π Zalo commands</b>",
  "/status — bot + session status",
  "/help — this help",
  "/stop — interrupt the running turn / cancel dialogs",
  "/cancel — cancel a pending dialog",
  "/zalo [status|on|off|pair|unpair|open|locked|reset] — manage the bot",
  "/zalo verbal=on|off — show/hide thinking + tool calls in chat (default off)",
  "",
  "Any other text is sent to π as a prompt. Slash commands supported by pi",
  "and other extensions (e.g. /new, /model, /compact) also work.",
].join("\n");

export function registerHelpCommand(registry: CommandRegistry): void {
  registry.registerCommand("help", {
    description: "Show command help",
    handler: async (_args, ctx) => {
      ctx.ui.notify(HELP_TEXT, "info");
    },
  });
}

export function buildChatHelpHandler(sendReply: (text: string) => void): () => void {
  return () => sendReply(HELP_TEXT);
}
