// Reproduces the /zalo status silent no-op and verifies the fix:
// pi's ExtensionRunner.setUIContext wraps the UI with `{ ...ui, select, confirm, ... }`
// (wrapUIPromptContext). A get-trap-only Proxy spreads to {} + those 5 methods,
// so ctx.ui.notify was undefined and `/zalo status` from chat silently no-op'd.
import { AsyncLocalStorage } from "node:async_hooks";

// ── pi's wrapUIPromptContext (verbatim from dist/core/extensions/runner.js) ──
function wrapUIPromptContext(ui) {
  return {
    ...ui,
    select: (title, options, opts) => ui.select(title, options, opts),
    confirm: (title, message, opts) => ui.confirm(title, message, opts),
    input: (title, placeholder, opts) => ui.input(title, placeholder, opts),
    editor: (title, prefill) => ui.editor(title, prefill),
    custom: (factory, options) => ui.custom(factory, options),
  };
}

const turnStorage = new AsyncLocalStorage();
const isSameTurn = (a, b) => a?.chatId === b.chatId && a?.sourceMessageId === b.sourceMessageId;

function routedProxy(baseUi, zaloUi, turn, { withSpreadTraps }) {
  const routedKeys = withSpreadTraps
    ? [...new Set([...Reflect.ownKeys(zaloUi), ...Reflect.ownKeys(baseUi ?? {})])].filter((k) => typeof k === "string")
    : [];
  return new Proxy({}, {
    get(_t, prop, receiver) {
      if (prop === "__piZaloPlusRoutedUi") return true;
      const currentTurn = turnStorage.getStore();
      const target = isSameTurn(currentTurn, turn) ? zaloUi : baseUi;
      const value = Reflect.get((target ?? {}), prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
    set(_t, prop, value, receiver) {
      const currentTurn = turnStorage.getStore();
      const target = isSameTurn(currentTurn, turn) ? zaloUi : baseUi;
      return Reflect.set((target ?? {}), prop, value, receiver);
    },
    has(_t, prop) {
      const currentTurn = turnStorage.getStore();
      const target = isSameTurn(currentTurn, turn) ? zaloUi : baseUi;
      return prop in ((target ?? {}));
    },
    ...(withSpreadTraps && {
      ownKeys() { return routedKeys; },
      getOwnPropertyDescriptor(_t, prop) {
        if (!routedKeys.includes(prop)) return undefined;
        return { enumerable: true, configurable: true, writable: true, value: undefined };
      },
    }),
  });
}

// ── test fixtures ─────────────────────────────────────────────────────────────
const sent = [];
const baseTui = { notify: (msg) => sent.push(["tui", msg]) };
const zaloUi = {
  notify: (msg, level) => sent.push(["zalo", level ?? "info", msg]),
  select: async () => undefined,
  setStatus: () => {},
};
const turn = { chatId: "chat-1", sourceMessageId: undefined };

function swapAndCreateCtx(routed) {
  // mimics pushZaloUiContext + createCommandContext inside runWithZaloTurn
  return turnStorage.run(turn, () => {
    const uiContext = wrapUIPromptContext(routed); // runner.setUIContext → wrap
    return { ui: uiContext }; // createContext(): get ui() { return runner.uiContext }
  });
}

const statusHandler = (ctx) => { ctx.ui.notify?.("<b>π Zalo status</b>\nPolling: active", "info"); };

// ── OLD behavior (bug): proxy without spread traps ────────────────────────────
sent.length = 0;
const oldRouted = routedProxy(baseTui, zaloUi, turn, { withSpreadTraps: false });
statusHandler(swapAndCreateCtx(oldRouted));
console.log("OLD ctx.ui.notify:", typeof swapAndCreateCtx(oldRouted).ui.notify);
console.log("OLD sends:", JSON.stringify(sent));
if (sent.length !== 0) throw new Error("expected silent no-op with old proxy");

// ── NEW behavior (fixed): proxy with ownKeys/getOwnPropertyDescriptor traps ──
sent.length = 0;
const newRouted = routedProxy(baseTui, zaloUi, turn, { withSpreadTraps: true });
const newCtx = swapAndCreateCtx(newRouted);
console.log("NEW ctx.ui.notify:", typeof newCtx.ui.notify);
statusHandler(newCtx);
console.log("NEW sends:", JSON.stringify(sent));
if (typeof newCtx.ui.notify !== "function") throw new Error("notify missing after wrap");
if (sent.length !== 1 || sent[0][0] !== "zalo" || sent[0][2] !== "<b>π Zalo status</b>\nPolling: active") {
  throw new Error("expected zalo-routed notify");
}

// dialog methods must still be present after wrap
for (const m of ["select", "confirm", "input", "editor", "custom"]) {
  if (typeof newCtx.ui[m] !== "function") throw new Error(`dialog method ${m} lost after wrap`);
}

// dialog methods must still be present after wrap and route DYNAMICALLY per call
baseTui.confirm = async () => sent.push(["tui", "confirm"]);
zaloUi.confirm = async () => sent.push(["zalo", "confirm"]);

// non-matching turn: dynamic dialog path falls back to the TUI base
sent.length = 0;
await turnStorage.run({ chatId: "other", sourceMessageId: "x" }, () => newCtx.ui.confirm("t", "m"));
if (sent.length !== 1 || sent[0][0] !== "tui") throw new Error("expected tui fallback for non-matching turn dialog");

// matching turn: dialog routes to Zalo
sent.length = 0;
await turnStorage.run(turn, () => newCtx.ui.confirm("t", "m"));
if (sent.length !== 1 || sent[0][0] !== "zalo") throw new Error("expected zalo routing for matching turn dialog");

// spread-captured methods (e.g. notify) bind at wrap time — inside the swap the
// wrap turn always matches (production path), so notify goes to Zalo:
sent.length = 0;
turnStorage.run(turn, () => newCtx.ui.notify("during swap"));
if (sent.length !== 1 || sent[0][0] !== "zalo") throw new Error("expected zalo notify during swap window");

console.log("\nPASS: routed proxy survives wrapUIPromptContext spread; notify routes to Zalo for matching turns, TUI otherwise.");
