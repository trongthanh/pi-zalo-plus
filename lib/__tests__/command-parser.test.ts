import { describe, it, expect } from "vitest";
import { parseLeadingCommand } from "../command-parser.ts";

describe("parseLeadingCommand", () => {
  it("parses /command", () => {
    const result = parseLeadingCommand("/help");
    expect(result).toEqual({ name: "help", args: "" });
  });

  it("parses /command with args", () => {
    const result = parseLeadingCommand("/model gpt-4");
    expect(result).toEqual({ name: "model", args: "gpt-4" });
  });

  it("returns undefined for plain text", () => {
    expect(parseLeadingCommand("hello world")).toBeUndefined();
  });

  it("handles empty string", () => {
    expect(parseLeadingCommand("")).toBeUndefined();
  });

  it("handles / with no command", () => {
    expect(parseLeadingCommand("/")).toBeUndefined();
  });
});
