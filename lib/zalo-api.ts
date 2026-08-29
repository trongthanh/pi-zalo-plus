// Thin Zalo Bot API client (https://bot-api.zapps.me/bot<TOKEN>/<method>).
//
// Notes validated against the live API and the official node-zalo-bot SDK:
// - The official SDK (node-zalo-bot) defaults BASE_URL to https://bot-api.zapps.me —
//   inbound updates are delivered on that host. bot-api.zaloplatforms.com accepts
//   getMe/sendMessage but its getUpdates queue stays empty (408), which made the
//   bot look deaf. Override via PI_ZALO_API_ROOT if the platform moves again.
// - Long polling returns `{ ok: false, error_code: 408, description: "Request timeout" }`
//   when no updates arrive within `timeout` seconds — that is a normal empty poll.
// - getUpdates accepts Telegram-style `{ timeout, offset, limit }`.
// - sendMessage limit is 2000 chars (UTF-16 code units); we split before calling.

import { log } from "./logger.ts";
import type { ZaloBotInfo, ZaloUpdate } from "./types.ts";

const apiLog = log.child("api");

const API_ROOT = `${process.env.PI_ZALO_API_ROOT ?? "https://bot-api.zapps.me/bot"}`;

export const ZALO_SAFE_CHUNK = 1900;

export class ZaloApiError extends Error {
  readonly errorCode?: number;
  readonly description: string;

  constructor(description: string, errorCode?: number) {
    super(`Zalo API error${errorCode !== undefined ? ` ${errorCode}` : ""}: ${description}`);
    this.name = "ZaloApiError";
    this.errorCode = errorCode;
    this.description = description;
  }
}

export function isLongPollTimeout(error: unknown): boolean {
  return error instanceof ZaloApiError && error.errorCode === 408;
}

type ApiCallOptions = {
  signal?: AbortSignal;
  /** Overall HTTP budget; long polls must wait longer than the server `timeout`. */
  timeoutMs?: number;
};

async function apiCall<T>(
  token: string,
  method: string,
  payload?: Record<string, unknown>,
  options: ApiCallOptions = {},
): Promise<T> {
  const url = `${API_ROOT}${token}/${method}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload ?? {}),
    signal: options.signal ?? (options.timeoutMs !== undefined ? AbortSignal.timeout(options.timeoutMs) : undefined),
  }).catch((error) => {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new ZaloApiError("Request timeout", 408);
    }
    throw error;
  });

  const raw = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = raw ? JSON.parse(raw) as Record<string, unknown> : {};
  } catch {
    throw new ZaloApiError(`Non-JSON response (HTTP ${response.status}): ${raw.slice(0, 200)}`, response.status);
  }

  if (parsed.ok === true) {
    return parsed.result as T;
  }
  const errorCode = typeof parsed.error_code === "number" ? parsed.error_code : response.status;
  const description = typeof parsed.description === "string" ? parsed.description : `HTTP ${response.status}`;
  throw new ZaloApiError(description, errorCode);
}

export async function getMe(token: string): Promise<ZaloBotInfo> {
  return apiCall<ZaloBotInfo>(token, "getMe", {}, { timeoutMs: 15_000 });
}

export type GetUpdatesParams = {
  timeoutSeconds?: number;
  offset?: number;
  limit?: number;
};

/** Long-poll updates. Empty polls (408) resolve to [].
 *  The Zalo API returns a SINGLE update object (not a Telegram-style array) and
 *  no update_id — delivery is auto-confirmed once returned. */
export async function getUpdates(
  token: string,
  params: GetUpdatesParams = {},
  signal?: AbortSignal,
): Promise<ZaloUpdate[]> {
  const timeoutSeconds = Math.min(params.timeoutSeconds ?? 10, 50);
  const payload: Record<string, unknown> = { timeout: timeoutSeconds, limit: params.limit ?? 100 };
  if (params.offset !== undefined) payload.offset = params.offset;
  try {
    const result = await apiCall<ZaloUpdate[] | ZaloUpdate | undefined>(token, "getUpdates", payload, {
      signal,
      timeoutMs: (timeoutSeconds + 10) * 1000,
    });
    if (Array.isArray(result)) return result;
    if (result && typeof result === "object" && "message" in result) return [result as ZaloUpdate];
    return [];
  } catch (error) {
    if (isLongPollTimeout(error)) return [];
    throw error;
  }
}

export type SentMessage = { message_id: string; date?: number };

export type SendMessageParams = {
  chatId: string;
  text: string;
  parseMode?: "markdown" | "html";
  replyToMessageId?: string;
};

export async function sendMessage(token: string, params: SendMessageParams, signal?: AbortSignal): Promise<SentMessage> {
  const payload: Record<string, unknown> = {
    chat_id: params.chatId,
    text: params.text,
  };
  if (params.parseMode) payload.parse_mode = params.parseMode;
  if (params.replyToMessageId) payload.reply_to_message_id = params.replyToMessageId;
  const result = await apiCall<SentMessage>(token, "sendMessage", payload, { signal });
  apiLog.debug("sendMessage ok", { chatId: params.chatId, messageId: result?.message_id });
  return result ?? { message_id: "" };
}

export type EditMessageParams = {
  chatId: string;
  messageId: string;
  text: string;
  parseMode?: "markdown" | "html";
};

export async function editMessageText(token: string, params: EditMessageParams, signal?: AbortSignal): Promise<SentMessage> {
  const payload: Record<string, unknown> = {
    chat_id: params.chatId,
    message_id: params.messageId,
    text: params.text,
  };
  if (params.parseMode) payload.parse_mode = params.parseMode;
  return apiCall<SentMessage>(token, "editMessageText", payload, { signal });
}

export async function deleteMessage(token: string, chatId: string, messageId: string, signal?: AbortSignal): Promise<void> {
  await apiCall<unknown>(token, "deleteMessage", { chat_id: chatId, message_id: messageId }, { signal });
}

export async function sendChatAction(token: string, chatId: string, action: string, signal?: AbortSignal): Promise<void> {
  await apiCall<unknown>(token, "sendChatAction", { chat_id: chatId, action }, { signal });
}
