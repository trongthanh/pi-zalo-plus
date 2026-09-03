// Renderer: pi agent events → Zalo messages. Assistant messages are rendered
// as Zalo-safe HTML on message_end; tool activity is rendered as brief inline
// lines only when `verbal` is on (default off = replies only). Adapted from
// pi-telegram-plus/lib/renderer.ts for Zalo
// (no blockquote/expandable, no oversized-code→file, images best-effort).

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { markdownToZaloHtml } from "./markdown.ts";
import type { ZaloConfig, ZaloRenderLevel, ZaloTransport, ZaloTurn } from "./types.ts";
import { RENDER_LEVELS } from "./types.ts";
import { log } from "./logger.ts";

const renderLog = log.child("renderer");

type AnyMessage = {
  role?: string;
  content?: unknown;
  errorMessage?: string;
};

function formatThinkingInline(part: Record<string, unknown>, level: ZaloRenderLevel): string {
  if (level === "hidden") return "";
  const text = part.redacted ? "[thinking redacted]" : String(part.thinking ?? "");
  if (!text) return "";
  if (level === "brief") {
    const short = text.length > 200 ? `${text.slice(0, 197)}…` : text;
    return `💭 ${short}`;
  }
  return `💭 Thinking\n${text}`;
}

function contentToRenderParts(
  content: unknown,
  thinkingLevel: ZaloRenderLevel = "brief",
  toolLevel: ZaloRenderLevel = "brief",
): { body: string; inlineEvents: string[] } {
  if (typeof content === "string") return { body: content, inlineEvents: [] };
  if (!Array.isArray(content)) return { body: "", inlineEvents: [] };
  const body: string[] = [];
  const inlineEvents: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const p = part as Record<string, unknown>;
    if (p.type === "text") body.push(String(p.text ?? ""));
    else if (p.type === "thinking") {
      const inline = formatThinkingInline(p, thinkingLevel);
      if (inline) inlineEvents.push(inline);
    } else if (p.type === "toolCall") {
      if (toolLevel === "hidden") continue;
      const name = String(p.name ?? "tool");
      inlineEvents.push(toolLevel === "brief"
        ? formatToolBrief(name, p.arguments)
        : `🔧 ${name}\n${stringifyShort(p.arguments, 1200)}`);
    }
  }
  return { body: body.filter(Boolean).join("\n\n"), inlineEvents };
}

function contentImages(content: unknown): Array<{ data: string; mimeType?: string }> {
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    if (!part || typeof part !== "object") return [];
    const p = part as Record<string, unknown>;
    return p.type === "image" && typeof p.data === "string"
      ? [{ data: p.data, mimeType: typeof p.mimeType === "string" ? p.mimeType : undefined }]
      : [];
  });
}

function stringifyShort(value: unknown, max = 900): string {
  let text: string;
  if (typeof value === "string") text = value;
  else {
    try {
      text = JSON.stringify(value, null, 2);
    } catch {
      text = String(value);
    }
  }
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function firstLine(text: string): string {
  return text.split(/\r?\n/, 1)[0].replace(/\s+/g, " ").trim();
}

function shortenSummary(text: string, max: number): string {
  if (!text || text === "{}") return "";
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function summarizeToolArgs(toolName: string, args: unknown, max = 96): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  let text = "";
  if (toolName === "edit" && typeof a.path === "string") text = a.path;
  else if (toolName === "read" && typeof a.path === "string") {
    text = a.path;
    const offset = typeof a.offset === "number" ? a.offset : undefined;
    if (offset !== undefined) text += `:${offset}`;
  } else if (toolName === "bash" && typeof a.command === "string") text = firstLine(a.command);
  else if (typeof a.path === "string") text = a.path;
  else if (typeof a.url === "string") text = a.url;
  else if (Array.isArray(a.paths)) text = a.paths.map(String).join(", ");
  else if (typeof a.query === "string") text = a.query;
  else text = stringifyShort(args, max);
  return shortenSummary(text, max);
}

function formatToolBrief(toolName: string, args: unknown): string {
  const summary = summarizeToolArgs(toolName, args);
  return summary ? `🔧 ${toolName}: ${summary}` : `🔧 ${toolName}`;
}

function summarizeFailureText(text: string): string {
  const lines = text.split(/\r?\n/).map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
  if (lines.length === 0) return "";
  const diagnostic = [...lines].reverse().find((line) => /\b(aborted|cancelled|canceled|failed|error)\b/i.test(line));
  return diagnostic ?? lines[0];
}

function summarizeToolResult(result: unknown, max = 96): string {
  if (typeof result === "string") return shortenSummary(summarizeFailureText(result.trim()), max);
  if (!result || typeof result !== "object") return stringifyShort(result, max);
  const r = result as Record<string, unknown>;
  const candidates = [r.errorMessage, r.message, r.error, r.stderr, r.stdout, r.text, r.output, r.result];
  const found = candidates.find((value) => typeof value === "string" && value.trim());
  if (typeof found === "string") return shortenSummary(summarizeFailureText(found), max);
  const body = Array.isArray(r.content)
    ? r.content.filter((p) => p && typeof p === "object" && (p as Record<string, unknown>).type === "text")
      .map((p) => String((p as Record<string, unknown>).text ?? ""))
      .join("\n\n")
    : "";
  if (body.trim()) return shortenSummary(summarizeFailureText(body), max);
  return shortenSummary(stringifyShort(result, max), max);
}

function formatToolFailureBrief(toolName: string, result: unknown, args?: unknown): string {
  const argSummary = summarizeToolArgs(toolName, args, 72);
  const resultSummary = summarizeToolResult(result, 72);
  const summary = argSummary && resultSummary ? `${argSummary} — ${resultSummary}` : argSummary || resultSummary;
  return summary ? `❌ ${toolName}: ${summary}` : `❌ ${toolName}`;
}

function renderLevel(config: ZaloConfig, key: "tool" | "thinking"): ZaloRenderLevel {
  const value = config[key];
  return (RENDER_LEVELS as readonly string[]).includes(value ?? "") ? value! : "brief";
}

async function saveImageFile(data: string): Promise<string | undefined> {
  try {
    const dir = resolve(process.cwd(), ".pi-zalo-images");
    await mkdir(dir, { recursive: true });
    const filePath = resolve(dir, `image-${Date.now()}.png`);
    await writeFile(filePath, Buffer.from(data, "base64"));
    return filePath;
  } catch (error) {
    renderLog.warn("saveImageFile failed", { error });
    return undefined;
  }
}

export function registerZaloRenderer(
  pi: ExtensionAPI,
  deps: {
    getConfig: () => ZaloConfig;
    transport: ZaloTransport;
    getActiveTurn: (chatId?: string) => ZaloTurn | undefined;
    hasActiveTurns?: () => boolean;
  },
): void {
  const sentInlineEvents = new Set<string>();

  const defaultChats = (): string[] => {
    if (deps.hasActiveTurns?.()) return [];
    const cfg = deps.getConfig();
    return cfg.zaloToken && cfg.activeChatId ? [cfg.activeChatId] : [];
  };

  const eventTargetKey = (): string | undefined => {
    const turn = deps.getActiveTurn();
    if (turn) return `chat:${turn.chatId}`;
    const chats = defaultChats();
    return chats.length === 0 ? undefined : `default:${chats.join(",")}`;
  };

  const sendToTurn = async (text: string): Promise<void> => {
    const turn = deps.getActiveTurn();
    if (turn) {
      await deps.transport.sendText(turn.chatId, text, { replyToMessageId: turn.sourceMessageId });
      return;
    }
    const chats = defaultChats();
    if (chats.length > 0) await deps.transport.sendText(chats[0], text);
  };

  const sendInlineEvent = async (event: string) => {
    const keyPrefix = eventTargetKey();
    if (!event || !keyPrefix) return;
    const key = `${keyPrefix}:${event}`;
    if (sentInlineEvents.has(key)) return;
    sentInlineEvents.add(key);
    await sendToTurn(event).catch(renderLog.swallow("warn", "sendInlineEvent failed"));
  };

  const sendInlineEvents = async (events: string[]) => {
    for (const event of events) await sendInlineEvent(event);
  };

  const toolArgs = new Map<string, unknown>();

  pi.on("agent_start", async () => {
    try {
      sentInlineEvents.clear();
      toolArgs.clear();
      const turn = deps.getActiveTurn();
      if (turn) await deps.transport.sendChatAction(turn.chatId, "typing");
    } catch (err) {
      renderLog.warn("agent_start handler failed", { err });
    }
  });

  pi.on("tool_execution_start", async (event) => {
    try {
      toolArgs.set(event.toolCallId, event.args);
      const config = deps.getConfig();
      const level = renderLevel(config, "tool");
      if (level === "hidden") return;
      const inline = level === "brief"
        ? formatToolBrief(event.toolName, event.args)
        : `🔧 ${event.toolName} started\n${stringifyShort(event.args, 1200)}`;
      await sendInlineEvent(inline);
    } catch (err) {
      renderLog.warn("tool_execution_start handler failed", { err });
    }
  });

  pi.on("tool_execution_end", async (event) => {
    try {
      const args = toolArgs.get(event.toolCallId);
      toolArgs.delete(event.toolCallId);
      const config = deps.getConfig();
      const level = renderLevel(config, "tool");
      if (level === "hidden") return;
      if (level === "brief") {
        if (!event.isError) return;
        await sendInlineEvent(formatToolFailureBrief(event.toolName, event.result, args));
        return;
      }
      // full mode: render the tool's output text.
      const parts = (event.result as { content?: unknown } | null | undefined)?.content;
      const body = Array.isArray(parts)
        ? parts.filter((p) => p && typeof p === "object" && (p as Record<string, unknown>).type === "text")
          .map((p) => String((p as Record<string, unknown>).text ?? ""))
          .join("\n\n")
        : typeof event.result === "string" ? event.result : "";
      if (body.trim()) {
        await sendToTurn(`${event.isError ? "❌" : "✅"} <b>${event.toolName}</b>\n${markdownToZaloHtml(body)}`);
      } else {
        await sendInlineEvent(`${event.isError ? "❌ Tool failed" : "✅ Tool finished"}: ${event.toolName}`);
      }
    } catch (err) {
      renderLog.warn("tool_execution_end handler failed", { err });
    }
  });

  pi.on("message_end", async (event) => {
    try {
      const message = event.message as AnyMessage;
      if (message.role !== "assistant") return;
      const config = deps.getConfig();
      const thinkingLevel = renderLevel(config, "thinking");
      const toolLevel = renderLevel(config, "tool");
      const rendered = contentToRenderParts(message.content, thinkingLevel, toolLevel);
      await sendInlineEvents(rendered.inlineEvents);
      const body = rendered.body || message.errorMessage || "";
      if (body.trim()) {
        await sendToTurn(markdownToZaloHtml(body));
      }
      const images = contentImages(message.content);
      for (const image of images) {
        // Zalo sendPhoto supports public URLs only; save base64 output locally.
        const filePath = await saveImageFile(image.data);
        if (filePath) await sendToTurn(`🖼️ Image output saved: ${filePath}`);
        else await sendToTurn("🖼️ Image output could not be saved.");
      }
    } catch (err) {
      renderLog.warn("message_end handler failed", { err });
    }
  });
}
