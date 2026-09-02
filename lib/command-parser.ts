// Parse leading slash commands in chat messages. (Zalo has no @bot
// addressing, unlike the pi-telegram-plus sibling this was adapted from.)

export function parseLeadingCommand(text: string): { name: string; args: string } | undefined {
  const match = text.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
  if (!match) return undefined;
  return { name: match[1], args: match[2] ?? "" };
}
