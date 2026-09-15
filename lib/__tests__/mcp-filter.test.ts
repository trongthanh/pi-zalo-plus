import { describe, it, expect } from "vitest";
import { isMcpAdapterNotification, isMcpAdapterToolName } from "../mcp-filter.ts";

describe("isMcpAdapterNotification", () => {
  it("matches MCP adapter progress labels", () => {
    expect(isMcpAdapterNotification("MCP browserless/browserless_browserless_agent#1: 2/4")).toBe(true);
    expect(isMcpAdapterNotification("MCP browserless/browserless_agent#3")).toBe(true);
  });

  it("matches MCP adapter status lines", () => {
    expect(isMcpAdapterNotification("MCP: Failed to connect to browserless: timeout")).toBe(true);
    expect(isMcpAdapterNotification("MCP: direct tools for browserless will be available after restart")).toBe(true);
    expect(isMcpAdapterNotification("MCP initialization failed: boom")).toBe(true);
    expect(isMcpAdapterNotification("  MCP: 2 servers connected (10 tools)")).toBe(true);
  });

  it("does not match actionable elicitation prompts", () => {
    expect(isMcpAdapterNotification("Opened browser for MCP elicitation.")).toBe(false);
    expect(isMcpAdapterNotification("Could not open MCP elicitation URL: nope")).toBe(false);
  });

  it("does not match unrelated notifications", () => {
    expect(isMcpAdapterNotification("Zalo bot paired.")).toBe(false);
    expect(isMcpAdapterNotification("")).toBe(false);
  });
});

describe("isMcpAdapterToolName", () => {
  it("matches the mcp gateway and namespaced tools", () => {
    expect(isMcpAdapterToolName("mcp")).toBe(true);
    expect(isMcpAdapterToolName("mcp__browserless__browserless_browserless_agent")).toBe(true);
    expect(isMcpAdapterToolName("MCP")).toBe(true);
  });

  it("does not match built-in or direct MCP tools", () => {
    expect(isMcpAdapterToolName("bash")).toBe(false);
    expect(isMcpAdapterToolName("browserless_browserless_agent")).toBe(false);
  });
});
