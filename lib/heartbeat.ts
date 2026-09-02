// Typing indicator pulse for Zalo chat.
//
// While a Zalo turn is active, sends a periodic "typing" chat action so the
// user knows π is working on their request.

import type { ZaloTransport, ZaloTurn } from "./types.ts";
import { log } from "./logger.ts";

const heartbeatLog = log.child("heartbeat");
const TYPING_REFRESH_MS = 4_500;

export type HeartbeatDeps = {
  transport: ZaloTransport;
  getActiveTurns: () => ZaloTurn[];
};

export function createHeartbeat(deps: HeartbeatDeps) {
  let typingTimer: ReturnType<typeof setInterval> | undefined;

  const start = () => {
    if (typingTimer) return;
    typingTimer = setInterval(() => {
      const turns = deps.getActiveTurns();
      if (turns.length === 0) return;
      for (const turn of turns) {
        void deps.transport.sendChatAction(turn.chatId, "typing")
          .catch(heartbeatLog.swallow("debug", "typing pulse failed", { chatId: turn.chatId }));
      }
    }, TYPING_REFRESH_MS);
  };

  const stop = () => {
    if (!typingTimer) return;
    clearInterval(typingTimer);
    typingTimer = undefined;
  };

  const dispose = () => {
    stop();
  };

  return { start, stop, dispose };
}
