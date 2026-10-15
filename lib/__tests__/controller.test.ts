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
    ui: {
      create: () => ({}),
      isSensitiveInput: () => false,
      resolveInput: () => ({ handled: false }),
    } as unknown as ZaloUiRuntime,
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
    expect(text).toContain("xoá bản xem trước rồi gửi lại");
    expect(opts.replyToMessageId).toBe("msg-1");
    // No LLM turn is spawned for unsupported content.
    expect(prompt).not.toHaveBeenCalled();
  });

  it.each(["message.unsupported.received", "message.text.received"])(
    "forwards link text without an unsupported warning for %s",
    async (eventName) => {
      const { controller, sendText, prompt } = makeController();
      const text = "Please check https://example.com/article";
      await controller.handleMessage({ ...bareMessage(), text }, eventName);
      await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
      expect(prompt.mock.calls[0][0]).toBe(text);
      expect(sendText).not.toHaveBeenCalled();
    },
  );

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
    const download = vi.fn().mockResolvedValue({ path: "/tmp/voice-123.aac", bytes: 123 });
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

  it("downloads both images and includes both saved paths in the prompt and receipt", async () => {
    const download = vi.fn(async (media: { url: string }) => ({
      path: media.url.endsWith("one.png") ? "/tmp/image-one.png" : "/tmp/image-two.png",
      bytes: 123,
    }));
    const { controller, sendText, prompt } = makeController({ downloadIncomingAttachment: download });
    await controller.handleMessage({
      ...bareMessage("msg-images"),
      attachments: [
        { type: "photo", photo_url: "https://example.com/one.png" },
        { type: "photo", photo_url: "https://example.com/two.png" },
      ],
    }, "message.image.received");
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
    expect(download).toHaveBeenCalledTimes(2);
    const promptText = prompt.mock.calls[0][0] as string;
    expect(promptText).toContain("/tmp/image-one.png");
    expect(promptText).toContain("/tmp/image-two.png");
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText.mock.calls[0][1]).toContain("/tmp/image-one.png");
    expect(sendText.mock.calls[0][1]).toContain("/tmp/image-two.png");
  });

  it.each(["hidden", "brief", "full"] as const)("formats image receipts at tool level %s", async (level) => {
    const download = vi.fn(async (media: { url: string }) => media.url.endsWith("one.png")
      ? { path: "/tmp/private/image-one.png", bytes: 206680 }
      : { path: "/tmp/private/image-two.png", bytes: 229424 });
    const { controller, sendText, prompt } = makeController({
      getToolRenderLevel: () => level,
      downloadIncomingAttachment: download,
    });
    await controller.handleMessage({
      ...bareMessage("msg-receipts"),
      attachments: [
        { type: "photo", photo_url: "https://example.com/one.png" },
        { type: "image", photo_url: "https://example.com/two.png" },
      ],
    }, "message.image.received");
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
    const receipt = sendText.mock.calls[0][1] as string;
    if (level === "hidden") {
      expect(receipt).toBe("✅ Image received (206.7 KB).\n✅ Image received (229.4 KB).");
      expect(receipt).not.toContain("/tmp/");
      expect(receipt).not.toContain("https://");
    } else {
      expect(receipt).toContain("✅ Saved attachments (local paths)");
      expect(receipt).toContain("/tmp/private/image-one.png");
      expect(receipt).toContain("/tmp/private/image-two.png");
    }
    // The agent always needs the saved paths, even when chat receipts hide them.
    expect(prompt.mock.calls[0][0]).toContain("/tmp/private/image-one.png");
    expect(prompt.mock.calls[0][0]).toContain("/tmp/private/image-two.png");
    expect(sendText.mock.calls[0][2]).toEqual({ replyToMessageId: "msg-receipts" });
  });

  it("does not leak URLs or filesystem errors in hidden-mode failure receipts", async () => {
    const { controller, sendText, prompt } = makeController({
      getToolRenderLevel: () => "hidden",
      downloadIncomingAttachment: vi.fn().mockRejectedValue(new Error("EACCES: /tmp/private/image.png")),
    });
    await controller.handleMessage({
      ...bareMessage("msg-failed-image"),
      photo_url: "https://example.com/private.png",
    }, "message.image.received");
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
    expect(sendText.mock.calls[0][1]).toBe("⚠️ Image could not be saved. Please resend.");
    expect(prompt.mock.calls[0][0]).toContain("failed to save");
  });

  it("uses path-free readable-size receipts for voice notes when tool rendering is hidden", async () => {
    const { controller, sendText, prompt } = makeController({
      getToolRenderLevel: () => "hidden",
      downloadIncomingAttachment: vi.fn().mockResolvedValue({ path: "/tmp/private/voice.aac", bytes: 1024 }),
    });
    await controller.handleMessage({
      ...bareMessage("msg-voice-receipt"),
      voice_url: "https://example.com/voice.aac",
    }, "message.voice.received");
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
    expect(sendText.mock.calls[0][1]).toBe("✅ Voice message received (1 KB).");
    expect(prompt.mock.calls[0][0]).toContain("/tmp/private/voice.aac");
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
