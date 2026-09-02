/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unused-vars */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Augment pi runtime types for pi-zalo-plus.
 *
 * Several pi internal types are not exported publicly but are needed for
 * full-featured extension control. This file provides local type stubs that
 * match the pi runtime shape at the supported version range.
 */

// ── Model types ────────────────────────────────────────────────────────────

declare module "@earendil-works/pi-coding-agent" {
  interface AgentSession {
    /** Current active model. */
    readonly model?: { provider: string; id: string };
    /** Scoped models list. */
    readonly scopedModels?: Array<{ model: { provider: string; id: string }; thinkingLevel?: string }>;
    /** Current thinking level. */
    readonly thinkingLevel?: string;
    /** Session statistics. */
    getSessionStats(): {
      sessionId: string;
      sessionFile?: string;
      userMessages: number;
      assistantMessages: number;
      toolCalls: number;
      tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
      cost: number;
    };
    /** Context usage info. */
    getContextUsage(): { tokens?: number; percent?: number; contextWindow: number } | undefined;
    /** Set the model. */
    setModel(model: { provider: string; id: string }): Promise<void>;
    /** Set thinking level. */
    setThinkingLevel(level: string): void;
    /** Get available thinking levels. */
    getAvailableThinkingLevels(): string[];
    /** Whether the session is currently streaming. */
    readonly isStreaming: boolean;
    /** Whether the session is compacting. */
    readonly isCompacting: boolean;
    /** Pending message count. */
    readonly pendingMessageCount: number;
    /** Session settings manager. */
    readonly settingsManager: SessionSettingsManager;
    /** Abort the current turn. */
    abort(): Promise<void>;
    /** Get the last assistant text. */
    getLastAssistantText(): string | undefined;
    /** Export session to HTML. */
    exportToHtml(path?: string): Promise<string>;
    /** Export session to JSONL. */
    exportToJsonl(path?: string): string;
    /** Session manager. */
    readonly sessionManager: SessionManagerCompat;
    /** Set scoped models. */
    setScopedModels(models: Array<{ model: { provider: string; id: string }; thinkingLevel?: string }>): void;
  }

  interface SessionSettingsManager {
    getHideThinkingBlock(): boolean;
    setHideThinkingBlock(v: boolean): void;
    getCompactionEnabled(): boolean;
    setCompactionEnabled(v: boolean): void;
    getRetryEnabled(): boolean;
    setRetryEnabled(v: boolean): void;
    getShowImages(): boolean;
    setShowImages(v: boolean): void;
    getShowTerminalProgress(): boolean;
    setShowTerminalProgress(v: boolean): void;
    getQuietStartup(): boolean;
    setQuietStartup(v: boolean): void;
    getTheme(): string | undefined;
    setTheme(v: string): void;
    getDefaultThinkingLevel(): string | undefined;
    setDefaultThinkingLevel(v: string): void;
    getBlockImages(): boolean;
    setBlockImages(v: boolean): void;
    getImageAutoResize(): boolean;
    setImageAutoResize(v: boolean): void;
    getClearOnShrink(): boolean;
    setClearOnShrink(v: boolean): void;
    getDoubleEscapeAction(): string;
    setDoubleEscapeAction(v: string): void;
    getTreeFilterMode(): string;
    setTreeFilterMode(v: string): void;
    getShellCommandPrefix(): string | undefined;
    setShellCommandPrefix(v: string | undefined): void;
  }

  interface SessionManagerCompat {
    getEntries(): Array<{ id: string; type?: string; message?: { role: string; content?: unknown } }>;
    getSessionFile(): string | undefined;
    getSessionName(): string | undefined;
    getCwd(): string;
    setSessionName(name: string): void;
    static list(cwd: string): Promise<Array<{ id: string; name?: string; path: string }>>;
    static create(cwd: string, sessionFile?: string, options?: { parentSession?: string }): SessionManagerCompat;
    static open(path: string): SessionManagerCompat;
  }

  interface ExtensionCommandContext {
    /** Whether the agent is idle. */
    isIdle?(): boolean;
    /** Wait until idle. */
    waitForIdle?(): Promise<void>;
    /** Create a new session. */
    newSession(options?: { withSession?: (ctx: any) => Promise<void> }): Promise<{ cancelled?: boolean }>;
    /** Fork session at a message. */
    fork(messageId: string, options?: { position?: "before" | "at" }): Promise<void>;
    /** Navigate the session tree. */
    navigateTree(messageId: string, options?: { summarize?: boolean }): Promise<void>;
    /** Switch to a session. */
    switchSession(path: string, options?: { withSession?: (ctx: any) => Promise<void> }): Promise<{ cancelled?: boolean }>;
    /** Compact the session. */
    compact(options?: { customInstructions?: string; onComplete?: () => void; onError?: (error: Error) => void }): void;
    /** Reload extensions. */
    reload(): Promise<void>;
    /** Abort the current turn. */
    abort(): void;
    /** Shutdown pi. */
    shutdown(): void;
  }

  interface ExtensionUIContext {
    theme: Record<string, unknown>;
    setTheme(theme: Record<string, unknown>): { success: boolean; error?: string };
    getTheme(name?: string): Record<string, unknown> | undefined;
    getAllThemes(): Array<{ name: string; label?: string }>;
  }
}

// ── Runtime model registry compat ──────────────────────────────────────────

export type PiModel = { provider: string; id: string; [key: string]: unknown };

export type PiAuthType = "oauth" | "api_key";

export interface PiModelRegistryCompat {
  getAll?(): PiModel[];
  getProviderDisplayName?(providerId: string): string;
  getProviderAuthStatus?(providerId: string): { configured: boolean; source?: string };
}

export interface PiLegacyAuthStorage {
  get(providerId: string): { type: string; key?: string } | undefined;
  set(providerId: string, value: { type: string; key?: string }): void;
  list?(): string[];
  logout?(providerId: string): void;
  getOAuthProviders?(): Array<{ id: string; name: string }>;
  login?(providerId: string, handlers: Record<string, unknown>): Promise<void>;
}

// ── Runtime auth types (pi 0.80.8+) ────────────────────────────────────────

export interface PiRuntimeLoginProviderOption {
  id: string;
  name: string;
  authType: PiAuthType;
  status?: { configured: boolean; label?: string; source?: string };
  method?: { login?(interaction: PiRuntimeAuthInteraction): Promise<void> };
}

export interface PiRuntimeAuthEvent {
  type: "auth_url" | "device_code" | "info" | "error";
  url?: string;
  verificationUri?: string;
  userCode?: string;
  message: string;
  instructions?: string;
  expiresInSeconds?: number;
  links?: Array<{ label?: string; url: string }>;
}

export interface PiRuntimeAuthPrompt {
  type: "select" | "text" | "secret" | "manual_code";
  message: string;
  placeholder?: string;
  options?: Array<{ id: string; label: string; description?: string }>;
  signal?: AbortSignal;
}

export interface PiRuntimeAuthInteraction {
  prompt(prompt: PiRuntimeAuthPrompt): Promise<string>;
  notify(event: PiRuntimeAuthEvent): void;
}

export interface PiRuntimeCredential {
  providerId: string;
  type: PiAuthType;
}
