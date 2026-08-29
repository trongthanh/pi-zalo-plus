// Parse and normalize leading slash commands in chat messages.

export function parseLeadingCommand(text: string): { name: string; args: string } | undefined {
  const match = text.match(/^\/([^\s@]+)(?:\s+([\s\S]*))?$/);
  if (!match) return undefined;
  return { name: match[1], args: match[2] ?? "" };
}

export function normalizeLeadingCommand(text: string, _botUsername: string | undefined): string {
  // Zalo has no @bot addressing; kept for parity with the telegram parser.
  return text;
}
