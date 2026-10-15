# pi-zalo-plus

## 1.1.0

### Minor Changes

- Convert common LaTeX notation inside explicit math spans to readable Unicode
  for Zalo, preserving code spans and blocks.
- Make incoming attachment acknowledgements respect tool rendering: hidden mode
  shows only media type and readable size (KB minimum), while brief/full modes
  retain detailed receipts. Saved paths remain available to the agent.

### Fixes

- Honor `/zalo off` for automatic outgoing messages and typing indicators, and
  resume polling after `/zalo on` even when pi started with Zalo disabled.
- Prevent stale config reads from undoing local on/off changes. The disabled
  acknowledgement now explains how to re-enable from the local TUI.
- Give concurrent downloads unique filenames to prevent image overwrites.
- Improve unsupported-message guidance for link previews whose content Zalo
  omits; document removing the preview and resending as plain text.
- Add multi-image delivery diagnostics and regression tests. Missing image
  events from Zalo polling remain a known limitation: send images individually
  and wait for each acknowledgement before sending the next (issue #4).

## 1.0.1

### Patch Changes

- handle voice message and unsupported attachment types
  - **Voice notes**: incoming Zalo voice messages (`message.voice.received`) now
    expose the direct `voice_url` — the `.aac` recording is downloaded and
    forwarded to the agent like photos/stickers, ready for multimodal models
    that accept audio input (transcription is left to the agent).
  - **Unsupported types**: message types the bot cannot read (folders, etc.)
    arrive as `message.unsupported.received` with no readable content; the bot
    now auto-replies to the sender explaining the limitation instead of
    silently dropping them. Other unknown message events are logged and
    ignored.
  - Updated the unsupported-message reply text.
  - Raised the required pi peer dependency to
    `@earendil-works/pi-coding-agent >=0.84.0` (was `>=0.76.0 <0.82.0`).

## 1.0.0

### First Release

Initial release 🎉 — full Zalo control of the [pi coding agent](https://github.com/earendil-works/pi-coding-agent): commands, interactive UI, model/session management, file transfer, and real-time streaming output, all from Zalo. Built on the [Zalo Bot Platform](https://bot.zaloplatforms.com) long-polling API.

- **Chat remote control**: send prompts to π from Zalo and get live agent
  output back. Assistant markdown is converted to the Zalo-supported HTML
  subset (bold/italic/strike/lists/headings), messages longer than 2000 chars
  are split at line boundaries, and tool calls / thinking blocks render at
  configurable levels (`hidden | brief | full`).
- **Interactive dialogs in chat**: pi's `select` / `confirm` / `input` /
  `editor` dialogs are rendered as plain text (reply with a number / yes-no /
  free text; `/cancel` or `cancel` aborts).
- **Pairing & security**: on first run the bot generates a one-time 6-digit
  code (`/pair <code>`) and locks itself to that single Zalo account
  (`allowed_user_id`); everyone else is silently ignored. `/zalo open` (or
  `"open_access": true`) serves any Zalo user without pairing.
- **Chat commands**: `/status`, `/help`, `/stop`, `/cancel`; any other text is
  sent to π as a prompt. Unknown slash commands are forwarded to the session's
  command registry, so pi and extension commands (`/new`, `/model`,
  `/compact`, …) work from chat too.
- **TUI command**: `/zalo [status|on|off|pair|unpair|open|locked|reset]` to
  manage the bot from the terminal — toggle polling, (re)generate the pairing
  code, switch open/locked access, or reset the update offset to replay
  undelivered updates.
- **Steer / queue message modes**: messages arriving while π is working are
  steered into the running turn by default (`message_mode: "steer"`), or held
  and run as the next turn with `"queue"`. `/stop` aborts the current turn.
- **File transfer**: incoming image/file attachments are downloaded into the
  directory configured by `download_dir` and their paths appended to the
  prompt; incoming stickers (`message.sticker.received`) are handled via their
  direct PNG url; base64 image outputs from π are saved under
  `.pi-zalo-images/` in the working directory.
- **Single-instance polling**: long polling with a cross-process lock
  (`~/.pi/agent/zalo-poll-*.lock`) ensures only one pi instance polls the bot;
  the 408 "Request timeout" response is treated as a normal empty poll. A
  typing indicator is sent while a turn is active.
- **One config file**: `~/.pi/agent/zalo.json` holds both settings and state
  with `snake_case` keys — legacy `camelCase` keys and the token-only
  `zalo-bot.json` are migrated automatically on startup. Hand edits are picked
  up live; every `/zalo …` command persists atomically with mode `0600`.
- **Logging**: daily JSON-lines log at
  `~/.pi/agent/logs/pi-zalo-plus-YYYY-MM-DD.log` (level via
  `PI_ZALO_PLUS_LOG_LEVEL`).
