import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createZaloTransport } from "../transport.ts";
import { deleteMessage, editMessageText, sendChatAction, sendMessage } from "../zalo-api.ts";

vi.mock(import("../zalo-api.ts"), async (importOriginal) => ({
  ...await importOriginal(),
  sendMessage: vi.fn(),
  editMessageText: vi.fn(),
  deleteMessage: vi.fn(),
  sendChatAction: vi.fn(),
}));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(sendMessage).mockResolvedValue({ message_id: "sent-1" });
});
afterEach(() => vi.useRealTimers());

describe("Zalo transport enable/disable", () => {
  it("suppresses text, edits, deletes and typing while disabled", async () => {
    const getToken = vi.fn(() => "token");
    const transport = createZaloTransport(getToken, () => false);
    expect(await transport.sendText("chat", "reply")).toEqual([]);
    await transport.editText("chat", "msg", "edited");
    await transport.deleteMessage("chat", "msg");
    await transport.sendChatAction("chat", "typing");
    expect(getToken).not.toHaveBeenCalled();
    for (const call of [sendMessage, editMessageText, deleteMessage, sendChatAction]) {
      expect(call).not.toHaveBeenCalled();
    }
  });

  it("resumes outgoing traffic when re-enabled", async () => {
    let enabled = false;
    const transport = createZaloTransport(() => "token", () => enabled);
    await transport.sendText("chat", "hidden");
    enabled = true;
    expect(await transport.sendText("chat", "visible")).toEqual([{ message_id: "sent-1" }]);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith("token", expect.objectContaining({ text: "visible" }));
  });

  it("stops sending remaining chunks when disabled during a message", async () => {
    let enabled = true;
    vi.mocked(sendMessage).mockImplementation(async () => {
      enabled = false;
      return { message_id: "sent-1" };
    });
    const transport = createZaloTransport(() => "token", () => enabled);
    await transport.sendText("chat", "x".repeat(4000));
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("does not retry an API call after being disabled", async () => {
    vi.useFakeTimers();
    let enabled = true;
    vi.mocked(sendMessage).mockImplementation(async () => {
      enabled = false;
      throw new Error("temporary failure");
    });
    const transport = createZaloTransport(() => "token", () => enabled);
    const result = expect(transport.sendText("chat", "reply")).resolves.toEqual([]);
    await vi.advanceTimersByTimeAsync(2000);
    await result;
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("allows explicit command acknowledgements on a separate transport", async () => {
    const transport = createZaloTransport(() => "token", () => false);
    const commandTransport = createZaloTransport(() => "token");
    await transport.sendText("chat", "agent output");
    await commandTransport.sendText("chat", "Zalo bot disabled.");
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith("token", expect.objectContaining({ text: "Zalo bot disabled." }));
  });
});
