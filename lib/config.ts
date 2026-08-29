// Configuration for pi-zalo-plus.
//
// - Bot token:    `~/.pi/agent/zalo-bot.json`  → `{ "bot_token": "..." }`
// - State:        `~/.pi/agent/zalo.json`      → ZaloConfig (pairing, offsets, toggles)

import { randomInt } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ZaloConfig } from "./types.ts";

export function getAgentDir(): string {
  return process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

export function getZaloTokenPath(): string {
  return join(getAgentDir(), "zalo-bot.json");
}

export function getZaloStatePath(): string {
  return join(getAgentDir(), "zalo.json");
}

/** Read the bot token from zalo-bot.json (`bot_token`, fallback `token`). */
export async function readBotTokenFromFile(): Promise<string | undefined> {
  try {
    const raw = JSON.parse(await readFile(getZaloTokenPath(), "utf8")) as Record<string, unknown>;
    const token = raw.bot_token ?? raw.token ?? raw.zalo_token;
    return typeof token === "string" && token.trim() ? token.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** Load persisted state, merged with the token file (token file wins for the token). */
export async function readZaloConfig(): Promise<ZaloConfig> {
  const [state, token] = await Promise.all([
    readFile(getZaloStatePath(), "utf8").then(
      (raw) => JSON.parse(raw) as ZaloConfig,
      () => ({}) as ZaloConfig,
    ),
    readBotTokenFromFile(),
  ]);
  const config: ZaloConfig = { ...state };
  if (token) config.zaloToken = token;
  return config;
}

/** Atomically persist the mutable subset of config to zalo.json (mode 0600).
 *  The bot token is NOT persisted here — it lives only in zalo-bot.json. */
export async function writeZaloConfig(config: ZaloConfig): Promise<ZaloConfig> {
  const path = getZaloStatePath();
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const { zaloToken: _token, ...state } = config;
  const payload = JSON.stringify(state, null, 2) + "\n";
  await writeFile(tmp, payload, { mode: 0o600 });
  await rename(tmp, path);
  return config;
}

export function isZaloEnabled(config: ZaloConfig): boolean {
  if (config.zaloEnabled !== undefined) return config.zaloEnabled;
  // Default: enabled whenever a bot token is configured.
  return !!config.zaloToken;
}

export function createPairingCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

/** Ensure a pairing code exists while the bot is unpaired; clear it once paired. */
export function ensurePairingCode(config: ZaloConfig): ZaloConfig {
  if (config.allowedUserId !== undefined) {
    if (config.pairingCode === undefined) return config;
    const { pairingCode: _drop, ...rest } = config;
    return rest;
  }
  if (config.pairingCode) return config;
  return { ...config, pairingCode: createPairingCode() };
}
