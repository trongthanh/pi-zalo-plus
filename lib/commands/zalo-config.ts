// /zalo-config command — configure Zalo message rendering and mode.
//
// Adapted from pi-telegram-plus/lib/commands/tg-config.ts for Zalo:
// controls tool/thinking render level, message mode, and verbal mode.

import type { CommandRegistry, ZaloConfigDeps } from "./register.ts";
import type { ZaloRenderLevel, ZaloMessageMode } from "../types.ts";
import { RENDER_LEVELS } from "../types.ts";

const MODE_VALUES: readonly ZaloMessageMode[] = ["queue", "steer"] as const;

const KEY_LABELS: Record<string, string> = {
  tool: "🔧 Tool rendering",
  thinking: "💭 Thinking rendering",
  mode: "📨 Message mode",
};

export function registerZaloConfigCommands(
  registry: CommandRegistry,
  deps: ZaloConfigDeps,
): void {
  registry.registerCommand("zalo-config", {
    description: "Configure Zalo message rendering and mode",
    handler: async (args: string, ctx: any) => {
      const ui = ctx.ui;
      const parts = args.trim().split(/\s+/);

      // Direct-set: /zalo-config <key> <value>
      if (parts.length >= 2 && parts[0]) {
        const key = parts[0];
        const value = parts[1];
        const config = deps.getConfig();

        if (key === "tool" || key === "thinking") {
          if (!(RENDER_LEVELS as readonly string[]).includes(value)) {
            ui.notify("Invalid. Use: /zalo-config <tool|thinking> <hidden|brief|full>", "error");
            return;
          }
          const next = key === "tool"
            ? { ...config, tool: value as ZaloRenderLevel }
            : { ...config, thinking: value as ZaloRenderLevel };
          deps.setConfig(next);
          await deps.persistConfig(next);
          ui.notify(`${key} set to ${value}`, "info");
          return;
        }
        if (key === "mode") {
          if (!(MODE_VALUES as readonly string[]).includes(value)) {
            ui.notify("Invalid. Use: /zalo-config mode <queue|steer>", "error");
            return;
          }
          const next = { ...config, messageMode: value as ZaloMessageMode };
          deps.setConfig(next);
          await deps.persistConfig(next);
          ui.notify(`mode set to ${value}`, "info");
          return;
        }
        ui.notify("Invalid key. Use: tool, thinking, or mode", "error");
        return;
      }

      // Interactive mode
      const config = deps.getConfig();
      const currentTool = config.tool ?? "brief";
      const currentThinking = config.thinking ?? "brief";
      const currentMode = config.messageMode ?? "steer";
      const choice = await ui.select("⚙️ Zalo Config", [
        `${KEY_LABELS.tool}: ${currentTool}`,
        `${KEY_LABELS.thinking}: ${currentThinking}`,
        `${KEY_LABELS.mode}: ${currentMode}`,
      ]);
      if (!choice) return;

      let selectedKey: string;
      let current: string;

      if (choice.startsWith(KEY_LABELS.tool)) { selectedKey = "tool"; current = currentTool; }
      else if (choice.startsWith(KEY_LABELS.thinking)) { selectedKey = "thinking"; current = currentThinking; }
      else if (choice.startsWith(KEY_LABELS.mode)) { selectedKey = "mode"; current = currentMode; }
      else return;

      const values = selectedKey === "mode" ? [...MODE_VALUES] : [...RENDER_LEVELS];
      const labels = values.map((v) => (v === current ? `● ${v}` : `  ${v}`));

      const valueChoice = await ui.select(KEY_LABELS[selectedKey], labels);
      if (!valueChoice) return;

      const idx = labels.indexOf(valueChoice);
      if (idx < 0 || idx >= values.length) return;
      const selectedValue = values[idx];

      const next = { ...config, [selectedKey === "mode" ? "messageMode" : selectedKey]: selectedValue };
      deps.setConfig(next);
      await deps.persistConfig(next);
      ui.notify(`${KEY_LABELS[selectedKey]} set to ${selectedValue}`, "info");
    },
  });
}
