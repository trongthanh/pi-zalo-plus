// pi-zalo-plus — control the pi coding agent from Zalo.
//
// Zalo sibling of pi-telegram-plus, built on the Zalo Bot Platform long-polling
// API (https://bot.zaloplatforms.com). Token lives in ~/.pi/agent/zalo-bot.json
// ({ "bot_token": "..." }); state lives in ~/.pi/agent/zalo.json.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { ensurePairingCode, isZaloEnabled, readZaloConfig, writeZaloConfig } from "./lib/config.ts";
import { createZaloController, type ZaloCommandHandler } from "./lib/controller.ts";
import { initLogger, log } from "./lib/logger.ts";
import { formatPairingInstructions } from "./lib/pairing.ts";
import { createZaloPollingRuntime } from "./lib/polling.ts";
import { registerZaloRenderer } from "./lib/renderer.ts";
import { getActiveSession, installAgentSessionCapture } from "./lib/session-capture.ts";
import { createZaloTransport } from "./lib/transport.ts";
import { createZaloUiRuntime } from "./lib/ui.ts";
import { getMe } from "./lib/zalo-api.ts";
import type { ZaloConfig, ZaloTurn, ZaloUpdate } from "./lib/types.ts";
import { getCurrentZaloTurn } from "./lib/turn-context.ts";

const indexLog = log.child("index");

type ZaloPlusRuntimeState = {
  dispose?: () => void;
};

const ZALO_PLUS_RUNTIME_STATE = Symbol.for("pi-zalo-plus.runtime-state");

function getZaloPlusRuntimeState(): ZaloPlusRuntimeState {
  const g = globalThis as typeof globalThis & Record<symbol, ZaloPlusRuntimeState | undefined>;
  g[ZALO_PLUS_RUNTIME_STATE] ??= {};
  return g[ZALO_PLUS_RUNTIME_STATE]!;
}

const ZALO_STATUS_KEY = "zalo";

export default function piZaloPlus(pi: ExtensionAPI): void {
  installAgentSessionCapture();
  initLogger({ level: "info" });
  const runtimeState = getZaloPlusRuntimeState();
  runtimeState.dispose?.();

  let config: ZaloConfig = {};
  let disposed = false;
  let lastStatusError: string | undefined;
  const activeTurns = new Map<string, ZaloTurn>();
  // Zalo updates may omit update_id (no server-side offset confirmation) — guard
  // against redelivery by remembering recently handled messages.
  const seenUpdates = new Map<string, number>();
  const isDuplicateUpdate = (update: ZaloUpdate): boolean => {
    if (update.update_id !== undefined) return false; // offset handles confirmation
    const messageId = update.message?.message_id;
    if (!messageId) return false;
    const key = `${update.event_name ?? ""}:${messageId}`;
    if (seenUpdates.has(key)) return true;
    seenUpdates.set(key, Date.now());
    if (seenUpdates.size > 500) {
      const cutoff = Date.now() - 10 * 60_000;
      for (const [k, at] of seenUpdates) {
        if (at < cutoff) seenUpdates.delete(k);
      }
    }
    return false;
  };

  const setConfig = (next: ZaloConfig) => {
    config = next;
    refreshStatus();
  };

  const persistConfig = async (next = config): Promise<void> => {
    config = next;
    await writeZaloConfig(next).catch(indexLog.swallow("warn", "persist zalo config failed"));
    refreshStatus();
  };

  const sessionCwd = (): string => {
    const session = getActiveSession();
    return session?.extensionRunner?.createCommandContext?.().cwd ?? process.cwd();
  };

  const downloadIncomingAttachment = async (media: { kind: string; url: string; fileName?: string }): Promise<string> => {
    const response = await fetch(media.url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    await mkdir(sessionCwd(), { recursive: true });
    const base = (media.fileName ?? `${media.kind}-${Date.now()}`)
      .replace(/[^a-zA-Z0-9._-]/g, "_")
      .slice(0, 100);
    const extMatch = media.url.match(/\.([a-zA-Z0-9]{1,8})(?:[?#]|$)/);
    const name = extMatch && !base.includes(".") ? `${base}.${extMatch[1]}` : base;
    const outputPath = resolve(sessionCwd(), `${Date.now()}-${name}`);
    await writeFile(outputPath, buffer);
    return outputPath;
  };

  const transport = createZaloTransport(() => config.zaloToken);
  const ui = createZaloUiRuntime({ getSession: getActiveSession, transport });

  const heartbeat = setInterval(() => {
    if (disposed || activeTurns.size === 0 || !config.zaloToken) return;
    const turn = [...activeTurns.values()][0];
    void transport.sendChatAction(turn.chatId, "typing");
  }, 4_500);

  // ── Commands ────────────────────────────────────────────────────────────────
  const zaloCommands = new Map<string, ZaloCommandHandler>();

  zaloCommands.set("status", async (_args, ctx) => {
    const enabled = !!config.zaloToken && isZaloEnabled(config);
    const lines = [
      "<b>π Zalo status</b>",
      `Bot: ${config.botName ?? "unknown"}`,
      `Enabled: ${enabled ? "yes" : "no"}`,
      `Access: ${config.openAccess === true ? "open (any user)" : config.allowedUserId !== undefined ? `paired (${config.allowedUserId})` : `unpaired (code: ${config.pairingCode ?? "n/a"})`}`,
      `Polling: ${polling.isActive() ? "active" : "stopped"}`,
      `Busy: ${activeTurns.size > 0 ? "yes" : "no"}`,
    ].join("\n");
    if (config.activeChatId) {
      void transport.sendText(config.activeChatId, lines).catch(() => ctx.ui.notify?.(lines, "info"));
    } else {
      ctx.ui.notify?.(lines, "info");
    }
  });

  zaloCommands.set("help", async (_args, ctx) => {
    const text = [
      "<b>π Zalo commands</b>",
      "/status — bot + session status",
      "/help — this help",
      "/stop — interrupt the running turn / cancel dialogs",
      "/cancel — cancel a pending dialog",
      "/zalo [status|on|off|pair|unpair|open|locked|reset] — manage the bot",
      "",
      "Any other text is sent to π as a prompt. Slash commands supported by pi and other extensions (e.g. /new, /model, /compact) also work.",
    ].join("\n");
    if (config.activeChatId) {
      void transport.sendText(config.activeChatId, text).catch(() => ctx.ui.notify?.(text, "info"));
    } else {
      ctx.ui.notify?.(text, "info");
    }
  });

  // Chat-native /zalo handler. Invoked from Zalo messages (tryHandleSlashCommand
  // checks this map before the session command registry) and replies via the
  // transport directly — the pi-wide command context wraps ctx.ui through
  // wrapUIPromptContext, which must not be a dependency for chat replies.
  zaloCommands.set("zalo", async (args, _ctx) => {
    const reply = (text: string) => {
      if (!config.activeChatId) return;
      void transport.sendText(config.activeChatId, text).catch(indexLog.swallow("warn", "zalo command reply failed"));
    };
    const sub = args.trim().toLowerCase();
    if (!sub || sub === "status") {
      const enabled = !!config.zaloToken && isZaloEnabled(config);
      reply([
        "<b>π Zalo status</b>",
        `Bot: ${config.botName ?? "unknown"}`,
        `Enabled: ${enabled ? "yes" : "no"}`,
        `Access: ${config.openAccess === true ? "open (any user)" : config.allowedUserId !== undefined ? `paired (${config.allowedUserId})` : `unpaired (code: ${config.pairingCode ?? "n/a"})`}`,
        `Polling: ${polling.isActive() ? "active" : "stopped"}`,
        `Busy: ${activeTurns.size > 0 ? "yes" : "no"}`,
        // Strip <> so the line stays valid under Zalo's html parse mode.
        lastStatusError ? `Last error: ${lastStatusError.replace(/[<>]/g, "")}` : "",
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
  });

  // ── Controller / polling ────────────────────────────────────────────────────
  const controller = createZaloController({
    getSession: getActiveSession,
    transport,
    ui,
    authorizeUser: async (userId, text) => {
      const { authorizeZaloUser } = await import("./lib/pairing.ts");
      const decision = authorizeZaloUser(config, userId, text);
      if (!decision.authorized) return false;
      if (decision.config !== config) {
        await persistConfig(decision.config);
      }
      return decision.paired ? "paired" : true;
    },
    setActiveChatId: async (chatId) => {
      if (config.activeChatId === chatId) return;
      await persistConfig({ ...config, activeChatId: chatId });
    },
    getBotName: () => config.botName,
    getMessageMode: () => config.messageMode ?? "steer",
    zaloCommands,
    getActiveTurn: (chatId) => activeTurns.get(chatId),
    beginZaloTurn: (chatId, sourceMessageId) => {
      if (activeTurns.has(chatId)) return undefined;
      const turn: ZaloTurn = { chatId, sourceMessageId };
      activeTurns.set(chatId, turn);
      refreshStatus();
      return turn;
    },
    endZaloTurn: (chatId, turn) => {
      if (activeTurns.get(chatId) === turn) activeTurns.delete(chatId);
      refreshStatus();
    },
    onTurnActivity: () => refreshStatus(),
    downloadIncomingAttachment,
  });

  const polling = createZaloPollingRuntime({
    getConfig: () => config,
    setConfig,
    persistUpdate: async (nextConfig) => {
      await persistConfig(nextConfig);
    },
    reloadConfig: async () => {
      const fresh = await readZaloConfig().catch(() => undefined);
      if (fresh) {
        config = fresh;
        refreshStatus();
      }
    },
    shouldPoll: () => !disposed && !!config.zaloToken && isZaloEnabled(config),
    shouldProcess: () => !disposed,
    handleUpdate: async (update) => {
      indexLog.info("update received", {
        eventName: update.event_name,
        updateId: update.update_id,
        messageId: update.message?.message_id,
        from: update.message?.from?.id,
        fromName: update.message?.from?.display_name,
        text: update.message?.text?.slice(0, 80),
      });
      refreshStatus();
      if (isDuplicateUpdate(update)) return;
      if (update.message) await controller.handleMessage(update.message);
      lastStatusError = undefined;
      refreshStatus();
    },
    onSuccess: () => {
      if (lastStatusError !== undefined) {
        lastStatusError = undefined;
        refreshStatus();
      }
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      lastStatusError = message;
      refreshStatus(message);
      if (message.startsWith("Zalo polling skipped:")) {
        getActiveSession()?.extensionRunner.getUIContext().notify(message, "warning");
        return;
      }
      indexLog.warn("Zalo polling error", { error: message });
      getActiveSession()?.extensionRunner.getUIContext().notify(`Zalo polling failed: ${message}`, "error");
    },
  });

  registerZaloRenderer(pi, {
    getConfig: () => config,
    transport,
    getActiveTurn: (chatId?: string) => (chatId !== undefined ? activeTurns.get(chatId) : getCurrentZaloTurn()),
    hasActiveTurns: () => activeTurns.size > 0,
  });

  // ── TUI command: /zalo ──────────────────────────────────────────────────────
  pi.registerCommand("zalo", {
    description: "Zalo bot: status, pair/unpair, on/off",
    handler: async (args, ctx) => {
      const sub = args.trim().toLowerCase();
      if (!sub || sub === "status") {
        const enabled = !!config.zaloToken && isZaloEnabled(config);
        const lines = [
          `Zalo bot: ${enabled ? "enabled" : "disabled"}`,
          `Bot: ${config.botName ?? "unknown"}`,
          `Access: ${config.openAccess === true ? "open (any user)" : config.allowedUserId !== undefined ? `paired (${config.allowedUserId})` : `unpaired (pairing code: ${config.pairingCode ?? "n/a"})`}`,
          `Polling: ${polling.isActive() ? "active" : "stopped"}`,
          lastStatusError ? `Last error: ${lastStatusError}` : "",
        ].filter(Boolean);
        ctx.ui.notify?.(lines.join("\n"), "info");
        return;
      }
      if (sub === "on" || sub === "off") {
        await persistConfig({ ...config, zaloEnabled: sub === "on" });
        ctx.ui.notify?.(`Zalo bot ${sub === "on" ? "enabled" : "disabled"}.`, "info");
        return;
      }
      if (sub === "pair") {
        const paired = ensurePairingCode({ ...config, openAccess: false, allowedUserId: undefined });
        await persistConfig(paired);
        ctx.ui.notify?.(formatPairingInstructions(paired), "warning");
        return;
      }
      if (sub === "unpair") {
        const paired = ensurePairingCode({ ...config, openAccess: false, allowedUserId: undefined });
        await persistConfig(paired);
        ctx.ui.notify?.("Zalo user unpaired. " + formatPairingInstructions(paired), "warning");
        return;
      }
      if (sub === "open") {
        await persistConfig({ ...config, openAccess: true, allowedUserId: undefined, pairingCode: undefined });
        ctx.ui.notify?.("Zalo bot set to open-access mode: any user can talk to it.", "info");
        return;
      }
      if (sub === "locked") {
        const paired = ensurePairingCode({ ...config, openAccess: false, allowedUserId: undefined });
        await persistConfig(paired);
        ctx.ui.notify?.("Zalo bot locked to pairing. " + formatPairingInstructions(paired), "warning");
        return;
      }
      if (sub === "reset") {
        await persistConfig({ ...config, lastUpdateId: undefined });
        ctx.ui.notify?.("Zalo update offset reset — the next poll replays undelivered updates.", "info");
        return;
      }
      ctx.ui.notify?.("Usage: /zalo [status|on|off|pair|unpair|open|locked|reset]", "info");
    },
  });

  // ── Status line ─────────────────────────────────────────────────────────────
  function buildStatusState(error?: string): string {
    const enabled = !!config.zaloToken && isZaloEnabled(config);
    const flags: string[] = [];
    flags.push(enabled ? "on" : "off");
    if (config.openAccess === true) flags.push("open");
    else flags.push(config.allowedUserId !== undefined ? "paired" : "unpaired");
    flags.push(polling.isActive() ? "polling" : "idle");
    if (activeTurns.size > 0) flags.push("busy");
    if (error) flags.push(`error: ${error.slice(0, 60)}`);
    return `Ⓩ ${flags.join(" · ")}`;
  }

  function refreshStatus(error = lastStatusError): void {
    const session = getActiveSession();
    const ctx = session?.extensionRunner?.createCommandContext?.();
    if (!config.zaloToken) return;
    try {
      ctx?.ui?.setStatus?.(ZALO_STATUS_KEY, buildStatusState(error));
    } catch {
      // TUI not available (headless modes) — ignore.
    }
  }

  function clearStatus(): void {
    const session = getActiveSession();
    const ctx = session?.extensionRunner?.createCommandContext?.();
    try {
      ctx?.ui?.setStatus?.(ZALO_STATUS_KEY, undefined);
    } catch {
      // ignore
    }
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────
  function disposeRuntime(): void {
    if (disposed) return;
    disposed = true;
    clearInterval(heartbeat);
    void polling.stop();
    activeTurns.clear();
    ui.dispose();
    clearStatus();
  }

  runtimeState.dispose = disposeRuntime;

  pi.on("session_start", async () => {
    try {
      setConfig(await readZaloConfig());
    } catch (error) {
      indexLog.warn("load zalo config failed", { error });
    }
    if (!config.zaloToken) {
      indexLog.info("no zalo-bot.json token found — Zalo control disabled");
      return;
    }
    const paired = ensurePairingCode(config);
    if (paired !== config) await persistConfig(paired);
    if (!config.botName) {
      try {
        const info = await getMe(config.zaloToken!);
        if (info?.display_name) await persistConfig({ ...config, botName: info.display_name });
      } catch (error) {
        indexLog.warn("getMe failed (non-critical)", { error });
      }
    }
    if (config.allowedUserId === undefined && config.openAccess !== true) {
      getActiveSession()?.extensionRunner.getUIContext().notify(formatPairingInstructions(config), "warning");
    }
    polling.start();
    lastStatusError = undefined;
    refreshStatus();
  });

  pi.on("session_shutdown", () => {
    disposeRuntime();
    if (runtimeState.dispose === disposeRuntime) runtimeState.dispose = undefined;
  });
}
