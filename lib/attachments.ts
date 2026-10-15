// Incoming file attachment downloader for Zalo.
//
// Downloads files/images from Zalo CDN URLs to a configurable directory.
// Handles the Zalo CDN edge case where cold edge nodes return 200 with empty
// body by retrying with backoff.

import { randomUUID } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { getAgentDir } from "./config.ts";
import type { ZaloConfig } from "./types.ts";
import { log } from "./logger.ts";

const attachLog = log.child("attachments");

export type IncomingMedia = {
  kind: string;
  url: string;
  fileName?: string;
};

export type DownloadedAttachment = { path: string; bytes: number };

/** Human-readable decimal file size; KB is the smallest displayed unit. */
export function formatAttachmentSize(bytes: number): string {
  const units = ["KB", "MB", "GB", "TB"];
  let size = bytes / 1000;
  let unit = 0;
  // Promote values that would otherwise round to "1,000 KB", etc.
  while (size >= 999.95 && unit < units.length - 1) {
    size /= 1000;
    unit++;
  }
  const maximumFractionDigits = size > 0 && size < 1 ? 3 : 1;
  return `${size.toLocaleString("en-US", { maximumFractionDigits })} ${units[unit]}`;
}

/** Extract media entries from an incoming Zalo message. */
export function extractMediaEntries(message: { photo_url?: string; voice_url?: string; attachments?: Array<Record<string, unknown>>; url?: string; sticker_url?: string; sticker?: string }): IncomingMedia[] {
  const entries: IncomingMedia[] = [];
  if (typeof message.photo_url === "string" && message.photo_url.startsWith("http")) {
    entries.push({ kind: "photo", url: message.photo_url });
  }
  // Voice notes (event message.voice.received): direct .aac URL in voice_url.
  if (typeof message.voice_url === "string" && message.voice_url.startsWith("http")) {
    entries.push({ kind: "voice", url: message.voice_url });
  }
  if (Array.isArray(message.attachments)) {
    for (const attachment of message.attachments) {
      if (!attachment || typeof attachment !== "object") continue;
      const url = [attachment.photo_url, attachment.url, attachment.file_url, attachment.image_url]
        .find((v): v is string => typeof v === "string" && v.startsWith("http"));
      if (!url) continue;
      const kind = typeof attachment.type === "string" ? attachment.type : "file";
      const name = typeof attachment.name === "string" ? attachment.name : undefined;
      entries.push({ kind, url, fileName: name });
    }
  }
  // Stickers (event message.sticker.received) may arrive as sticker_url,
  // photo_url, a bare sticker id, or a direct download URL in `url`.
  if (entries.length === 0) {
    const url = [message.url, message.sticker_url, message.photo_url, message.sticker]
      .find((v): v is string => typeof v === "string" && /^https?:\/\//i.test(v));
    if (url) entries.push({ kind: "sticker", url });
  }
  return entries.slice(0, 5);
}

/** Resolve the download directory from config or session cwd. */
export function resolveDownloadDir(config: ZaloConfig, sessionCwd: () => string): string {
  const configured = config.downloadDir?.trim();
  if (!configured) return sessionCwd();
  const expanded = configured === "~" || configured.startsWith("~/")
    ? join(homedir(), configured.slice(1))
    : configured;
  return resolve(expanded.startsWith("/") ? expanded : join(getAgentDir(), expanded));
}

/**
 * Download a Zalo CDN file. Retries up to 3 times with backoff for empty-body
 * responses from cold edge nodes.
 */
export async function downloadIncomingAttachment(
  media: IncomingMedia,
  downloadDir: string,
): Promise<DownloadedAttachment> {
  await mkdir(downloadDir, { recursive: true });
  const base = (media.fileName ?? `${media.kind}-${Date.now()}`)
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 100);
  const extMatch = media.url.match(/\.([a-zA-Z0-9]{1,8})(?:[?#]|$)/);
  const name = extMatch && !base.includes(".") ? `${base}.${extMatch[1]}` : base;
  // Concurrent images can share both a timestamp and a filename.
  const outputPath = resolve(downloadDir, `${Date.now()}-${randomUUID()}-${name}`);

  const fetchOnce = async (): Promise<Buffer> => {
    const response = await fetch(media.url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        Referer: "https://zzz3.zdn.vn/",
        Accept: "image/*,audio/*,application/octet-stream,*/*;q=0.8",
      },
      redirect: "follow",
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    const expected = Number(response.headers.get("content-length") ?? 0);
    if (buffer.length === 0) throw new Error("empty body (0 bytes)");
    if (expected > 0 && buffer.length !== expected) {
      throw new Error(`truncated body (${buffer.length}/${expected} bytes)`);
    }
    return buffer;
  };

  let lastError: unknown = new Error("download failed");
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const buffer = await fetchOnce();
      await writeFile(outputPath, buffer, { flag: "wx" });
      attachLog.info("attachment saved", { kind: media.kind, path: outputPath, bytes: buffer.length, attempt });
      return { path: outputPath, bytes: buffer.length };
    } catch (error) {
      lastError = error;
      attachLog.warn(`attachment download attempt ${attempt}/3 failed`, {
        url: media.url,
        reason: error instanceof Error ? error.message : String(error),
      });
      if (attempt < 3) await new Promise((r) => setTimeout(r, 600 * attempt));
    }
  }
  throw lastError;
}
