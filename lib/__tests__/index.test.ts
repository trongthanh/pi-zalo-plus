import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piZaloPlus from "../../index.ts";
import { readZaloConfig, writeZaloConfig } from "../config.ts";
import { createZaloPollingRuntime } from "../polling.ts";
import type { ZaloConfig } from "../types.ts";
import { sendMessage } from "../zalo-api.ts";

vi.mock(import("../config.ts"), async (importOriginal) => ({
  ...await importOriginal(),
  readZaloConfig: vi.fn(),
  writeZaloConfig: vi.fn(),
}));
vi.mock("../polling.ts", () => ({ createZaloPollingRuntime: vi.fn() }));
vi.mock("../session-capture.ts", () => ({
  installAgentSessionCapture: vi.fn(),
  getActiveSession: () => undefined,
}));
vi.mock(import("../logger.ts"), async (importOriginal) => ({
  ...await importOriginal(),
  initLogger: vi.fn(),
}));
vi.mock(import("../zalo-api.ts"), async (importOriginal) => ({
  ...await importOriginal(),
  sendMessage: vi.fn(),
}));

const saved: ZaloConfig = {
  zaloToken: "test-token",
  zaloEnabled: true,
  allowedUserId: "test-user",
  activeChatId: "test-chat",
  botName: "test-bot",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

let shutdown: (() => void) | undefined;
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(readZaloConfig).mockResolvedValue({ ...saved });
  vi.mocked(writeZaloConfig).mockImplementation(async (next) => next);
  vi.mocked(sendMessage).mockResolvedValue({ message_id: "sent" });
  vi.mocked(createZaloPollingRuntime).mockReturnValue({
    start: vi.fn(),
    stop: vi.fn().mockResolvedValue(undefined),
    isActive: () => true,
  });
});
afterEach(() => { shutdown?.(); shutdown = undefined; });

async function setup() {
  const hooks = new Map<string, (...args: any[]) => any>();
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
  const pi = {
    on: (name: string, handler: (...args: any[]) => any) => { hooks.set(name, handler); },
    registerCommand: (name: string, options: { handler: (args: string, ctx: any) => Promise<void> }) => {
      commands.set(name, options);
    },
  } as unknown as ExtensionAPI;
  piZaloPlus(pi);
  shutdown = () => hooks.get("session_shutdown")?.();
  await hooks.get("session_start")!();
  const pollingDeps = vi.mocked(createZaloPollingRuntime).mock.calls[0][0];
  return {
    pollingDeps,
    off: () => commands.get("zalo")!.handler("off", { ui: { notify: vi.fn() } }),
    emitReply: () => hooks.get("message_end")!({
      message: { role: "assistant", content: [{ type: "text", text: "should not leak" }] },
    }),
  };
}

describe("Zalo toggle wiring and config refresh races", () => {
  it("does not let an older config read undo a completed off command", async () => {
    const test = await setup();
    const staleRead = deferred<ZaloConfig>();
    vi.mocked(readZaloConfig).mockReturnValueOnce(staleRead.promise);
    const refresh = test.pollingDeps.reloadConfig!();
    await test.off();
    staleRead.resolve({ ...saved });
    await refresh;

    expect(test.pollingDeps.shouldPoll!()).toBe(false);
    expect(test.pollingDeps.shouldProcess!()).toBe(false);
    await test.emitReply();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("does not read the old disk state while an off command is still saving", async () => {
    const test = await setup();
    const write = deferred<ZaloConfig>();
    vi.mocked(writeZaloConfig).mockReturnValueOnce(write.promise);
    const off = test.off();
    try {
      const readCount = vi.mocked(readZaloConfig).mock.calls.length;
      await test.pollingDeps.reloadConfig!();
      expect(readZaloConfig).toHaveBeenCalledTimes(readCount);
      expect(test.pollingDeps.shouldPoll!()).toBe(false);
      await test.emitReply();
      expect(sendMessage).not.toHaveBeenCalled();
    } finally {
      write.resolve({ ...saved, zaloEnabled: false });
      await off;
    }
  });

  it("still accepts external config changes when there are no concurrent local writes", async () => {
    const test = await setup();
    vi.mocked(readZaloConfig).mockResolvedValueOnce({ ...saved, zaloEnabled: false });
    await test.pollingDeps.reloadConfig!();
    expect(test.pollingDeps.shouldPoll!()).toBe(false);
    vi.mocked(readZaloConfig).mockResolvedValueOnce({ ...saved, zaloEnabled: true });
    await test.pollingDeps.reloadConfig!();
    expect(test.pollingDeps.shouldPoll!()).toBe(true);
    await test.emitReply();
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});
