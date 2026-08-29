// ZaloTransport: splits outgoing HTML to the 2000-char Zalo limit at line
// boundaries, sends with parse_mode "html", and applies a light retry for
// transient network failures.

import {
  deleteMessage,
  editMessageText,
  ZALO_SAFE_CHUNK,
  sendChatAction,
  sendMessage,
} from "./zalo-api.ts";
import { log } from "./logger.ts";
import type { ZaloSentMessage, ZaloTransport as ZaloTransportType } from "./types.ts";

const transportLog = log.child("transport");

const RETRY_COUNT = 2;
const RETRY_DELAY_MS = 600;

/** Split text into chunks of at most `max` UTF-16 code units, preferring line breaks. */
function splitZaloText(text: string, max = ZALO_SAFE_CHUNK): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.3) {
      cut = rest.lastIndexOf(" ", max);
      if (cut < max * 0.3) cut = max;
    }
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  if (rest) chunks.push(rest);
  return chunks;
}

async function withRetry<T>(label: string, run: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRY_COUNT; attempt++) {
    try {
      return await run();
    } catch (error) {
      lastError = error;
      const retriable = !(error instanceof Error && error.name === "AbortError");
      if (!retriable || attempt === RETRY_COUNT) break;
      transportLog.warn("retrying Zalo API call", { label, attempt, error });
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * (attempt + 1)));
    }
  }
  throw lastError;
}

export function createZaloTransport(getToken: () => string | undefined): ZaloTransportType {
  const token = () => {
    const value = getToken();
    if (!value) throw new Error("Zalo bot token is not configured");
    return value;
  };

  return {
    async sendText(chatId, html, options) {
      const chunks = splitZaloText(html);
      const sent: ZaloSentMessage[] = [];
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        if (!chunk.trim()) continue;
        const message = await withRetry("sendMessage", () =>
          sendMessage(token(), {
            chatId,
            text: chunk,
            parseMode: "html",
            replyToMessageId: i === 0 ? options?.replyToMessageId : undefined,
          }));
        if (message?.message_id) sent.push({ message_id: message.message_id });
      }
      return sent;
    },

    async editText(chatId, messageId, html) {
      try {
        await withRetry("editMessageText", () =>
          editMessageText(token(), { chatId, messageId, text: html, parseMode: "html" }));
      } catch (error) {
        // Edits are best-effort (message may be unchanged/deleted).
        transportLog.debug("editText failed (ignored)", { chatId, messageId, error });
      }
    },

    async deleteMessage(chatId, messageId) {
      try {
        await withRetry("deleteMessage", () => deleteMessage(token(), chatId, messageId));
      } catch (error) {
        transportLog.debug("deleteMessage failed (ignored)", { chatId, messageId, error });
      }
    },

    async sendChatAction(chatId, action) {
      try {
        await sendChatAction(token(), chatId, action);
      } catch (error) {
        transportLog.debug("sendChatAction failed (ignored)", { chatId, action, error });
      }
    },
  };
}
