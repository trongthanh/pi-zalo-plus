// Active-session capture via AgentSession.prototype.bindExtensions patch.
// State lives on globalThis (Symbol) so /reload keeps the binding stable.
// Zalo adaptation of pi-telegram-plus/lib/session-capture.ts.

import { AgentSession } from "@earendil-works/pi-coding-agent";
import type { CapturedAgentSession } from "./types.ts";
import { getCurrentZaloTurn } from "./turn-context.ts";

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

  const proto = AgentSession.prototype;
  const originalBindExtensions = proto.bindExtensions;

  proto.bindExtensions = function patchedBindExtensions(this: AgentSession, bindings) {
    state.activeSession = this;
    const { shutdownHandler } = bindings;
    if (!shutdownHandler) return originalBindExtensions.call(this, bindings);
    // Wrap the host binding, not a private runner field. Pi carries the binding
    // forward when /reload creates a new runner for the same session.
    return originalBindExtensions.call(this, {
      ...bindings,
      shutdownHandler: () => {
        if (!getCurrentZaloTurn()) {
          shutdownHandler();
          return;
        }
        this.extensionRunner.getUIContext().notify("Remote shutdown blocked. Stop pi from the terminal.", "warning");
      },
    });
  };
}

export function getActiveSession(): CapturedAgentSession | undefined {
  return getState().activeSession;
}
