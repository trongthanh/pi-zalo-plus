// MCP-adapter output detection.
//
// `pi-mcp-adapter` reports proxy-tool progress and server status through pi's
// `ui.notify()` channel, with machine-ish labels such as:
//
//   MCP browserless/browserless_browserless_agent#3: 2/4
//   MCP: Failed to connect to browserless: …
//   MCP: direct tools for browserless will be available after restart
//
// Those lines are tool output, not assistant replies, so they must obey the
// same `tool` render level as tool calls/results. The Zalo UI runtime forwards
// every `ui.notify()` into chat, so it asks this helper before sending.

/** Notification text emitted by pi-mcp-adapter itself (status/progress lines). */
const MCP_NOTIFICATION_PREFIX = /^MCP(?:\s|:|$)/;

/**
 * True when a `ui.notify()` message originates from the MCP adapter rather than
 * from pi or another extension. Actionable elicitation prompts (e.g. "Opened
 * browser for MCP elicitation.") intentionally do not match — they ask the user
 * to do something and must not be suppressed.
 */
export function isMcpAdapterNotification(message: string): boolean {
  return MCP_NOTIFICATION_PREFIX.test(message.trimStart());
}

/**
 * True for MCP tool surface names: the `mcp` proxy gateway, namespaced
 * `mcp__<server>__<tool>` tools, and adapter-owned `mcp_*` helpers.
 *
 * Direct MCP tools registered as `<server>_<tool>` cannot be detected by name
 * alone; callers that need that must resolve the server list from the adapter.
 */
export function isMcpAdapterToolName(toolName: string): boolean {
  return /^mcp$|^mcp__|^mcp_/i.test(toolName);
}
