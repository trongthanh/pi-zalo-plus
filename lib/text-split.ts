// UTF-8-safe text splitter for Zalo's 2000-character message limit.
//
// Zalo's sendMessage accepts at most 2000 UTF-16 code units per call.
// Messages are split at line boundaries to preserve readability.

import { ZALO_SAFE_CHUNK } from "./zalo-api.ts";

/** Split text into chunks of at most `max` UTF-16 code units, preferring line breaks. */
export function splitZaloText(text: string, max = ZALO_SAFE_CHUNK): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.3) {
      cut = rest.lastIndexOf(" ", max);
      if (cut < max * 0.3) cut = max;
    }
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  if (rest) chunks.push(rest);
  return chunks;
}
