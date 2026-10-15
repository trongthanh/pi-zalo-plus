import { afterEach, describe, expect, it, vi } from "vitest";
import { getUpdates } from "../zalo-api.ts";
import type { ZaloUpdate } from "../types.ts";

const images: ZaloUpdate[] = [
  { event_name: "message.image.received", message: { message_id: "one", photo_url: "https://example.com/one.png" } },
  { event_name: "message.image.received", message: { message_id: "two", photo_url: "https://example.com/two.png" } },
];

afterEach(() => vi.unstubAllGlobals());

describe("getUpdates image delivery shapes", () => {
  it("preserves all image events in an array response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, result: images }))));
    expect(await getUpdates("test-token")).toEqual(images);
  });

  it("preserves image events delivered as successive single-object responses", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: images[0] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: images[1] }))));
    const received = [...await getUpdates("test-token"), ...await getUpdates("test-token")];
    expect(received).toEqual(images);
  });
});
