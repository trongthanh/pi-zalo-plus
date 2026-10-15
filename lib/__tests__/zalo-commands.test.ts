import { describe, expect, it, vi } from "vitest";
import { buildChatZaloCommandHandler, registerZaloCommands } from "../commands/zalo.ts";
import type { ZaloCommandHandler, ZaloConfig } from "../types.ts";

const cases = [
  ["off", false, "Zalo bot disabled. To re-enable, run /zalo on in the local pi TUI (terminal)."],
  ["on", true, "Zalo bot enabled."],
] as const;

describe("Zalo on/off acknowledgements", () => {
  it.each(cases)("acknowledges chat /zalo %s", async (sub, enabled, expected) => {
    const config: ZaloConfig = { zaloToken: "test-token" };
    const persist = vi.fn().mockResolvedValue(undefined);
    const reply = vi.fn();
    const handler = buildChatZaloCommandHandler(() => config, persist, () => "chat", reply);
    await handler(sub);
    expect(persist).toHaveBeenCalledWith({ ...config, zaloEnabled: enabled });
    expect(reply).toHaveBeenCalledWith(expected);
  });

  it.each(cases)("acknowledges TUI /zalo %s", async (sub, enabled, expected) => {
    const config: ZaloConfig = { zaloToken: "test-token" };
    const persist = vi.fn().mockResolvedValue(undefined);
    const notify = vi.fn();
    let handler!: ZaloCommandHandler;
    registerZaloCommands({
      registerCommand: (_name, options) => { handler = options.handler; },
    }, { getSession: () => undefined }, {
      getSession: () => undefined,
      getConfig: () => config,
      setConfig: vi.fn(),
      persistConfig: persist,
    });
    await handler(sub, { ui: { notify } } as unknown as Parameters<ZaloCommandHandler>[1]);
    expect(persist).toHaveBeenCalledWith({ ...config, zaloEnabled: enabled });
    expect(notify).toHaveBeenCalledWith(expected, "info");
  });
});
