// Pairing: the bot only talks to the paired Zalo user id. While unpaired, a
// one-time code (persisted in zalo.json) links the first account that sends
// `/pair <code>` (or `/start <code>`).

import type { ZaloConfig } from "./types.ts";

export type ZaloAuthorizationDecision = {
  authorized: boolean;
  /** True when this message completed pairing. */
  paired: boolean;
  config: ZaloConfig;
};

export function extractPairingCode(text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  if (!trimmed) return undefined;
  const match = trimmed.match(/^\/(?:pair|start)\s+([A-Za-z0-9_-]+)\s*$/i);
  return match?.[1];
}

export function authorizeZaloUser(
  config: ZaloConfig,
  userId: string | undefined,
  text?: string,
): ZaloAuthorizationDecision {
  if (!userId) return { authorized: false, paired: false, config };
  // Open access: any Zalo user is allowed, no pairing needed.
  if (config.openAccess === true) {
    return { authorized: true, paired: false, config };
  }
  if (config.allowedUserId !== undefined) {
    return { authorized: config.allowedUserId === userId, paired: false, config };
  }
  const code = extractPairingCode(text);
  if (config.pairingCode && code && code === config.pairingCode) {
    const { pairingCode: _drop, ...rest } = config;
    return { authorized: true, paired: true, config: { ...rest, allowedUserId: userId } };
  }
  return { authorized: false, paired: false, config };
}

export function formatPairingInstructions(config: ZaloConfig): string {
  if (config.openAccess === true) return "Zalo bot is in open-access mode: any user can talk to it.";
  if (config.allowedUserId !== undefined) return "Zalo user is already paired.";
  if (!config.pairingCode) return "Zalo pairing is required, but no pairing code is available.";
  return `Zalo pairing required. Send this message to the bot from your Zalo account:\n/pair ${config.pairingCode}`;
}
