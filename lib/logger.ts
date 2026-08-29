// Minimal file logger for pi-zalo-plus. Writes JSON lines to
// `~/.pi/agent/logs/pi-zalo-plus-YYYY-MM-DD.log`, overridable via
// PI_ZALO_PLUS_LOG_LEVEL (debug/info/warn/error).

import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "./config.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

type LoggerState = {
  dir?: string;
  level: LogLevel;
};

const state: LoggerState = { level: "info" };

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function writeLine(line: string): void {
  if (!state.dir) return;
  const path = join(state.dir, `pi-zalo-plus-${today()}.log`);
  void appendFile(path, line).catch(() => undefined);
}

function emit(level: LogLevel, scope: string, message: string, fields?: LogFields): void {
  if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[state.level]) return;
  const entry = {
    t: new Date().toISOString(),
    level,
    scope,
    message,
    ...(fields && Object.keys(fields).length > 0 ? { fields } : {}),
  };
  try {
    writeLine(`${JSON.stringify(entry)}\n`);
  } catch {
    // Logging must never break the extension.
  }
}

function swallow(level: LogLevel, message: string, fields?: LogFields) {
  return (reason: unknown) => {
    emit(level, message, "swallowed error", { ...fields, reason: reason instanceof Error ? reason.message : String(reason) });
  };
}

export interface Logger {
  (level: LogLevel, message: string, fields?: LogFields): void;
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(scope: string): Logger;
  swallow(level: LogLevel, message: string, fields?: LogFields): (reason: unknown) => void;
}

function makeLogger(scope: string): Logger {
  const fn = ((level: LogLevel, message: string, fields?: LogFields) => {
    emit(level, scope, message, fields);
  }) as Logger;
  fn.debug = (message, fields) => emit("debug", scope, message, fields);
  fn.info = (message, fields) => emit("info", scope, message, fields);
  fn.warn = (message, fields) => emit("warn", scope, message, fields);
  fn.error = (message, fields) => emit("error", scope, message, fields);
  fn.child = (sub: string) => makeLogger(`${scope}/${sub}`);
  fn.swallow = (level, message, fields) => swallow(level, `${scope} ${message}`, fields);
  return fn;
}

export const log: Logger = makeLogger("zalo");

export function initLogger(options: { level?: LogLevel } = {}): void {
  state.dir = join(getAgentDir(), "logs");
  const envLevel = process.env.PI_ZALO_PLUS_LOG_LEVEL?.toLowerCase();
  state.level = envLevel === "debug" || envLevel === "info" || envLevel === "warn" || envLevel === "error"
    ? envLevel
    : options.level ?? "info";
  void mkdir(state.dir, { recursive: true }).catch(() => undefined);
}
