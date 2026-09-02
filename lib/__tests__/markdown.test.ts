import { describe, it, expect } from "vitest";
import { markdownToZaloHtml } from "../markdown.ts";

describe("markdownToZaloHtml", () => {
  it("converts bold", () => {
    expect(markdownToZaloHtml("**bold**")).toBe("<b>bold</b>");
    expect(markdownToZaloHtml("__bold__")).toBe("<b>bold</b>");
  });

  it("converts italic", () => {
    expect(markdownToZaloHtml("*italic*")).toBe("<i>italic</i>");
    expect(markdownToZaloHtml("_italic_")).toBe("<i>italic</i>");
  });

  it("converts strikethrough", () => {
    expect(markdownToZaloHtml("~~strike~~")).toBe("<s>strike</s>");
  });

  it("converts links to text + url", () => {
    expect(markdownToZaloHtml("[text](https://example.com)")).toBe("text (https://example.com)");
  });

  it("preserves code blocks as escaped text", () => {
    const result = markdownToZaloHtml("```\nconst x = 1;\n```");
    expect(result).toContain("const x = 1;");
    expect(result).not.toContain("<");
  });

  it("handles empty input", () => {
    expect(markdownToZaloHtml("")).toBe("");
    expect(markdownToZaloHtml(undefined as unknown as string)).toBe("");
  });

  it("converts headings to bold", () => {
    expect(markdownToZaloHtml("# Heading")).toBe("<b>Heading</b>");
    expect(markdownToZaloHtml("## Sub")).toBe("<b>Sub</b>");
  });

  it("converts unordered list items", () => {
    expect(markdownToZaloHtml("- item")).toBe("• item");
    expect(markdownToZaloHtml("* item")).toBe("• item");
  });
});
