import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isZaloEnabled } from "../config.ts";
import { createZaloPollingRuntime, type ZaloPollingRuntime } from "../polling.ts";
import type { ZaloConfig, ZaloUpdate } from "../types.ts";
import { getUpdates } from "../zalo-api.ts";

vi.mock("../zalo-api.ts", () => ({
  getUpdates: vi.fn(),
  isLongPollTimeout: () => false,
}));

let dir: string;
let runtime: ZaloPollingRuntime | undefined;

beforeEach(async () => {
  vi.resetAllMocks();
  dir = await mkdtemp(join(tmpdir(), "pi-zalo-polling-test-"));
  vi.stubEnv("PI_AGENT_DIR", dir);
  // Keep the mocked long poll open until the runtime is stopped. No network.
  vi.mocked(getUpdates).mockImplementation(async (_token, _params, signal) =>
    new Promise<ZaloUpdate[]>((resolve) => {
      if (signal?.aborted) resolve([]);
      else signal?.addEventListener("abort", () => resolve([]), { once: true });
    }));
});

afterEach(async () => {
  await runtime?.stop();
  runtime = undefined;
  await rm(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

function setup(enabled: boolean, reloadConfig?: () => Promise<void>) {
  let config: ZaloConfig = { zaloToken: "test-token", zaloEnabled: enabled };
  const handleUpdate = vi.fn().mockResolvedValue(undefined);
  const onError = vi.fn();
  const reload = vi.fn(reloadConfig ?? (async () => undefined));
  runtime = createZaloPollingRuntime({
    getConfig: () => config,
    setConfig: (next) => { config = next; },
    persistUpdate: async () => undefined,
    reloadConfig: reload,
    shouldPoll: () => isZaloEnabled(config),
    shouldProcess: () => isZaloEnabled(config),
    handleUpdate,
    onError,
  });
  return {
    runtime,
    reload,
    handleUpdate,
    onError,
    setEnabled: (value: boolean) => { config = { ...config, zaloEnabled: value }; },
  };
}

const waitForPoll = (count = 1) => vi.waitFor(
  () => expect(getUpdates).toHaveBeenCalledTimes(count),
  { timeout: 3000, interval: 20 },
);

describe("polling enable/disable lifecycle", () => {
  it("resumes after starting with Zalo disabled, without another start call", async () => {
    const test = setup(false);
    test.runtime.start();
    await vi.waitFor(() => expect(test.reload).toHaveBeenCalled());
    expect(getUpdates).not.toHaveBeenCalled();
    expect(test.runtime.isActive()).toBe(false);
    expect(await readdir(dir)).toEqual([]);

    test.setEnabled(true);
    await waitForPoll();
    expect(test.runtime.isActive()).toBe(true);
    test.runtime.start(); // idempotent: no second poll loop
    expect(getUpdates).toHaveBeenCalledTimes(1);
    expect(test.onError).not.toHaveBeenCalled();
  });

  it("reloads config while idle so external enable changes take effect", async () => {
    let persistedEnabled = false;
    const test = setup(false, async () => { test.setEnabled(persistedEnabled); });
    test.runtime.start();
    await vi.waitFor(() => expect(test.reload).toHaveBeenCalled());
    expect(getUpdates).not.toHaveBeenCalled();
    persistedEnabled = true;
    await waitForPoll();
    expect(test.onError).not.toHaveBeenCalled();
  });

  it("drops a poll result received after disable and resumes on enable", async () => {
    let deliver!: (updates: ZaloUpdate[]) => void;
    vi.mocked(getUpdates).mockImplementationOnce(async () =>
      new Promise<ZaloUpdate[]>((resolve) => { deliver = resolve; }));
    const test = setup(true);
    test.runtime.start();
    await waitForPoll();
    test.setEnabled(false);
    expect(test.runtime.isActive()).toBe(false);
    deliver([{ message: { message_id: "late-message", text: "ignore" } }]);
    // Wait until the loop has consumed the result and re-entered idle state.
    await vi.waitFor(() => expect(test.reload.mock.calls.length).toBeGreaterThan(1));
    expect(test.handleUpdate).not.toHaveBeenCalled();
    test.setEnabled(true);
    await waitForPoll(2);
    expect(test.onError).not.toHaveBeenCalled();
  });

  it.each(["one batch", "successive polls"])("processes both image events in %s", async (delivery) => {
    const images: ZaloUpdate[] = [
      { event_name: "message.image.received", message: { message_id: "image-one", photo_url: "https://example.com/one.png" } },
      { event_name: "message.image.received", message: { message_id: "image-two", photo_url: "https://example.com/two.png" } },
    ];
    const test = setup(true);
    if (delivery === "one batch") vi.mocked(getUpdates).mockResolvedValueOnce(images);
    else vi.mocked(getUpdates).mockResolvedValueOnce([images[0]]).mockResolvedValueOnce([images[1]]);
    test.runtime.start();
    await vi.waitFor(() => expect(test.handleUpdate).toHaveBeenCalledTimes(2));
    expect(test.handleUpdate.mock.calls.map(([update]) => update)).toEqual(images);
    expect(test.onError).not.toHaveBeenCalled();
  });

  it("stops processing the rest of a batch after disable", async () => {
    const test = setup(true);
    vi.mocked(getUpdates).mockResolvedValueOnce([
      { message: { message_id: "first" } },
      { message: { message_id: "second" } },
    ]);
    test.handleUpdate.mockImplementation(async () => { test.setEnabled(false); });
    test.runtime.start();
    await vi.waitFor(() => expect(test.handleUpdate).toHaveBeenCalledTimes(1));
    await test.runtime.stop();
    expect(test.handleUpdate).toHaveBeenCalledTimes(1);
    expect(test.runtime.isActive()).toBe(false);
    expect(await readdir(dir)).toEqual([]);
    expect(test.onError).not.toHaveBeenCalled();
  });
});
