// ZaloUiRuntime: routes pi's interactive UI (confirm/select/input/editor) into
// the Zalo chat. Zalo bots have no inline keyboards/callback queries, so all
// dialogs are text-based: the dialog is posted as a message and the user's
// next message resolves it (number for select, yes/no for confirm, text for
// input, "cancel" aborts). While a dialog is pending, messages from the user
// are consumed by the dialog instead of starting a prompt.

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { CapturedAgentSession, ZaloTransport } from "./types.ts";
import { log } from "./logger.ts";

const uiLog = log.child("ui");

const INPUT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_SELECT_OPTIONS = 30;

type Pending = {
  flowId: string;
  resolve: (value: string | boolean | undefined) => void;
  timer: NodeJS.Timeout;
  sensitive: boolean;
  promptMessageId?: string;
};

export type ZaloUiRuntime = {
  create(chatId: string, sourceMessageId?: string): ExtensionUIContext;
  resolveInput(chatId: string, value: string | boolean | undefined, replyToMessageId?: string): { handled: boolean; promptMessageId?: string };
  isSensitiveInput(chatId: string, replyToMessageId?: string): boolean;
  hasPendingInput(chatId: string): boolean;
  dispose(): void;
};

export function createZaloUiRuntime(deps: {
  getSession: () => CapturedAgentSession | undefined;
  transport: ZaloTransport;
}): ZaloUiRuntime {
  const pendingByTarget = new Map<string, Map<string, Pending>>();
  const latestFlowByTarget = new Map<string, string>();
  let nextFlowId = 1;

  const flows = (chatId: string): Map<string, Pending> => {
    let map = pendingByTarget.get(chatId);
    if (!map) {
      map = new Map();
      pendingByTarget.set(chatId, map);
    }
    return map;
  };

  const clearFlow = (chatId: string, flowId: string) => {
    const map = pendingByTarget.get(chatId);
    const pending = map?.get(flowId);
    if (pending) clearTimeout(pending.timer);
    map?.delete(flowId);
    if (latestFlowByTarget.get(chatId) === flowId) latestFlowByTarget.delete(chatId);
    if (map && map.size === 0) pendingByTarget.delete(chatId);
  };

  const waitInput = (
    chatId: string,
    flowId: string,
    sensitive = false,
    promptMessageId?: string,
  ): Promise<string | boolean | undefined> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (flows(chatId).has(flowId)) {
          clearFlow(chatId, flowId);
          resolve(undefined);
        }
      }, INPUT_TIMEOUT_MS);
      flows(chatId).set(flowId, { flowId, resolve, timer, sensitive, promptMessageId });
      latestFlowByTarget.set(chatId, flowId);
    });

  const beginFlow = () => String(nextFlowId++);

  const sendPrompt = async (
    chatId: string,
    sourceMessageId: string | undefined,
    text: string,
    flowId: string,
  ): Promise<string | undefined> => {
    try {
      const [sent] = await deps.transport.sendText(chatId, text, { replyToMessageId: sourceMessageId });
      return sent?.message_id;
    } catch (error) {
      uiLog.warn("dialog prompt send failed", { chatId, flowId, error });
      return undefined;
    }
  };

  const isAffirmative = (value: string) => /^(y|yes|ok|okay|true|có|co|đúng|dung)$/i.test(value.trim());

  return {
    create(chatId, sourceMessageId) {
      // base = the real TUI context captured BEFORE the routed UI is swapped in.
      const base = deps.getSession()?.extensionRunner.getUIContext?.() as ExtensionUIContext | undefined;

      const notifyFn = (message: string, level: "info" | "warning" | "error" = "info") => {
        const icon = level === "error" ? "❌" : level === "warning" ? "⚠️" : "ℹ️";
        void deps.transport.sendText(chatId, `${icon} ${message}`).catch(uiLog.swallow("warn", "notify send failed", { chatId }));
      };

      return {
        // ---- Interactive modals: Zalo text flows (never forward to the TUI —
        // a Zalo-triggered turn must not pop a modal in the local terminal that
        // nobody there can dismiss). ----
        notify: notifyFn,

        confirm: async (title, message) => {
          const flowId = beginFlow();
          const promptMessageId = await sendPrompt(
            chatId,
            sourceMessageId,
            `<b>${title}</b>\n${message}\n\nReply <b>yes</b> or <b>no</b> (or <b>cancel</b>).`,
            flowId,
          );
          for (;;) {
            const value = await waitInput(chatId, flowId, false, promptMessageId);
            if (typeof value !== "string") return false; // cancelled or timeout
            const t = value.trim().toLowerCase();
            if (t === "cancel") return false;
            if (isAffirmative(t)) return true;
            if (t === "no" || t === "n") return false;
            await deps.transport.sendText(chatId, `Please reply <b>yes</b>, <b>no</b>, or <b>cancel</b>.`);
          }
        },

        input: async (title, placeholder) => {
          const flowId = beginFlow();
          const promptMessageId = await sendPrompt(
            chatId,
            sourceMessageId,
            `<b>${title}</b>${placeholder ? `\n${placeholder}` : ""}\n\nReply with a value (or <b>cancel</b>).`,
            flowId,
          );
          const value = await waitInput(chatId, flowId, false, promptMessageId);
          if (typeof value !== "string") return undefined;
          const t = value.trim();
          return t.toLowerCase() === "cancel" ? undefined : value;
        },

        inputSecret: async (title: string, placeholder?: string) => {
          const flowId = beginFlow();
          const promptMessageId = await sendPrompt(
            chatId,
            sourceMessageId,
            `<b>${title}</b>${placeholder ? `\n${placeholder}` : ""}\n\nReply with the secret (or <b>cancel</b>). It will be deleted from the chat after receipt.`,
            flowId,
          );
          const value = await waitInput(chatId, flowId, true, promptMessageId);
          if (typeof value !== "string") return undefined;
          if (value.trim().toLowerCase() === "cancel") return undefined;
          if (promptMessageId) {
            // Best effort: the resolved reply message is deleted by the
            // controller when isSensitiveInput() was true for it.
          }
          return value;
        },

        editor: async (title, prefill) => {
          const flowId = beginFlow();
          const promptMessageId = await sendPrompt(
            chatId,
            sourceMessageId,
            `<b>${title}</b>${prefill ? `\n\n${prefill}` : ""}\n\nReply with the full replacement text (or <b>cancel</b>).`,
            flowId,
          );
          const value = await waitInput(chatId, flowId, false, promptMessageId);
          if (typeof value !== "string") return undefined;
          return value.trim().toLowerCase() === "cancel" ? undefined : value;
        },

        select: async (title, options) => {
          if (options.length === 0) return undefined;
          const capped = options.slice(0, MAX_SELECT_OPTIONS);
          const flowId = beginFlow();
          const list = capped.map((label, i) => {
            const short = label.length > 80 ? `${label.slice(0, 79)}…` : label;
            return `${i + 1}. ${short}`;
          }).join("\n");
          const promptMessageId = await sendPrompt(
            chatId,
            sourceMessageId,
            `<b>${title}</b>\n${list}${options.length > capped.length ? `\n(${options.length - capped.length} more not shown)` : ""}\n\nReply with a number 1-${capped.length} (or <b>cancel</b>).`,
            flowId,
          );
          for (;;) {
            const value = await waitInput(chatId, flowId, false, promptMessageId);
            if (typeof value !== "string") return undefined;
            const t = value.trim();
            if (t.toLowerCase() === "cancel") return undefined;
            const n = Number.parseInt(t, 10);
            if (Number.isInteger(n) && n >= 1 && n <= capped.length) return capped[n - 1];
            const exact = capped.find((label) => label.toLowerCase() === t.toLowerCase());
            if (exact) return exact;
            await deps.transport.sendText(chatId, `Please reply with a number 1-${capped.length}, or <b>cancel</b>.`);
          }
        },

        custom: async <T>(factory: unknown): Promise<T> => {
          // Custom TUI components cannot be rendered in chat. Resolve with a
          // structured cancelled result (pi-goal reads .cancelled/.answers).
          uiLog.debug("custom dialog unsupported on Zalo", { chatId });
          void deps.transport.sendText(chatId, "ℹ️ This interactive dialog is not supported over Zalo — cancelled.");
          return { cancelled: true } as unknown as T;
        },

        // ---- Persistent/stateful UI: forward to the TUI base so the local
        // terminal stays accurate. ----
        setStatus: (key, text) => { base?.setStatus?.(key, text); },
        setWorkingMessage: (message) => { base?.setWorkingMessage?.(message); },
        setWorkingVisible: (visible) => { base?.setWorkingVisible?.(visible); },
        setWorkingIndicator: (options) => { base?.setWorkingIndicator?.(options); },
        setHiddenThinkingLabel: (label) => { base?.setHiddenThinkingLabel?.(label); },
        setWidget: ((key: string, content: unknown, options?: unknown) => {
          base?.setWidget?.(key, content as never, options as never);
        }) as ExtensionUIContext["setWidget"],
        setFooter: (factory) => { base?.setFooter?.(factory as never); },
        setHeader: (factory) => { base?.setHeader?.(factory as never); },
        setTitle: (title) => { base?.setTitle?.(title); },
        setToolsExpanded: (expanded) => { base?.setToolsExpanded?.(expanded); },
        getToolsExpanded: () => base?.getToolsExpanded?.() ?? false,
        setTheme: (theme) => base?.setTheme?.(theme as never) ?? { success: false, error: "UI not available" },
        getTheme: (name) => base?.getTheme?.(name),
        getAllThemes: () => base?.getAllThemes?.() ?? [],

        // ---- Editor/terminal: no-ops (remote turns must not touch the local editor). ----
        onTerminalInput: () => () => {},
        pasteToEditor: () => {},
        setEditorText: () => {},
        getEditorText: () => "",
        setEditorComponent: () => {},
        getEditorComponent: () => undefined,
        addAutocompleteProvider: () => {},

        get theme() { return base!.theme; },
      };
    },

    resolveInput(chatId, raw, replyToMessageId) {
      const map = pendingByTarget.get(chatId);
      if (!map || map.size === 0) return { handled: false };
      let flowId: string | undefined;
      if (replyToMessageId) {
        flowId = [...map.values()].find((p) => p.promptMessageId === replyToMessageId)?.flowId;
      }
      flowId ??= raw === undefined ? latestFlowByTarget.get(chatId) : latestFlowByTarget.get(chatId);
      if (!flowId) return { handled: false };
      const pending = map.get(flowId);
      if (!pending) return { handled: false };
      clearFlow(chatId, flowId);
      pending.resolve(raw);
      return { handled: true, promptMessageId: pending.promptMessageId };
    },

    isSensitiveInput(chatId, replyToMessageId) {
      const map = pendingByTarget.get(chatId);
      if (!map) return false;
      if (replyToMessageId) {
        const exact = [...map.values()].find((p) => p.promptMessageId === replyToMessageId);
        return exact?.sensitive === true;
      }
      const latest = latestFlowByTarget.get(chatId);
      return latest ? map.get(latest)?.sensitive === true : false;
    },

    hasPendingInput(chatId) {
      return (pendingByTarget.get(chatId)?.size ?? 0) > 0;
    },

    dispose() {
      for (const map of pendingByTarget.values()) {
        for (const pending of map.values()) {
          clearTimeout(pending.timer);
          pending.resolve(undefined);
        }
      }
      pendingByTarget.clear();
      latestFlowByTarget.clear();
    },
  };
}