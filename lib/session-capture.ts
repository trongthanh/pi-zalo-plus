// Active-session capture via AgentSession.prototype.bindExtensions patch.
// State lives on globalThis (Symbol) so /reload keeps the binding stable.
// Zalo adaptation of pi-telegram-plus/lib/session-capture.ts.

import { AgentSession } from "@earendil-works/pi-coding-agent";
import type { CapturedAgentSession } from "./types.ts";

type SessionCaptureState = {
  activeSession?: CapturedAgentSession;
  installed: boolean;
};

const SESSION_CAPTURE_STATE = Symbol.for("pi-zalo-plus.session-capture-state");

function getState(): SessionCaptureState {
  const g = globalThis as typeof globalThis & Record<symbol, SessionCaptureState | undefined>;
  g[SESSION_CAPTURE_STATE] ??= { installed: false };
  return g[SESSION_CAPTURE_STATE];
}

export function installAgentSessionCapture(): void {
  const state = getState();
  if (state.installed) return;
  state.installed = true;

  const proto = AgentSession.prototype as CapturedAgentSession & {
    bindExtensions: AgentSession["bindExtensions"];
  };
  const originalBindExtensions = proto.bindExtensions;

  proto.bindExtensions = async function patchedBindExtensions(this: CapturedAgentSession, bindings) {
    state.activeSession = this;
    const result = await originalBindExtensions.call(this, bindings);
    // A remote-triggered shutdown must not kill the local TUI event loop.
    const runner = this.extensionRunner as unknown as Record<string, unknown> & {
      getUIContext?: () => { notify(message: string, type?: string): void };
      shutdownHandler?: () => void;
    };
    runner.shutdownHandler = () => {
      runner.getUIContext?.().notify("⚠️ Shutdown requested. Use Ctrl+C in the terminal to stop pi.", "info");
    };
    return result;
  };
}

export function getActiveSession(): CapturedAgentSession | undefined {
  return getState().activeSession;
}
