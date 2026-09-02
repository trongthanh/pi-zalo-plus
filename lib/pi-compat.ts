// Compatibility helpers for reaching into pi runtime internals.
// Adapted from pi-telegram-plus/lib/pi-compat.ts (Zalo-specific subset).

export type PiExtensionMode = "tui" | "rpc" | "json" | "print" | string;

export const ZALO_EXTENSION_MODE: PiExtensionMode = "rpc";

type RunnerLike = {
  getUIContext?(): unknown;
  setUIContext?(ui?: unknown, mode?: PiExtensionMode): void;
  createContext?(): { mode?: PiExtensionMode };
  mode?: PiExtensionMode;
};

export function getRunnerMode(runner: RunnerLike | undefined, fallback: PiExtensionMode = "tui"): PiExtensionMode {
  try {
    const mode = runner?.createContext?.().mode;
    if (typeof mode === "string") return mode;
  } catch {
    // Disposed runners may throw; fall through.
  }
  return typeof runner?.mode === "string" ? runner.mode : fallback;
}

export function setRunnerUiContext(runner: RunnerLike | undefined, ui: unknown, mode: PiExtensionMode = ZALO_EXTENSION_MODE): void {
  if (typeof runner?.setUIContext !== "function") return;
  runner.setUIContext(ui, mode);
}

function redactKnownTokenPrefix(value: string): string {
  if (value.startsWith("sk-")) return "sk-…";
  if (value.startsWith("AIza")) return "AIza…";
  if (/^gh[pousr]_/.test(value)) return `${value.slice(0, 4)}…`;
  if (value.startsWith("hf_")) return "hf_…";
  return "…";
}

/** Error message safe to display in chat: redacts tokens/keys, caps length. */
export function commandErrorMessage(error: unknown, maxLength = 500): string {
  const raw = error instanceof Error ? error.message : String(error);
  const redacted = raw
    .replace(/([?&](?:code|access_token|refresh_token|token|api[_-]?key|key)=)([^&#\s"'{}]+)/gi, "$1…")
    .replace(
      /\b(sk-[A-Za-z0-9_-]{8,}|AIza[0-9A-Za-z_-]{8,}|github_pat_[0-9A-Za-z_]{8,}|gh[pousr]_[0-9A-Za-z_]{8,}|hf_[0-9A-Za-z]{8,})\b/g,
      redactKnownTokenPrefix,
    );
  return redacted.length <= maxLength ? redacted : `${redacted.slice(0, maxLength - 1)}…`;
}
