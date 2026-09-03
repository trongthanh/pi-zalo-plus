# pi-zalo-plus AGENT GUIDE

## Overview

**Full Zalo control of [pi coding agent](https://github.com/earendil-works/pi-coding-agent) — commands, interactive UI, model/session management, file transfer, and real-time streaming output, all from Zalo.**

`pi-zalo-plus` is a pi extension that turns Zalo into a full-featured remote control surface for the pi coding agent. It mirrors the core pi TUI experience into Zalo chat, with interactive menus, file attachments, live agent output rendering, and safe single-user pairing. Built on the [Zalo Bot Platform](https://bot.zaloplatforms.com) long-polling API.

## Setup

1. Create a bot at [bot.zaloplatforms.com](https://bot.zaloplatforms.com/docs/create-bot/)
   and save its token to `~/.pi/agent/zalo.json` (this single file also holds the
   extension state):

   ```json
   { "bot_token": "<YOUR_BOT_TOKEN>" }
   ```

   Migrating from an older install? A legacy `~/.pi/agent/zalo-bot.json` is
   imported into `zalo.json` on the next start and then removed automatically.

2. Install this extension at `~/.pi/agent/extensions/pi-zalo-plus/` (already in place).
   It loads automatically with pi.

3. Start pi. On first run the extension resolves the bot name via `getMe`, generates a
   one-time pairing code and shows it:

   ```
   Zalo pairing required. Send this message to the bot from your Zalo account:
   /pair 625967
   ```

4. Send `/pair <code>` to your bot from your Zalo account (or `/start <code>`).
   The first account to do so is remembered in `~/.pi/agent/zalo.json` and becomes
   the only user allowed to talk to the bot.

   **No pairing?** Run `/zalo open` (or set `"open_access": true` in zalo.json) to
   let **any** Zalo user talk to the bot — no pairing ritual needed. Messages are
   still answered with the current pi session's context.


## Files

- `~/.pi/agent/zalo.json` — the single config/state file (mode 0600); see
  [Configuration reference](#configuration-reference-zalojson) for every key.
- `~/.pi/agent/logs/pi-zalo-plus-YYYY-MM-DD.log` — JSON-lines log
  (level via `PI_ZALO_PLUS_LOG_LEVEL=debug|info|warn|error`)

## Project Structuren

```
pi-zalo-plus/
├── index.ts                     # Extension entry point
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── pi-host.d.ts                 # Type augmentation
├── scripts/
│   └── test-routed-ui-spread.mjs  # Routed UI proxy regression test
├── .pi/
│   └── settings.json            # pi package registration
└── lib/
    ├── types.ts                 # All TypeScript interfaces & types
    ├── zalo-api.ts              # Zalo Bot HTTP API client
    ├── polling.ts               # Long polling with multi-instance lock
    ├── controller.ts            # Message router & prompt executor
    ├── ui.ts                    # Interactive UI (notify, confirm, input, select)
    ├── renderer.ts              # Agent event → Zalo output renderer
    ├── markdown.ts              # Markdown → Zalo HTML converter
    ├── html.ts                  # HTML escaping utilities
    ├── text-split.ts            # UTF-8-safe text splitter
    ├── command-parser.ts        # Slash command parser
    ├── config.ts                # Configuration store
    ├── transport.ts             # Zalo API transport with retry & chunking
    ├── pairing.ts               # Bot pairing/authorization
    ├── attachments.ts           # Incoming file attachment downloader
    ├── heartbeat.ts             # Typing indicator pulse
    ├── status.ts                # TUI status line formatter
    ├── logger.ts                # File-based JSON Lines logger with rotation
    ├── session-capture.ts       # Agent session capture & handler patching
    ├── pi-compat.ts             # Pi runtime compatibility helpers
    ├── turn-context.ts          # AsyncLocalStorage turn context
    ├── commands/
    │   ├── register.ts          # Command registry aggregator
    │   ├── zalo.ts              # /zalo command (TUI + chat)
    │   ├── status.ts            # /status command
    │   ├── help.ts              # /help command
    │   ├── lifecycle.ts         # /compact, /reload, /stop, /quit
    │   ├── session.ts           # /new, /fork, /clone, /tree, /resume, /cd, /cwd, /name
    │   ├── settings.ts          # /settings menu
    │   └── zalo-config.ts       # /zalo-config
    └── __tests__/
        ├── _setup.ts
        ├── html.test.ts
        ├── text-split.test.ts
        ├── markdown.test.ts
        ├── config.test.ts
        └── command-parser.test.ts
```

