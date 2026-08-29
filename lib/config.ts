// Configuration for pi-zalo-plus — a single config/state file.
//
// `~/.pi/agent/zalo.json` holds everything: the bot token (`bot_token`) plus
// ZaloConfig state. Persisted keys are snake_case (allowed_user_id,
// pairing_code, …); the in-memory ZaloConfig fields stay camelCase. The legacy
// token-only `zalo-bot.json` is migrated into zalo.json on startup and removed.

import { randomInt } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ZaloConfig } from "./types.ts";

export function getAgentDir(): string {
  return process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

export function getZaloStatePath(): string {
  return join(getAgentDir(), "zalo.json");
}

/** Legacy token-only file (pre-merge); migrated into zalo.json, then removed. */
export function getLegacyTokenPath(): string {
  return join(getAgentDir(), "zalo-bot.json");
}

function normalizeToken(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Extract the token from a raw record (`bot_token`, fallback `token`/`zalo_token`/`zaloToken`). */
function tokenFromRecord(raw: Record<string, unknown>): string | undefined {
  return normalizeToken(raw.bot_token ?? raw.token ?? raw.zalo_token ?? raw.zaloToken);
}

/** camelCase ZaloConfig field → persisted snake_case key in zalo.json. */
const FIELD_TO_STATE_KEY: Record<string, string> = {
  botName: "bot_name",
  zaloEnabled: "zalo_enabled",
  allowedUserId: "allowed_user_id",
  pairingCode: "pairing_code",
  openAccess: "open_access",
  activeChatId: "active_chat_id",
  lastUpdateId: "last_update_id",
  messageMode: "message_mode",
  tool: "tool",
  thinking: "thinking",
  verbal: "verbal",
};

/** Persisted snake_case key → config field (canonical keys only). */
const STATE_KEY_TO_FIELD: Record<string, string> = Object.fromEntries(
  Object.entries(FIELD_TO_STATE_KEY).map(([field, key]) => [key, field]),
);

/** Map a raw zalo.json record to ZaloConfig. Legacy camelCase keys are
 *  accepted as a fallback so pre-snake_case installs keep their state. */
function configFromState(raw: Record<string, unknown>): ZaloConfig {
  const config: Record<string, unknown> = {};
  // Canonical snake_case keys first…
  for (const [key, value] of Object.entries(raw)) {
    const field = STATE_KEY_TO_FIELD[key];
    if (field !== undefined) config[field] = value;
  }
  // …then legacy camelCase keys, only filling fields not already set.
  for (const [key, value] of Object.entries(raw)) {
    if (key in FIELD_TO_STATE_KEY && !(key in config)) config[key] = value;
  }
  const token = tokenFromRecord(raw);
  if (token) config.zaloToken = token;
  return config as ZaloConfig;
}

/** Load persisted state from zalo.json, including the bot token. */
export async function readZaloConfig(): Promise<ZaloConfig> {
  const raw = await readFile(getZaloStatePath(), "utf8").then(
    (data) => JSON.parse(data) as Record<string, unknown>,
    () => ({}) as Record<string, unknown>,
  );
  return configFromState(raw);
}

/** Atomically persist the full config to zalo.json (mode 0600) with snake_case keys. */
export async function writeZaloConfig(config: ZaloConfig): Promise<ZaloConfig> {
  const path = getZaloStatePath();
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const state: Record<string, unknown> = {};
  for (const [field, key] of Object.entries(FIELD_TO_STATE_KEY)) {
    const value = (config as unknown as Record<string, unknown>)[field];
    if (value !== undefined) state[key] = value;
  }
  const payload = JSON.stringify(
    config.zaloToken ? { bot_token: config.zaloToken, ...state } : state,
    null, 2,
  ) + "\n";
  await writeFile(tmp, payload, { mode: 0o600 });
  await rename(tmp, path);
  return config;
}

/**
 * One-time migration: if zalo.json has no token, pull `bot_token` from the
 * legacy zalo-bot.json, persist it into zalo.json and remove the legacy file.
 * Returns the (possibly enriched) config; identity is unchanged when there is
 * nothing to migrate.
 */
export async function migrateLegacyTokenFile(config: ZaloConfig): Promise<ZaloConfig> {
  if (config.zaloToken) return config;
  const raw = await readFile(getLegacyTokenPath(), "utf8").then(
    (data) => JSON.parse(data) as Record<string, unknown>,
    () => undefined,
  );
  const token = raw ? tokenFromRecord(raw) : undefined;
  if (!token) return config;
  const merged = await writeZaloConfig({ ...config, zaloToken: token });
  await rm(getLegacyTokenPath(), { force: true }).catch(() => undefined);
  return merged;
}

export function isZaloEnabled(config: ZaloConfig): boolean {
  if (config.zaloEnabled !== undefined) return config.zaloEnabled;
  // Default: enabled whenever a bot token is configured.
  return !!config.zaloToken;
}

function createPairingCode(): string {
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
