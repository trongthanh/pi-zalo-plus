// Lifecycle commands: /stop, /cancel, /compact, /reload, /quit.
//
// Adapted from pi-telegram-plus/lib/commands/lifecycle.ts for Zalo.

import type { CommandRegistry } from "./register.ts";

export function registerLifecycleCommands(registry: CommandRegistry): void {
  // ── /compact ──────────────────────────────────────────────────────────
  registry.registerCommand("compact", {
    description: "Compact current session context",
    handler: async (args, ctx) => {
      const ui = ctx.ui;
      ctx.compact({
        customInstructions: args || undefined,
        onComplete: () => ui.notify("✅ Compaction completed.", "info"),
        onError: (error: Error) => ui.notify(`Compaction failed: ${error.message}`, "error"),
      });
      ui.notify("Compaction started.", "info");
    },
  });

  // ── /reload ────────────────────────────────────────────────────────────
  registry.registerCommand("reload", {
    description: "Reload extensions, skills, prompts, and themes",
    handler: async (_args, ctx) => {
      const ui = ctx.ui;
      ui.notify("Reloading…", "info");
      await ctx.reload();
    },
  });

  // ── /stop ─────────────────────────────────────────────────────────────
  registry.registerCommand("stop", {
    description: "Stop the current agent turn",
    handler: async (_args, ctx) => {
      const ui = ctx.ui;
      ctx.abort();
      ui.notify("⏹ Stopped.", "info");
    },
  });

  // ── /quit ──────────────────────────────────────────────────────────────
  registry.registerCommand("quit", {
    description: "Shut down pi",
    handler: async (_args, ctx) => {
      const ui = ctx.ui;
      const confirmed = await ui.confirm("Quit", "Shut down pi?");
      if (confirmed) {
        ctx.shutdown();
        ui.notify("Shutdown requested. If pi keeps running, stop it from the TUI/terminal.", "info");
      }
    },
  });
}
