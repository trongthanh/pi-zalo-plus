// TUI status line formatter for pi-zalo-plus.
//
// Shows bot connection state, pairing status, polling activity, and verbal
// mode in the pi TUI status bar.

import type { ZaloConfig } from "./types.ts";

export const ZALO_STATUS_KEY = "zalo";

export type StatusState = {
  hasBotToken: boolean;
  enabled: boolean;
  openAccess: boolean;
  paired: boolean;
  pollingActive: boolean;
  verbal: boolean;
  busy: boolean;
  botName?: string;
  error?: string;
};

export function formatZaloStatusLine(state: StatusState): string {
  const flags: string[] = [];
  flags.push(state.enabled ? "on" : "off");
  if (state.openAccess) flags.push("open");
  else if (state.paired) flags.push("paired");
  else flags.push("unpaired");
  flags.push(state.pollingActive ? "polling" : "idle");
  flags.push(state.verbal ? "verbal" : "quiet");
  if (state.busy) flags.push("busy");
  if (state.error) flags.push(`error: ${state.error.slice(0, 60)}`);
  return `Ⓩ ${flags.join(" · ")}`;
}

export function buildStatusState(config: ZaloConfig, pollingActive: boolean, busy: boolean, error?: string): StatusState {
  return {
    hasBotToken: !!config.zaloToken,
    enabled: !!config.zaloToken && (config.zaloEnabled !== undefined ? config.zaloEnabled : true),
    openAccess: config.openAccess === true,
    paired: config.allowedUserId !== undefined,
    pollingActive,
    verbal: config.verbal === true,
    busy,
    botName: config.botName,
    error,
  };
}
