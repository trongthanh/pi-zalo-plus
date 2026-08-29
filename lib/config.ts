// Configuration for pi-zalo-plus — a single config/state file.
//
// `~/.pi/agent/zalo.json` holds everything: the bot token (`bot_token`) plus
// ZaloConfig state (pairing, offsets, toggles). The legacy token-only
// `zalo-bot.json` is migrated into zalo.json on startup and removed.

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

/** Load persisted state from zalo.json, including the bot token. */
export async function readZaloConfig(): Promise<ZaloConfig> {
  const raw = await readFile(getZaloStatePath(), "utf8").then(
    (data) => JSON.parse(data) as Record<string, unknown>,
    () => ({}) as Record<string, unknown>,
  );
  const { bot_token: _b, token: _t, zalo_token: _z, zaloToken: _zt, ...rest } = raw;
  const config = rest as ZaloConfig;
  const token = tokenFromRecord(raw);
  if (token) config.zaloToken = token;
  return config;
}

/** Atomically persist the full config — token included — to zalo.json (mode 0600). */
export async function writeZaloConfig(config: ZaloConfig): Promise<ZaloConfig> {
  const path = getZaloStatePath();
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const { zaloToken: token, ...state } = config;
  const payload = JSON.stringify(token ? { bot_token: token, ...state } : state, null, 2) + "\n";
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
