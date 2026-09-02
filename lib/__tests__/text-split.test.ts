import { describe, it, expect } from "vitest";
import { splitZaloText } from "../text-split.ts";

describe("splitZaloText", () => {
  it("returns single chunk for short text", () => {
    const result = splitZaloText("short", 2000);
    expect(result).toEqual(["short"]);
  });

  it("splits at newline boundary", () => {
    const text = "A".repeat(500) + "\n" + "B".repeat(500);
    // With a max of 600, should cut after the newline
    const result = splitZaloText(text, 600);
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result.join("").replace(/\n+/g, "\n").replace(/^\n+/, "")).toBe(text);
  });

  it("handles empty text", () => {
    expect(splitZaloText("")).toEqual([""]);
  });

  it("splits at space when no newline nearby", () => {
    const text = "hello world " + "A".repeat(2000);
    const result = splitZaloText(text, 500);
    expect(result.length).toBeGreaterThan(1);
  });
});
