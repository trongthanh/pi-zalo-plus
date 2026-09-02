// AsyncLocalStorage-based turn context, adapted from pi-telegram-plus.

import { AsyncLocalStorage } from "node:async_hooks";
import type { ZaloTurn } from "./types.ts";

const zaloTurnStorage = new AsyncLocalStorage<ZaloTurn>();

export function getCurrentZaloTurn(): ZaloTurn | undefined {
  return zaloTurnStorage.getStore();
}

export function runWithZaloTurn<T>(turn: ZaloTurn, run: () => T): T {
  return zaloTurnStorage.run(turn, run);
}
