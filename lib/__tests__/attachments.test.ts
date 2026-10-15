import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadIncomingAttachment, extractMediaEntries, formatAttachmentSize } from "../attachments.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pi-zalo-images-test-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});

describe("readable attachment sizes", () => {
  it.each([
    [0, "0 KB"],
    [1, "0.001 KB"],
    [999, "0.999 KB"],
    [1000, "1 KB"],
    [1024, "1 KB"],
    [206680, "206.7 KB"],
    [229424, "229.4 KB"],
    [999999, "1 MB"],
    [1000000, "1 MB"],
    [1500000, "1.5 MB"],
    [1500000000, "1.5 GB"],
  ] as const)("formats %s bytes as %s", (bytes, expected) => {
    expect(formatAttachmentSize(bytes)).toBe(expected);
  });
});

describe("multiple incoming images", () => {
  it.each([undefined, "shared.png"])("keeps concurrent downloads distinct with filename %s", async (fileName) => {
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      new Response(url.endsWith("one.png") ? "image one" : "image two")));
    const paths = await Promise.all([
      downloadIncomingAttachment({ kind: "photo", url: "https://example.com/one.png", fileName }, dir),
      downloadIncomingAttachment({ kind: "photo", url: "https://example.com/two.png", fileName }, dir),
    ]);
    expect(paths[0].path).not.toBe(paths[1].path);
    expect(await readFile(paths[0].path, "utf8")).toBe("image one");
    expect(await readFile(paths[1].path, "utf8")).toBe("image two");
    expect(paths.map((file) => file.bytes)).toEqual([9, 9]);
    expect(await readdir(dir)).toHaveLength(2);
  });

  it("extracts both images from an attachment array", () => {
    expect(extractMediaEntries({ attachments: [
      { type: "photo", photo_url: "https://example.com/one.png" },
      { type: "photo", photo_url: "https://example.com/two.png" },
    ] })).toEqual([
      { kind: "photo", url: "https://example.com/one.png", fileName: undefined },
      { kind: "photo", url: "https://example.com/two.png", fileName: undefined },
    ]);
  });
});
