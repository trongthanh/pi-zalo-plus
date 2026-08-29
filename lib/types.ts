// Types for the pi-zalo-plus extension (Zalo chat control of pi coding agent).

export type ZaloRenderLevel = "hidden" | "brief" | "full";
export type ZaloMessageMode = "queue" | "steer";

export const RENDER_LEVELS: readonly ZaloRenderLevel[] = ["hidden", "brief", "full"] as const;

/**
 * Persisted extension state. Stored in `~/.pi/agent/zalo.json`.
 * The bot token itself lives in `~/.pi/agent/zalo-bot.json` (`{ "bot_token": "..." }`).
 */
export type ZaloConfig = {
  zaloToken?: string;
  /** Bot display name resolved via getMe (informational). */
  botName?: string;
  zaloEnabled?: boolean;
  /** Zalo user id (string) allowed to talk to the bot. */
  allowedUserId?: string;
  /** One-time pairing code required before allowedUserId is set. */
  pairingCode?: string;
  /** Open access: any Zalo user may talk to the bot (no pairing required). */
  openAccess?: boolean;
  /** Last chat that interacted with the bot. */
  activeChatId?: string;
  /** Last processed getUpdates offset. */
  lastUpdateId?: number;
  /** How to render tool executions in Zalo. */
  tool?: ZaloRenderLevel;
  /** How to render thinking blocks in Zalo. */
  thinking?: ZaloRenderLevel;
  /** How to handle incoming messages while the agent is running:
   *  "steer" — inject into the current turn (default); "queue" — wait. */
  messageMode?: ZaloMessageMode;
  /** When true, thinking and tool-call lines are rendered in chat (detail via
   *  the tool/thinking levels). Default false — chat carries only π's replies. */
  verbal?: boolean;
};

// ── Zalo Bot API shapes (subset used by this extension) ─────────────────────

export type ZaloUser = {
  id?: string;
  display_name?: string;
  is_bot?: boolean;
};

export type ZaloChat = {
  id?: string;
  chat_type?: string;
  name?: string;
};

export type ZaloIncomingMessage = {
  message_id?: string;
  text?: string;
  chat?: ZaloChat;
  from?: ZaloUser;
  date?: number;
  photo_url?: string;
  attachments?: Array<Record<string, unknown>>;
};

export type ZaloUpdate = {
  update_id?: number;
  event_name?: string;
  message?: ZaloIncomingMessage;
};

export type ZaloBotInfo = {
  id?: string;
  display_name?: string;
  account_name?: string;
  account_type?: string;
};

export type ZaloTurn = {
  chatId: string;
  /** Incoming Zalo message that started this turn. */
  sourceMessageId?: string;
};

export type ZaloSentMessage = { message_id: string };

export type ZaloSendOptions = {
  replyToMessageId?: string;
};

/** Outgoing transport surface used by ui/controller/renderer. */
export type ZaloTransport = {
  sendText(chatId: string, html: string, options?: ZaloSendOptions): Promise<ZaloSentMessage[]>;
  editText(chatId: string, messageId: string, html: string): Promise<void>;
  deleteMessage(chatId: string, messageId: string): Promise<void>;
  sendChatAction(chatId: string, action: string): Promise<void>;
};

export type CapturedAgentSession = import("@earendil-works/pi-coding-agent").AgentSession & {
  extensionRunner: import("@earendil-works/pi-coding-agent").AgentSession["extensionRunner"] & {
    getUIContext(): import("@earendil-works/pi-coding-agent").ExtensionUIContext;
    setUIContext(ui?: import("@earendil-works/pi-coding-agent").ExtensionUIContext, mode?: string): void;
  };
};
