// Zalo controller: turns incoming Zalo messages into pi prompts / commands,
// with pairing, per-chat turn ownership, steer/queue prompt routing, and a
// routed UI context so pi dialogs raised by Zalo-triggered turns render back
// into the chat. Port of pi-telegram-plus/lib/controller.ts adapted to Zalo
// (string IDs, no threads/callback queries, text-based dialogs).

import { mkdir, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import type { ExtensionCommandContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { parseLeadingCommand, normalizeLeadingCommand } from "./command-parser.ts";
import type { CapturedAgentSession, ZaloIncomingMessage, ZaloMessageMode, ZaloTransport, ZaloTurn } from "./types.ts";
import type { ZaloUiRuntime } from "./ui.ts";
import { log } from "./logger.ts";
import { commandErrorMessage, getRunnerMode, setRunnerUiContext, ZALO_EXTENSION_MODE } from "./pi-compat.ts";
import { getCurrentZaloTurn, runWithZaloTurn } from "./turn-context.ts";

const ctrlLog = log.child("controller");

export type ZaloCommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;

const QUOTED_TEXT_LIMIT = 1800;

function truncateQuotedText(text: string, max = QUOTED_TEXT_LIMIT): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function sanitizeIncomingFileName(value: string): string {
  const trimmed = value.trim().replace(/\.[^./\\]+$/, "");
  const sanitized = trimmed.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/_+/g, "_");
  const compact = sanitized.replace(/^\.+/, "").replace(/\.+$/, "");
  return compact.slice(0, 120) || "attachment";
}

function inferIncomingExtension(fileName: string | undefined, url: string): string {
  const fromUrl = url.match(/\.([a-zA-Z0-9]{1,8})(?:[?#]|$)/);
  if (fromUrl) return `.${fromUrl[1].toLowerCase()}`;
  if (fileName) {
    const extension = extname(fileName).toLowerCase();
    if (extension) return extension;
  }
  return ".bin";
}

type IncomingMedia = {
  kind: string;
  url: string;
  fileName?: string;
};

function extractMediaEntries(message: ZaloIncomingMessage): IncomingMedia[] {
  const entries: IncomingMedia[] = [];
  if (typeof message.photo_url === "string" && message.photo_url.startsWith("http")) {
    entries.push({ kind: "photo", url: message.photo_url });
  }
  if (Array.isArray(message.attachments)) {
    for (const attachment of message.attachments) {
      if (!attachment || typeof attachment !== "object") continue;
      const url = [attachment.photo_url, attachment.url, attachment.file_url, attachment.image_url]
        .find((v): v is string => typeof v === "string" && v.startsWith("http"));
      if (!url) continue;
      const kind = typeof attachment.type === "string" ? attachment.type : "file";
      const name = typeof attachment.name === "string" ? attachment.name : undefined;
      entries.push({ kind, url, fileName: name });
    }
  }
  return entries.slice(0, 5);
}

function formatZaloSender(from: ZaloIncomingMessage["from"]): string | undefined {
  if (!from) return undefined;
  const parts: string[] = [];
  if (from.display_name) parts.push(from.display_name);
  if (from.id) parts.push(`id:${from.id}`);
  if (from.is_bot) parts.push("bot");
  return parts.length > 0 ? parts.join(" ") : undefined;
}

// ── Routed UI stack (port of the telegram controller UI swap) ────────────────

type ZaloUiStackEntry = {
  turn: ZaloTurn;
  ui: ExtensionUIContext;
  routedUi: ExtensionUIContext;
};

type ZaloUiStackState = {
  baseUi: unknown;
  baseMode: string;
  entries: ZaloUiStackEntry[];
};

const zaloUiStacks = new WeakMap<object, ZaloUiStackState>();

function isSameZaloTurnTarget(currentTurn: ZaloTurn | undefined, turn: ZaloTurn): boolean {
  return currentTurn?.chatId === turn.chatId && currentTurn?.sourceMessageId === turn.sourceMessageId;
}

function createRoutedZaloUi(baseUi: unknown, zaloUi: ExtensionUIContext, turn: ZaloTurn): ExtensionUIContext {
  // pi's ExtensionRunner.setUIContext() wraps the UI via `{ ...ui }` spread
  // (wrapUIPromptContext). A bare `get`-trap proxy has no own enumerable keys,
  // so the spread flattened it to just the 5 re-created dialog methods and
  // dropped notify/setStatus/… — making /zalo and other commands invoked from
  // chat silently no-op. Expose the routed methods as own enumerable
  // properties so the spread captures them.
  const routedKeys = [...new Set([...Reflect.ownKeys(zaloUi), ...Reflect.ownKeys((baseUi ?? {}) as object)])].filter(
    (key): key is string => typeof key === "string",
  );
  return new Proxy({}, {
    get(_target, prop, receiver) {
      if (prop === "__piZaloPlusRoutedUi") return true;
      const currentTurn = getCurrentZaloTurn();
      const target = isSameZaloTurnTarget(currentTurn, turn) ? zaloUi : baseUi;
      const value = Reflect.get((target ?? {}) as object, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
    set(_target, prop, value, receiver) {
      const currentTurn = getCurrentZaloTurn();
      const target = isSameZaloTurnTarget(currentTurn, turn) ? zaloUi : baseUi;
      return Reflect.set((target ?? {}) as object, prop, value, receiver);
    },
    has(_target, prop) {
      const currentTurn = getCurrentZaloTurn();
      const target = isSameZaloTurnTarget(currentTurn, turn) ? zaloUi : baseUi;
      return prop in ((target ?? {}) as object);
    },
    ownKeys(_target) {
      return routedKeys;
    },
    getOwnPropertyDescriptor(_target, prop) {
      if (!routedKeys.includes(prop as string)) return undefined;
      // configurable: true is required — the target never actually holds these keys.
      return { enumerable: true, configurable: true, writable: true, value: undefined };
    },
  }) as ExtensionUIContext;
}

function pushZaloUiContext(
  runner: CapturedAgentSession["extensionRunner"],
  ui: ExtensionUIContext,
  turn: ZaloTurn,
): () => void {
  let state = zaloUiStacks.get(runner as object);
  if (!state) {
    state = { baseUi: runner.getUIContext(), baseMode: getRunnerMode(runner as never), entries: [] };
    zaloUiStacks.set(runner as object, state);
  }
  const previousUi = state.entries.at(-1)?.routedUi ?? state.baseUi;
  const entry: ZaloUiStackEntry = {
    turn,
    ui,
    routedUi: createRoutedZaloUi(previousUi, ui, turn),
  };
  state.entries.push(entry);
  setRunnerUiContext(runner as never, entry.routedUi, ZALO_EXTENSION_MODE);

  return () => {
    const current = zaloUiStacks.get(runner as object);
    if (!current) return;
    const idx = current.entries.indexOf(entry);
    if (idx === -1) return;
    const wasTop = idx === current.entries.length - 1;
    current.entries.splice(idx, 1);
    if (wasTop) {
      const next = current.entries.at(-1);
      if (next) setRunnerUiContext(runner as never, next.routedUi, ZALO_EXTENSION_MODE);
      else setRunnerUiContext(runner as never, current.baseUi, current.baseMode);
    }
    if (current.entries.length === 0) zaloUiStacks.delete(runner as object);
  };
}

async function runWithZaloUi<T>(deps: {
  session: CapturedAgentSession;
  ui: ExtensionUIContext;
  turn: ZaloTurn;
  run: () => Promise<T>;
}): Promise<T> {
  const restore = pushZaloUiContext(deps.session.extensionRunner, deps.ui, deps.turn);
  try {
    return await deps.run();
  } finally {
    restore();
  }
}

// ── Controller ────────────────────────────────────────────────────────────────

export function createZaloController(deps: {
  getSession: () => CapturedAgentSession | undefined;
  transport: ZaloTransport;
  ui: ZaloUiRuntime;
  authorizeUser(userId: string | undefined, text?: string): Promise<boolean | "paired">;
  setActiveChatId(chatId: string): Promise<void>;
  getBotName(): string | undefined;
  getMessageMode: () => ZaloMessageMode;
  zaloCommands: Map<string, ZaloCommandHandler>;
  getActiveTurn(chatId: string): ZaloTurn | undefined;
  beginZaloTurn(chatId: string, sourceMessageId?: string): ZaloTurn | undefined;
  endZaloTurn(chatId: string, turn: ZaloTurn): void;
  onTurnActivity?: () => void;
  downloadIncomingAttachment?: (media: IncomingMedia) => Promise<string>;
}): {
  handleMessage(message: ZaloIncomingMessage): Promise<void>;
} {
  // Per-chat prompt queues (queue mode chains per chat).
  const promptTails = new Map<string, Promise<void>>();
  const interruptGenerationByTarget = new Map<string, number>();

  const getOrCreateTail = (key: string): Promise<void> => promptTails.get(key) ?? Promise.resolve();
  const setTail = (key: string, tail: Promise<void>) => promptTails.set(key, tail);
  const getInterruptGeneration = (key: string): number => interruptGenerationByTarget.get(key) ?? 0;
  const bumpInterruptGeneration = (key: string): void => {
    interruptGenerationByTarget.set(key, (interruptGenerationByTarget.get(key) ?? 0) + 1);
  };

  const fastInterrupt = async (chatId: string, sourceMessageId?: string) => {
    const session = deps.getSession();
    if (!session) {
      await deps.transport.sendText(chatId, "π session is not ready yet.", { replyToMessageId: sourceMessageId });
      return;
    }
    bumpInterruptGeneration(chatId);
    await deps.transport.sendText(chatId, "⏹️ Interrupt requested.", { replyToMessageId: sourceMessageId });
    const abortResult = (session as unknown as { abort?: () => Promise<void> }).abort?.();
    void abortResult?.catch?.(() => undefined);
  };

  const reportPromptFailure = async (label: string, chatId: string, sourceMessageId: string | undefined, err: unknown) => {
    ctrlLog.error(`${label} prompt task failed`, { chatId, sourceMessageId, err });
    await deps.transport.sendText(chatId, "⚠️ Your message could not be delivered to π. Please retry.", { replyToMessageId: sourceMessageId })
      .catch(ctrlLog.swallow("warn", "sendText prompt-failure notice failed", { chatId }));
  };

  const runPrompt = async (text: string, chatId: string, sourceMessageId?: string) => {
    const session = deps.getSession();
    if (!session) {
      await deps.transport.sendText(chatId, "π session is not ready yet.", { replyToMessageId: sourceMessageId });
      return;
    }

    const mode = deps.getMessageMode();
    const isSteer = mode === "steer" && session.isStreaming;

    if (isSteer) {
      const existingTurn = deps.getActiveTurn(chatId);
      if (!existingTurn) {
        const turn = deps.beginZaloTurn(chatId, sourceMessageId);
        if (!turn) {
          await deps.transport.sendText(chatId, "⏳ π is busy. Try again shortly.", { replyToMessageId: sourceMessageId });
          return;
        }
        const zaloUi = deps.ui.create(chatId, sourceMessageId);
        try {
          await runWithZaloTurn(turn, () => runWithZaloUi({
            session,
            ui: zaloUi,
            turn,
            run: () => session.prompt(text, { source: "interactive", streamingBehavior: "steer" }),
          }));
        } finally {
          deps.endZaloTurn(chatId, turn);
          deps.onTurnActivity?.();
        }
        return;
      }
      const zaloUi = deps.ui.create(chatId, sourceMessageId);
      await runWithZaloTurn(existingTurn, () => runWithZaloUi({
        session,
        ui: zaloUi,
        turn: existingTurn,
        run: () => session.prompt(text, { source: "interactive", streamingBehavior: "steer" as const }),
      }));
      return;
    }

    const turn = deps.beginZaloTurn(chatId, sourceMessageId);
    if (!turn) {
      await deps.transport.sendText(chatId, "⏳ π is busy. Try again shortly.", { replyToMessageId: sourceMessageId });
      return;
    }

    const zaloUi = deps.ui.create(chatId, sourceMessageId);
    try {
      await runWithZaloTurn(turn, () => runWithZaloUi({
        session,
        ui: zaloUi,
        turn,
        run: async () => {
          await session.prompt(text, {
            source: "interactive",
            streamingBehavior: mode === "queue" ? "followUp" : "steer",
          });
        },
      }));
    } finally {
      deps.endZaloTurn(chatId, turn);
      deps.onTurnActivity?.();
    }
  };

  const submitText = async (text: string, chatId: string, sourceMessageId?: string) => {
    const mode = deps.getMessageMode();
    if (mode === "steer") {
      const task = runPrompt(text, chatId, sourceMessageId);
      void task.catch((err) => reportPromptFailure("steer-mode", chatId, sourceMessageId, err));
      return;
    }
    const generation = getInterruptGeneration(chatId);
    const task = getOrCreateTail(chatId)
      .then(() => {
        if (generation !== getInterruptGeneration(chatId)) return;
        return runPrompt(text, chatId, sourceMessageId);
      })
      .catch((err) => reportPromptFailure("queue-mode", chatId, sourceMessageId, err));
    setTail(chatId, task);
  };

  const runCommandHandler = (
    handler: ZaloCommandHandler,
    args: string,
    session: CapturedAgentSession,
    chatId: string,
    sourceMessageId?: string,
  ) => {
    // Commands run immediately without acquiring a turn (they never block the
    // polling loop). Some commands enqueue agent turns — hold the UI swap until
    // the chain drains if the agent was idle when the command arrived.
    const zaloUi = deps.ui.create(chatId, sourceMessageId);
    const commandTurn = deps.getActiveTurn(chatId) ?? { chatId, sourceMessageId };
    void runWithZaloTurn(commandTurn, () => runWithZaloUi({
      session,
      ui: zaloUi,
      turn: commandTurn,
      run: async () => {
        // Create the command context AFTER the routed Zalo UI is swapped in, so
        // ctx.ui.notify() routes to the chat. Created earlier, it captures the
        // base runner UI and /zalo commands fail with "ctx.ui.notify is not a
        // function" when invoked from Zalo.
        const ctx = session.extensionRunner.createCommandContext();
        const idleFn = typeof (ctx as unknown as { isIdle?: () => boolean }).isIdle === "function"
          ? (ctx as unknown as { isIdle: () => boolean }).isIdle
          : undefined;
        const waitFn = typeof (ctx as unknown as { waitForIdle?: () => Promise<void> }).waitForIdle === "function"
          ? (ctx as unknown as { waitForIdle: () => Promise<void> }).waitForIdle
          : undefined;
        const wasIdle = idleFn ? idleFn.call(ctx) : false;
        await handler(args, ctx);
        if (!wasIdle || !idleFn || !waitFn) return;
        try {
          for (;;) {
            await waitFn.call(ctx);
            await new Promise((r) => setTimeout(r, 120));
            if (idleFn.call(ctx)) break;
          }
        } catch (err) {
          ctrlLog.debug("waitForIdle during enqueued turn interrupted", { err });
        }
      },
    })).catch(async (err) => {
      ctrlLog.warn("zalo command handler failed", { chatId, err });
      await deps.transport.sendText(chatId, `⚠️ Command failed:\n${commandErrorMessage(err)}`, { replyToMessageId: sourceMessageId })
        .catch(ctrlLog.swallow("warn", "sendText command-failure notice failed", { chatId }));
    });
  };

  const tryHandleSlashCommand = async (text: string, chatId: string, sourceMessageId?: string): Promise<boolean> => {
    const parsed = parseLeadingCommand(text);
    if (!parsed) return false;
    const session = deps.getSession();
    if (!session) {
      await deps.transport.sendText(chatId, "π session is not ready yet.", { replyToMessageId: sourceMessageId });
      return true;
    }
    const name = parsed.name.toLowerCase();
    const handler =
      deps.zaloCommands.get(name)
      ?? deps.zaloCommands.get(name.replace(/_/g, "-"))
      ?? deps.zaloCommands.get(name.replace(/-/g, "_"));
    if (handler) {
      runCommandHandler(handler, parsed.args, session, chatId, sourceMessageId);
      return true;
    }
    const externalCommand =
      session.extensionRunner.getCommand(name)
      ?? session.extensionRunner.getCommand(name.replace(/_/g, "-"))
      ?? session.extensionRunner.getCommand(name.replace(/-/g, "_"));
    if (externalCommand) {
      runCommandHandler(externalCommand.handler, parsed.args, session, chatId, sourceMessageId);
      return true;
    }
    return false;
  };

  return {
    async handleMessage(message) {
      const chatId = message.chat?.id;
      if (!chatId) return;
      const sourceMessageId = message.message_id;
      const rawText = message.text ?? "";

      const authorization = await deps.authorizeUser(message.from?.id, rawText);
      if (!authorization) return;
      await deps.setActiveChatId(chatId);
      if (authorization === "paired") {
        await deps.transport.sendText(chatId, "✅ Zalo user paired. You can now talk to π.", { replyToMessageId: sourceMessageId });
        return;
      }

      const text = normalizeLeadingCommand(rawText, undefined);
      const trimmed = text.trim();

      if (trimmed === "/stop" || trimmed === "/stop@") {
        const cancelResult = deps.ui.resolveInput(chatId, undefined, sourceMessageId);
        const cancelAnyResult = !cancelResult.handled ? deps.ui.resolveInput(chatId, undefined) : cancelResult;
        if (cancelAnyResult.handled) {
          await deps.transport.sendText(chatId, "Cancelled.", { replyToMessageId: sourceMessageId });
          return;
        }
        await fastInterrupt(chatId, sourceMessageId);
        return;
      }

      if (trimmed === "/cancel") {
        const first = deps.ui.resolveInput(chatId, undefined, sourceMessageId);
        const cancelResult = first.handled ? first : deps.ui.resolveInput(chatId, undefined);
        if (cancelResult.handled) {
          await deps.transport.sendText(chatId, "Cancelled.", { replyToMessageId: sourceMessageId });
          return;
        }
        return; // no pending dialog — ignore silently
      }

      // Dialog flow consumption: while a dialog is pending, the user's text
      // resolves it instead of starting a prompt. Sensitive (secret) inputs are
      // deleted from the chat after receipt.
      if (rawText.trim()) {
        const wasSensitive = deps.ui.isSensitiveInput(chatId, sourceMessageId);
        const inputResult = deps.ui.resolveInput(chatId, rawText, sourceMessageId);
        if (inputResult.handled) {
          if (wasSensitive && sourceMessageId) await deps.transport.deleteMessage(chatId, sourceMessageId);
          return;
        }
      }

      const mediaEntries = extractMediaEntries(message);
      const downloadedLines: string[] = [];
      const failedLines: string[] = [];
      if (mediaEntries.length > 0) {
        const results = await Promise.allSettled(
          mediaEntries.map((media) => deps.downloadIncomingAttachment!(media)),
        );
        for (let i = 0; i < mediaEntries.length; i++) {
          const media = mediaEntries[i];
          const result = results[i];
          if (result.status === "fulfilled" && result.value) {
            downloadedLines.push(`- ${media.kind}: ${media.fileName ?? media.url} => ${result.value}`);
          } else {
            const reason = result.status === "rejected"
              ? result.reason instanceof Error ? result.reason.message : String(result.reason)
              : "download failed";
            failedLines.push(`- ${media.kind}: ${media.fileName ?? media.url} -> failed to save (${reason})`);
          }
        }
        const lines = [
          downloadedLines.length > 0 ? "✅ Saved attachments (local paths):\n" + downloadedLines.join("\n") : "",
          failedLines.length > 0 ? "⚠️ Attachments not saved:\n" + failedLines.join("\n") : "",
        ].filter(Boolean).join("\n\n");
        if (lines) {
          await deps.transport.sendText(chatId, lines, { replyToMessageId: sourceMessageId })
            .catch(ctrlLog.swallow("warn", "sendText media receipt failed", { chatId }));
        }
      }

      const hasPromptInput = !!trimmed || mediaEntries.length > 0;
      if (hasPromptInput) {
        const handled = trimmed ? await tryHandleSlashCommand(text, chatId, sourceMessageId) : false;
        if (!handled) {
          const mediaBlock = mediaEntries.length > 0
            ? `\n\n[zalo attachments]\n${[...downloadedLines, ...failedLines].join("\n")}`
            : "";
          const promptText = `${trimmed}${mediaBlock}`.trim();
          await submitText(promptText, chatId, sourceMessageId);
        }
      }
    },
  };
}

export { formatZaloSender, truncateQuotedText };
