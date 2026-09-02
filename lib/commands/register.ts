// Command registry aggregator for pi-zalo-plus.
//
// Command registry aggregator. Each command group registers its handlers with
// the shared registry, and registerAllCommands wires them all together.
// Pattern adapted from pi-telegram-plus/lib/commands/register.ts.

import type { CapturedAgentSession, ZaloTransport, ZaloTurn, ZaloConfig, ZaloCommandHandler } from "../types.ts";
import type { ZaloPollingRuntime } from "../polling.ts";
import { registerZaloCommands } from "./zalo.ts";
import { registerLifecycleCommands } from "./lifecycle.ts";
import { registerSessionCommands } from "./session.ts";
import { registerSettingsCommands } from "./settings.ts";
import { registerStatusCommand } from "./status.ts";
import { registerHelpCommand } from "./help.ts";
import { registerZaloConfigCommands } from "./zalo-config.ts";

export type CommandRegistry = {
  registerCommand: (name: string, options: { description?: string; handler: ZaloCommandHandler }) => void;
};

/** Minimal deps — most commands only need session access. */
export type SessionDeps = {
  getSession: () => CapturedAgentSession | undefined;
};

/** Extended deps for session commands. */
export type SessionNameDeps = SessionDeps & {
  setSessionName: (name: string) => void;
  getSessionName: () => string | undefined;
};

/** Deps for zalo-config command. */
export type ZaloConfigDeps = SessionDeps & {
  getConfig: () => ZaloConfig;
  setConfig: (c: ZaloConfig) => void;
  persistConfig: (c: ZaloConfig) => Promise<void>;
};

/** Deps for commands that send directly to chat. */
export type InfoDeps = {
  getTransport?: () => ZaloTransport | undefined;
  getActiveChatId?: () => string | undefined;
  getActiveTurn?: () => ZaloTurn | undefined;
};

/** Deps for the Zalo-specific commands. */
export type ZaloCommandDeps = ZaloConfigDeps & {
  transport: ZaloTransport;
  getPolling: () => ZaloPollingRuntime;
  formatStatus: (config: ZaloConfig) => string;
  clearStatusError: () => void;
};

export function registerAllCommands(
  registry: CommandRegistry,
  sessionDeps: SessionDeps,
  sessionNameDeps: SessionNameDeps,
  getConfig: () => ZaloConfig,
  zaloConfigDeps?: ZaloConfigDeps,
  infoDeps?: InfoDeps,
): void {
  registerZaloCommands(registry, sessionDeps, zaloConfigDeps);
  registerStatusCommand(registry, getConfig, infoDeps);
  registerHelpCommand(registry);
  registerLifecycleCommands(registry);
  registerSessionCommands(registry, sessionNameDeps);
  registerSettingsCommands(registry, sessionDeps);
  if (zaloConfigDeps) registerZaloConfigCommands(registry, zaloConfigDeps);
}
