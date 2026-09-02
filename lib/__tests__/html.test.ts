import { describe, it, expect } from "vitest";
import { escapeHtml } from "../html.ts";

describe("escapeHtml", () => {
  it("escapes & < >", () => {
    expect(escapeHtml("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d");
  });

  it("passes through plain text unchanged", () => {
    expect(escapeHtml("hello world")).toBe("hello world");
  });

  it("handles empty string", () => {
    expect(escapeHtml("")).toBe("");
  });
});
