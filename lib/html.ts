// HTML escaping utilities for Zalo-safe HTML output.
//
// Zalo's `parse_mode: "html"` supports a small tag set (b/strong, i/em, u,
// s/del/strike, h1-h6, ul/ol/li, p, div). Unknown tags are stripped but keep
// their inner text, so worst case formatting degrades gracefully.

const ESCAPED: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>]/g, (ch) => ESCAPED[ch] ?? ch);
}
