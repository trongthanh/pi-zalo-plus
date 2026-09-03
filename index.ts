// pi-zalo-plus — control the pi coding agent from Zalo.
//
// Built on the Zalo Bot Platform long-polling API (https://bot.zaloplatforms.com).
// All config lives in ~/.pi/agent/zalo.json — { "bot_token": "...", ...state }.
//
// Architecture (adapted from pi-telegram-plus):
//   index.ts            — extension entry point, wires everything together
//   lib/                — core modules (api, polling, controller, ui, renderer)
//   lib/commands/       — modular command handlers
//   lib/__tests__/      — test suite

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ensurePairingCode, isZaloEnabled, migrateLegacyTokenFile, readZaloConfig, writeZaloConfig } from "./lib/config.ts";
import { createZaloController } from "./lib/controller.ts";
import type { ZaloCommandHandler } from "./lib/types.ts";
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

// ── Extracted modules ───────────────────────────────────────────────────────
import { createHeartbeat } from "./lib/heartbeat.ts";
import { buildStatusState, formatZaloStatusLine, ZALO_STATUS_KEY } from "./lib/status.ts";
import { downloadIncomingAttachment, resolveDownloadDir, type IncomingMedia } from "./lib/attachments.ts";

// ── Command modules ─────────────────────────────────────────────────────────
import { buildChatZaloCommandHandler, registerZaloCommands } from "./lib/commands/zalo.ts";
import { buildChatStatusHandler, registerStatusCommand } from "./lib/commands/status.ts";
import { buildChatHelpHandler, registerHelpCommand } from "./lib/commands/help.ts";
import { registerZaloConfigCommands } from "./lib/commands/zalo-config.ts";

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

/** Minimal TUI-compatible command registry backed by pi.registerCommand. */
function createTuiCommandRegistry(pi: ExtensionAPI): {
  registerCommand: (name: string, options: { description?: string; handler: (args: string, ctx: any) => Promise<void> }) => void;
} {
  return {
    registerCommand(name, options) {
      pi.registerCommand(name, {
        description: options.description ?? "",
        handler: options.handler,
      });
    },
  };
}

export default function piZaloPlus(pi: ExtensionAPI): void {
  installAgentSessionCapture();
  initLogger({ level: "info" });
  const runtimeState = getZaloPlusRuntimeState();
  runtimeState.dispose?.();

  let config: ZaloConfig = {};
  let disposed = false;
  let lastStatusError: string | undefined;
  const activeTurns = new Map<string, ZaloTurn>();
  // Zalo updates may omit update_id — guard against redelivery by remembering
  // recently handled messages.
  const seenUpdates = new Map<string, number>();
  const isDuplicateUpdate = (update: ZaloUpdate): boolean => {
    if (update.update_id !== undefined) return false;
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

  const transport = createZaloTransport(() => config.zaloToken);
  const ui = createZaloUiRuntime({ getSession: getActiveSession, transport });

  // ── Heartbeat (typing indicator) ──────────────────────────────────────────
  const heartbeat = createHeartbeat({
    transport,
    getActiveTurns: () => [...activeTurns.values()],
  });

  // ── TUI command registry ──────────────────────────────────────────────────
  // Only register Zalo-specific commands (zalo, status, help, zalo-config).
  // Built-in pi commands (new, fork, clone, tree, resume, cd, cwd, name, session,
  // compact, reload, stop, quit, settings, model, thinking, login, logout, etc.)
  // are already registered by pi itself and must NOT be re-registered here.
  const tuiRegistry = createTuiCommandRegistry(pi);

  registerZaloCommands(tuiRegistry, { getSession: getActiveSession }, {
    getConfig: () => config,
    setConfig,
    persistConfig,
    getSession: getActiveSession,
  });
  registerStatusCommand(tuiRegistry, () => config, {
    getTransport: () => transport,
    getActiveChatId: () => config.activeChatId,
    getActiveTurn: () => getCurrentZaloTurn(),
  });
  registerHelpCommand(tuiRegistry);
  registerZaloConfigCommands(tuiRegistry, {
    getConfig: () => config,
    setConfig,
    persistConfig,
    getSession: getActiveSession,
  });

  // ── Chat command handlers (used from Zalo messages) ───────────────────────
  const sendChatReply = (text: string) => {
    if (!config.activeChatId) return;
    void transport.sendText(config.activeChatId, text)
      .catch(indexLog.swallow("warn", "chat command reply failed"));
  };

  const zaloCommands = new Map<string, ZaloCommandHandler>();
  zaloCommands.set("status", async () => {
    buildChatStatusHandler(
      () => config,
      () => config.activeChatId,
      sendChatReply,
    )();
  });
  zaloCommands.set("help", async () => {
    buildChatHelpHandler(sendChatReply)();
  });
  zaloCommands.set("zalo", buildChatZaloCommandHandler(
    () => config,
    persistConfig,
    () => config.activeChatId,
    sendChatReply,
  ));

  // ── Controller / polling ──────────────────────────────────────────────────
  const controller = createZaloController({
    getSession: getActiveSession,
    transport,
    ui,
    authorizeUser: async (userId, text) => {
      const { authorizeZaloUser } = await import("./lib/pairing.ts");
      const decision = authorizeZaloUser(config, userId, text);
      if (!decision.authorized) return false;
      if (decision.config !== config) await persistConfig(decision.config);
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
      heartbeat.start();
      refreshStatus();
      return turn;
    },
    endZaloTurn: (chatId, turn) => {
      if (activeTurns.get(chatId) === turn) {
        activeTurns.delete(chatId);
        if (activeTurns.size === 0) heartbeat.stop();
      }
      refreshStatus();
    },
    onTurnActivity: () => refreshStatus(),
    downloadIncomingAttachment: async (media: IncomingMedia) => {
      const downloadDir = resolveDownloadDir(config, sessionCwd);
      return downloadIncomingAttachment(media, downloadDir);
    },
  });

  const polling = createZaloPollingRuntime({
    getConfig: () => config,
    setConfig,
    persistUpdate: async (nextConfig) => { await persistConfig(nextConfig); },
    reloadConfig: async () => {
      const fresh = await readZaloConfig().catch(() => undefined);
      if (fresh) { config = fresh; refreshStatus(); }
    },
    shouldPoll: () => !disposed && !!config.zaloToken && isZaloEnabled(config),
    shouldProcess: () => !disposed,
    handleUpdate: async (update) => {
      const hasText = !!update.message?.text;
      indexLog.info("update received", {
        eventName: update.event_name,
        updateId: update.update_id,
        messageId: update.message?.message_id,
        from: update.message?.from?.id,
        fromName: update.message?.from?.display_name,
        text: update.message?.text?.slice(0, 80),
        raw: hasText ? undefined : JSON.stringify(update.message ?? update).slice(0, 500),
      });
      refreshStatus();
      if (isDuplicateUpdate(update)) return;
      if (update.message) await controller.handleMessage(update.message, update.event_name);
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

  // ── Status line ───────────────────────────────────────────────────────────
  function refreshStatus(error = lastStatusError): void {
    const session = getActiveSession();
    const ctx = session?.extensionRunner?.createCommandContext?.();
    if (!config.zaloToken) return;
    try {
      const state = buildStatusState(config, polling.isActive(), activeTurns.size > 0, error);
      ctx?.ui?.setStatus?.(ZALO_STATUS_KEY, formatZaloStatusLine(state));
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

  // ── Lifecycle ──────────────────────────────────────────────────────────────
  function disposeRuntime(): void {
    if (disposed) return;
    disposed = true;
    heartbeat.dispose();
    void polling.stop();
    activeTurns.clear();
    ui.dispose();
    clearStatus();
  }

  runtimeState.dispose = disposeRuntime;

  pi.on("session_start", async () => {
    try {
      setConfig(await readZaloConfig());
      const migrated = await migrateLegacyTokenFile(config);
      if (migrated !== config) {
        setConfig(migrated);
        indexLog.info("migrated bot_token from legacy zalo-bot.json into zalo.json (legacy file removed)");
      }
    } catch (error) {
      indexLog.warn("load zalo config failed", { error });
    }
    if (!config.zaloToken) {
      indexLog.info("no bot_token in zalo.json — Zalo control disabled");
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
