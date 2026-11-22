// AsyncLocalStorage-based turn context, adapted from pi-telegram-plus.

import { AsyncLocalStorage } from "node:async_hooks";
import type { ZaloTurn } from "./types.ts";

// The session binding wrapper survives /reload, so it must see turns from
// the newly loaded controller as well as the original one.
const key = Symbol.for("pi-zalo-plus.turn-context");
const state = globalThis as typeof globalThis & Record<symbol, AsyncLocalStorage<ZaloTurn> | undefined>;
const zaloTurnStorage = state[key] ??= new AsyncLocalStorage<ZaloTurn>();

export function getCurrentZaloTurn(): ZaloTurn | undefined {
  return zaloTurnStorage.getStore();
}

export function runWithZaloTurn<T>(turn: ZaloTurn, run: () => T): T {
  return zaloTurnStorage.run(turn, run);
}
