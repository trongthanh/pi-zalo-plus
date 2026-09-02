// Markdown → Zalo-safe HTML conversion.
//
// Zalo's `parse_mode: "html"` supports a small tag set (b/strong, i/em, u,
// s/del/strike, h1-h6, ul/ol/li, p, div). Unknown tags are stripped but keep
// their inner text, so worst case formatting degrades gracefully. We emit only
// supported tags and escape everything else, including code blocks (rendered
// as preformatted plain text lines).

import { escapeHtml } from "./html.ts";

type Extracted = { text: string; restore: (input: string) => string };

/**
 * Pull fenced code blocks and inline code spans out of the markdown, replacing
 * them with placeholder tokens that survive HTML escaping and inline regexes.
 */
function extractCode(markdown: string): Extracted {
  const chunks: string[] = [];
  const restore = (input: string): string =>
    input.replace(/\u0000(\d+)\u0000/g, (_m, index) => chunks[Number(index)] ?? "");

  let working = markdown.replace(/```([^\n`]*)\n([\s\S]*?)```/g, (_m, langRaw: string, code: string) => {
    const lang = String(langRaw || "").trim();
    const body = escapeHtml(code.replace(/\n$/, ""));
    const label = lang ? `[code:${lang}]\n` : "";
    const index = chunks.length;
    chunks.push(`${label}${body}`);
    return `\u0000${index}\u0000`;
  });

  working = working.replace(/`([^`\n]+)`/g, (_m, code: string) => {
    const index = chunks.length;
    chunks.push(escapeHtml(code));
    return `\u0000${index}\u0000`;
  });

  return { text: working, restore };
}

function renderLine(line: string): string {
  // Headings → bold (Zalo h1-h4 also enlarge text; bold is predictable).
  const heading = line.match(/^(#{1,6})\s+(.*)$/);
  if (heading) return `<b>${heading[2].trim()}</b>`;
  if (/^(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) return "———";
  // Blockquote marker → quote glyph ("> " is already HTML-escaped to "&gt; ").
  const quote = line.match(/^(?:&gt;|>)\s?(.*)$/);
  if (quote) return `❝ ${quote[1]}`;
  // Unordered list bullets; ordered lists keep their numbers.
  const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);
  if (bullet) return `${bullet[1]}• ${bullet[2]}`;
  return line;
}

function renderInline(text: string): string {
  let out = text;
  // Links [text](url) → text (url)
  out = out.replace(/\[([^\]\n]+)\]\(([^)\s]+)[^)]*\)/g, "$1 ($2)");
  // Bold **x** / __x__
  out = out.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  out = out.replace(/(?<![\w])__([^_\n]+)__(?!\w)/g, "<b>$1</b>");
  // Strikethrough ~~x~~
  out = out.replace(/~~([^~\n]+)~~/g, "<s>$1</s>");
  // Italic *x* / _x_ (guard snake_case and file_names_with_underscores)
  out = out.replace(/(?<![\w*])\*([^*\n]+)\*(?![\w*])/g, "<i>$1</i>");
  out = out.replace(/(?<![\w_])_([^_\n]+)_(?![\w_])/g, "<i>$1</i>");
  return out;
}

/**
 * Convert markdown to Zalo-supported HTML. The result contains only escaped
 * text and supported tags, so passing `parse_mode: "html"` is always safe.
 */
export function markdownToZaloHtml(markdown: string): string {
  if (!markdown) return "";
  const { text, restore } = extractCode(markdown);
  const escaped = escapeHtml(text);
  const lines = escaped.split(/\r?\n/).map((line) => {
    const rendered = renderInline(renderLine(line));
    return rendered;
  });
  // Collapse 3+ consecutive blank lines for chat readability.
  const body = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return restore(body);
}
