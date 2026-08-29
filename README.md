# pi-zalo-plus

Control the [pi coding agent](https://pi.dev) from **Zalo** — the Zalo sibling of
`pi-telegram-plus`, built on the [Zalo Bot Platform](https://bot.zaloplatforms.com)
long-polling API.

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

   **No pairing?** Run `/zalo open` (or set `"openAccess": true` in zalo.json) to
   let **any** Zalo user talk to the bot — no pairing ritual needed. Messages are
   still answered with the current pi session's context.

## Chat commands

| Command | Effect |
| --- | --- |
| `/status` | Bot + session status |
| `/help` | Command help |
| `/stop` | Interrupt the running turn / cancel a pending dialog |
| `/cancel` | Cancel a pending dialog (e.g. a select) |
| any other text | Sent to π as a prompt |

Slash commands from pi and other extensions (`/new`, `/model`, `/compact`, `/zalo`, …)
also work from chat: unknown commands are forwarded to the session's command registry.

## TUI command

`/zalo [status|on|off|pair|unpair|open|locked|reset|verbal=on|verbal=off]` — manage the
bot from the terminal: toggle polling, (re)generate the pairing code, **`open`** = skip
pairing and accept messages from any Zalo account, **`locked`** = require pairing again,
unpair, reset the update offset so undelivered updates are replayed, or toggle
**`verbal`** (chat shows thinking + tool-call lines when on; default off = replies only).

## Behavior notes

- **Pairing / security**: by default only the paired Zalo user id is served;
  everyone else is silently ignored. In **open-access mode** (`/zalo open`) any
  user who messages the bot is served and answered with the current session's
  context — use only when you control who can find the bot, since anyone may then
  run prompts/commands with the permissions of the pi session.
- **Steer / queue**: incoming messages while π is working are steered into the
  running turn by default (`messageMode: "steer"`; set `"queue"` in zalo.json to
  chain them instead). `/stop` aborts the current turn.
- **Dialogs without keyboards**: the Zalo Bot API has no inline keyboards/callback
  queries, so pi's `select` / `confirm` / `input` / `editor` dialogs are rendered as
  text (reply with a number / yes-no / free text; `/cancel` or `cancel` aborts).
  Custom TUI dialogs are not supported over chat and resolve as cancelled.
- **Verbal mode (default off)**: by default the chat carries only π's text
  replies — thinking and tool-call lines are suppressed. Toggle with
  `/zalo verbal=on` / `/zalo verbal=off` (or set `"verbal": true` in zalo.json);
  when on, detail follows the `tool` / `thinking` render levels.
- **Output rendering**: assistant markdown is converted to the Zalo-supported HTML
  subset (bold/italic/strike/lists/headings); messages longer than 2000 chars are
  split at line boundaries; thinking and tool calls render as brief lines
  (configurable `tool` / `thinking` render levels: `hidden|brief|full`).
- **Typing indicator** is sent while a turn is active.
- **Single poller**: a cross-process lock (`~/.pi/agent/zalo-poll-*.lock`) ensures
  only one pi instance polls the bot; the 408 "Request timeout" response is treated
  as a normal empty poll.
- **Files**: image/file attachments sent to the bot are downloaded into the working
  directory and their paths are appended to the prompt. Base64 image outputs from π
  are saved under `.pi-zalo-images/` in the working directory (Zalo `sendPhoto`
  accepts URLs only).

## Files

- `~/.pi/agent/zalo.json` — the single config/state file (mode 0600): `bot_token`
  plus enabled flag, paired user id, pairing code, active chat, last update
  offset, verbal flag, bot name. The legacy token-only `zalo-bot.json` is
  migrated here on startup and removed.
- `~/.pi/agent/logs/pi-zalo-plus-YYYY-MM-DD.log` — JSON-lines log
  (level via `PI_ZALO_PLUS_LOG_LEVEL=debug|info|warn|error`)

## Troubleshooting

- **401 Unauthorized in logs** → the `bot_token` in `zalo.json` was regenerated in
  the bot console; paste the new token and restart pi.
- **"Zalo polling skipped: another local pi instance is already polling"** → a
  second pi session is open with the same token. Close it, or remove the stale
  `~/.pi/agent/zalo-poll-*.lock` directory (safe when no other instance runs).
- **`/pair` or messages never arrive while polling is healthy** → known Zalo
  platform issue observed with brand-new BASIC bots: after the very first
  delivered event, inbound delivery can stop entirely (outbound `sendMessage`
  keeps working, `getUpdates` keeps returning 408-empty). Resetting the token
  fixed routing once; the durable fix was **recreating the bot** and pasting the
  new token. Verify direction with:

  ```bash
  TOKEN=$(python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/.pi/agent/zalo.json')))['bot_token'])")
  # outbound (ask the recipient to confirm it lands):
  curl -s -X POST "https://bot-api.zapps.me/bot${TOKEN}/sendMessage" \
    -H 'Content-Type: application/json' \
    -d '{"chat_id":"<user_chat_id>","text":"ping"}'
  # inbound (send the bot a message from Zalo, expect a result array):
  curl -s -X POST "https://bot-api.zapps.me/bot${TOKEN}/getUpdates" \
    -H 'Content-Type: application/json' -d '{"timeout":5}'
  ```

  **Endpoint note:** the official node-zalo-bot SDK defaults to
  `https://bot-api.zapps.me` — that host carries the inbound update queue.
  `bot-api.zaloplatforms.com` serves getMe/sendMessage but its getUpdates stays
  empty, which makes the bot look deaf while outbound still works. The extension
  defaults to `zapps.me` (override with `PI_ZALO_API_ROOT`).
