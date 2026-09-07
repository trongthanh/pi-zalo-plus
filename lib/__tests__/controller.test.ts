// Tests for the unsupported-message auto-reply in the Zalo controller.

import { describe, it, expect, vi } from "vitest";
import { createZaloController } from "../controller.ts";
import type { CapturedAgentSession, ZaloIncomingMessage, ZaloTransport } from "../types.ts";
import type { ZaloUiRuntime } from "../ui.ts";

type ControllerDeps = Parameters<typeof createZaloController>[0];

function makeController(overrides: Partial<ControllerDeps> = {}) {
  const sendText = vi.fn().mockResolvedValue(undefined);
  const prompt = vi.fn().mockResolvedValue(undefined);
  const controller = createZaloController({
    getSession: () => ({
      prompt,
      // Minimal runner stub so the queue-mode prompt path can build its UI context.
      extensionRunner: { getUIContext: () => ({}), setUIContext: () => undefined },
    }) as unknown as CapturedAgentSession,
    transport: { sendText } as unknown as ZaloTransport,
    ui: { create: () => ({}) } as unknown as ZaloUiRuntime,
    authorizeUser: async () => true,
    setActiveChatId: async () => undefined,
    getBotName: () => "bot",
    getMessageMode: () => "queue",
    zaloCommands: new Map(),
    getActiveTurn: () => undefined,
    beginZaloTurn: () => ({ chatId: "chat-1" }),
    endZaloTurn: () => undefined,
    ...overrides,
  });
  return { controller, sendText, prompt };
}

function bareMessage(messageId = "msg-1"): ZaloIncomingMessage {
  // Shape of a message.unsupported.received payload: chat/from/message_id
  // only — no text, no attachments.
  return {
    chat: { id: "chat-1", chat_type: "PRIVATE" },
    message_id: messageId,
    date: Date.now(),
    from: { id: "user-1", is_bot: false, display_name: "Tester" },
  } as unknown as ZaloIncomingMessage;
}

describe("unsupported message auto-reply", () => {
  it("replies to the sender on message.unsupported.received", async () => {
    const { controller, sendText, prompt } = makeController();
    await controller.handleMessage(bareMessage(), "message.unsupported.received");
    expect(sendText).toHaveBeenCalledTimes(1);
    const [chatId, text, opts] = sendText.mock.calls[0] as [string, string, { replyToMessageId?: string }];
    expect(chatId).toBe("chat-1");
    expect(text).toContain("không đọc được");
    expect(opts.replyToMessageId).toBe("msg-1");
    // No LLM turn is spawned for unsupported content.
    expect(prompt).not.toHaveBeenCalled();
  });

  it("stays silent for known contentless events (e.g. image handled upstream)", async () => {
    const { controller, sendText } = makeController();
    await controller.handleMessage(bareMessage(), "message.image.received");
    expect(sendText).not.toHaveBeenCalled();
  });

  it("stays silent for a message with no event name (legacy shape)", async () => {
    const { controller, sendText } = makeController();
    await controller.handleMessage(bareMessage());
    expect(sendText).not.toHaveBeenCalled();
  });

  it("downloads voice notes and forwards the saved path to the agent", async () => {
    const download = vi.fn().mockResolvedValue("/tmp/voice-123.aac");
    const { controller, sendText, prompt } = makeController({
      downloadIncomingAttachment: download,
    });
    const voice = bareMessage("msg-voice");
    (voice as Record<string, unknown>).voice_url = "https://voice-aac-dl.zdn.vn/x/y.aac";
    await controller.handleMessage(voice, "message.voice.received");
    // queue-mode submits the prompt via a tail promise — flush microtasks first.
    await new Promise((r) => setTimeout(r, 0));
    expect(download).toHaveBeenCalledWith(expect.objectContaining({ kind: "voice" }));
    // The saved path reaches the agent as a [zalo attachments] block.
    expect(prompt).toHaveBeenCalledTimes(1);
    const promptText = (prompt.mock.calls[0] as unknown[])[0] as string;
    expect(promptText).toContain("[zalo attachments]");
    expect(promptText).toContain("/tmp/voice-123.aac");
    // The user gets the standard attachment-receipt confirmation, not the
    // unsupported-message auto-reply.
    expect(sendText).toHaveBeenCalledTimes(1);
    const [receiptChatId, receiptText] = sendText.mock.calls[0] as [string, string];
    expect(receiptChatId).toBe("chat-1");
    expect(receiptText).toContain("✅ Saved attachments");
    expect(receiptText).not.toContain("không đọc được");
  });

  it("ignores voice events with no downloadable URL instead of erroring", async () => {
    const { controller, sendText, prompt } = makeController();
    await controller.handleMessage(bareMessage("msg-voice-empty"), "message.voice.received");
    // Not a KNOWN contentless path and not unsupported → no reply, no prompt.
    expect(sendText).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
  });

  it("does not reply when authorization fails", async () => {
    const { controller, sendText } = makeController({
      authorizeUser: async () => false,
    });
    await controller.handleMessage(bareMessage(), "message.unsupported.received");
    expect(sendText).not.toHaveBeenCalled();
  });
});
