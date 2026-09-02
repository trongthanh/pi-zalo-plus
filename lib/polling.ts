// Long-polling runtime for the Zalo bot, with a cross-process poll lock so
// only one pi instance polls a given token at a time. Adapted from
// pi-telegram-plus/lib/polling.ts for the Zalo API (408 = empty poll).

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { getAgentDir } from "./config.ts";
import { getUpdates, isLongPollTimeout } from "./zalo-api.ts";
import type { ZaloConfig, ZaloUpdate } from "./types.ts";
import { log } from "./logger.ts";

const pollLog = log.child("polling");

const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const POLL_LOCK_STALE_MS = 45_000;
const POLL_LOCK_TOUCH_MS = 5_000;
const POLL_LOCK_CANDIDATE_MAX_AGE_MS = POLL_LOCK_TOUCH_MS * 2;

type PollingLockOwner = { id: string; pid: number; at: string; touchedAt: string };

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });

function lockPathForToken(token: string): string {
  const hash = createHash("sha256").update(token).digest("hex").slice(0, 24);
  return join(getAgentDir(), `zalo-poll-${hash}.lock`);
}

function isPidAlive(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function ownerText(owner: PollingLockOwner): string {
  return `${JSON.stringify(owner, null, 2)}\n`;
}

async function readLockOwner(ownerPath: string): Promise<PollingLockOwner | undefined> {
  try {
    const owner = JSON.parse(await readFile(ownerPath, "utf8")) as Partial<PollingLockOwner>;
    if (typeof owner.id !== "string" || typeof owner.pid !== "number") return undefined;
    return {
      id: owner.id,
      pid: owner.pid,
      at: typeof owner.at === "string" ? owner.at : "",
      touchedAt: typeof owner.touchedAt === "string" ? owner.touchedAt : "",
    };
  } catch {
    return undefined;
  }
}

async function isLockStale(lockPath: string): Promise<boolean> {
  const lockStat = await stat(lockPath).catch(() => undefined);
  if (!lockStat) return true;
  const owner = await readLockOwner(join(lockPath, "owner.json"));
  const heartbeatPath = owner ? join(lockPath, `heartbeat-${owner.id}`) : lockPath;
  const modifiedAt = await stat(heartbeatPath).then((v) => v.mtimeMs).catch(() => lockStat.mtimeMs);
  if (Date.now() - modifiedAt > POLL_LOCK_STALE_MS) return true;
  return owner ? !isPidAlive(owner.pid) : true;
}

async function removeArtifact(path: string, reason: string): Promise<void> {
  await rm(path, { recursive: true, force: true }).catch(pollLog.swallow("debug", reason, { path }));
}

async function cleanupLockArtifacts(lockPath: string, retainPath?: string): Promise<void> {
  const dir = dirname(lockPath);
  const base = basename(lockPath);
  const names = await readdir(dir).catch(() => [] as string[]);
  const now = Date.now();
  await Promise.all(names.map(async (name) => {
    if (name === base || name === retainPath) return;
    if (!name.startsWith(`${base}.retired-`) && !name.startsWith(`${base}.candidate-`)) return;
    const path = join(dir, name);
    if (name.startsWith(`${base}.candidate-`)) {
      const ageMs = await stat(path).then((v) => now - v.mtimeMs).catch(() => Number.POSITIVE_INFINITY);
      if (ageMs < POLL_LOCK_CANDIDATE_MAX_AGE_MS) return;
    }
    await removeArtifact(path, "remove zalo polling lock artifact failed");
  }));
}

type PollLock = { owns: () => Promise<boolean>; release: () => Promise<void> };

async function acquirePollingLock(token: string): Promise<PollLock | undefined> {
  await mkdir(getAgentDir(), { recursive: true });
  const lockPath = lockPathForToken(token);
  const ownerPath = join(lockPath, "owner.json");
  const owner: PollingLockOwner = {
    id: randomUUID(),
    pid: process.pid,
    at: new Date().toISOString(),
    touchedAt: new Date().toISOString(),
  };
  const candidatePath = `${lockPath}.candidate-${owner.id}`;
  const heartbeatName = `heartbeat-${owner.id}`;

  await cleanupLockArtifacts(lockPath, candidatePath);

  try {
    await mkdir(candidatePath, { mode: 0o700 });
    await writeFile(join(candidatePath, "owner.json"), ownerText(owner), { mode: 0o600, flag: "wx" });
    await writeFile(join(candidatePath, heartbeatName), owner.touchedAt, { mode: 0o600, flag: "wx" });
  } catch (error) {
    await rm(candidatePath, { recursive: true, force: true });
    throw error;
  }

  // Quarantine a stale live lock by renaming it out of the way.
  const stale = await isLockStale(lockPath);
  if (!stale) {
    await rm(candidatePath, { recursive: true, force: true });
    return undefined;
  }
  const exists = await stat(lockPath).then(() => true, () => false);
  if (exists) {
    const stalePath = `${lockPath}.retired-${owner.id}`;
    try {
      await rename(lockPath, stalePath);
      await removeArtifact(stalePath, "remove quarantined zalo lock failed");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        await rm(candidatePath, { recursive: true, force: true });
        return undefined;
      }
    }
  }

  try {
    await rename(candidatePath, lockPath);
  } catch (error) {
    await rm(candidatePath, { recursive: true, force: true });
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST" || code === "ENOTEMPTY") return undefined;
    throw error;
  }

  await cleanupLockArtifacts(lockPath);

  const heartbeatPath = join(lockPath, heartbeatName);
  const touch = setInterval(() => {
    owner.touchedAt = new Date().toISOString();
    void writeFile(heartbeatPath, owner.touchedAt, { mode: 0o600 })
      .catch(pollLog.swallow("warn", "zalo poll lock heartbeat write failed", { heartbeatPath }));
  }, POLL_LOCK_TOUCH_MS);

  return {
    owns: async () => (await readLockOwner(ownerPath))?.id === owner.id,
    release: async () => {
      clearInterval(touch);
      const retiredPath = `${lockPath}.retired-${owner.id}`;
      try {
        await rename(lockPath, retiredPath);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "EEXIST" || code === "ENOTEMPTY") return;
        pollLog.warn("retire zalo polling lock on release failed", { lockPath, error });
        return;
      }
      await removeArtifact(retiredPath, "remove retired zalo lock on release failed");
      await cleanupLockArtifacts(lockPath);
    },
  };
}

type ZaloUpdateBatchDeps = {
  getConfig: () => ZaloConfig;
  setConfig: (config: ZaloConfig) => void;
  persistUpdate: (config: ZaloConfig, update: ZaloUpdate) => Promise<void>;
  shouldProcess?: () => boolean;
  handleUpdate: (update: ZaloUpdate) => Promise<void>;
  onError: (error: unknown) => void;
};

/** Process updates in strict order; stop at the first failure so the offset never skips it. */
async function processZaloUpdatesBatch(updates: ZaloUpdate[], deps: ZaloUpdateBatchDeps, signal?: AbortSignal): Promise<void> {
  for (const update of updates) {
    if (signal?.aborted || (deps.shouldProcess && !deps.shouldProcess())) return;
    try {
      await deps.handleUpdate(update);
    } catch (error) {
      deps.onError(error);
      return;
    }
    // Zalo updates carry no update_id (delivery is auto-confirmed) — skip the
    // offset persist instead of rewriting zalo.json on every message.
    if (update.update_id === undefined) continue;
    const nextConfig = { ...deps.getConfig(), lastUpdateId: update.update_id };
    try {
      await deps.persistUpdate(nextConfig, update);
      deps.setConfig(nextConfig);
    } catch (error) {
      deps.onError(error);
      return;
    }
  }
}

export type ZaloPollingRuntime = {
  start(): void;
  stop(): Promise<void>;
  isActive(): boolean;
};

export function createZaloPollingRuntime(deps: ZaloUpdateBatchDeps & {
  reloadConfig?: () => Promise<void>;
  onSuccess?: () => void;
  shouldPoll?: () => boolean;
}): ZaloPollingRuntime {
  let abort: AbortController | undefined;
  let loopPromise: Promise<void> | undefined;
  let pollLock: { token: string; lock: PollLock } | undefined;

  const releasePollLock = async () => {
    const entry = pollLock;
    pollLock = undefined;
    await entry?.lock.release().catch(pollLog.swallow("warn", "zalo poll lock release failed"));
  };

  const ensurePollLock = async (token: string): Promise<boolean> => {
    if (pollLock?.token === token) {
      if (await pollLock.lock.owns()) return true;
      await releasePollLock();
    } else {
      await releasePollLock();
    }
    const lock = await acquirePollingLock(token);
    if (!lock) return false;
    pollLock = { token, lock };
    return true;
  };

  const loop = async (signal: AbortSignal) => {
    let backoffMs = MIN_BACKOFF_MS;
    try {
      while (!signal.aborted) {
        if (deps.shouldPoll && !deps.shouldPoll()) {
          await releasePollLock();
          await sleep(MIN_BACKOFF_MS, signal);
          continue;
        }
        const token = deps.getConfig().zaloToken;
        if (!token) {
          await releasePollLock();
          await sleep(MIN_BACKOFF_MS, signal);
          continue;
        }
        if (!(await ensurePollLock(token))) {
          deps.onError(new Error("Zalo polling skipped: another local pi instance is already polling this bot token."));
          await sleep(MAX_BACKOFF_MS, signal);
          continue;
        }
        try {
          await deps.reloadConfig?.();
          if (signal.aborted) return;
          const refreshedToken = deps.getConfig().zaloToken;
          if (!refreshedToken || refreshedToken !== token) continue;

          const offset = deps.getConfig().lastUpdateId;
          const updates = await getUpdates(token, {
            timeoutSeconds: 25,
            offset: offset !== undefined ? offset + 1 : undefined,
          }, signal);
          if (deps.getConfig().zaloToken !== refreshedToken) continue;
          if (deps.shouldPoll && !deps.shouldPoll()) continue;
          backoffMs = MIN_BACKOFF_MS;
          deps.onSuccess?.();

          await processZaloUpdatesBatch(updates, deps, signal);
        } catch (error) {
          if (signal.aborted) return;
          if (isLongPollTimeout(error)) continue;
          deps.onError(error);
          await sleep(backoffMs, signal);
          backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
        }
      }
    } finally {
      await releasePollLock();
    }
  };

  return {
    start() {
      if (abort || (deps.shouldPoll && !deps.shouldPoll())) return;
      const controller = new AbortController();
      abort = controller;
      loopPromise = loop(controller.signal)
        .catch((error) => {
          deps.onError(error);
        })
        .finally(() => {
          if (abort === controller) abort = undefined;
          loopPromise = undefined;
        });
    },
    async stop() {
      const controller = abort;
      controller?.abort();
      await loopPromise;
      if (abort === controller) abort = undefined;
    },
    isActive() {
      return !!abort;
    },
  };
}
