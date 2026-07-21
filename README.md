# pi-telegram

Telegram runtime adapter for [`pi`](https://github.com/badlogic/pi). Turns a
private Telegram DM with a bot you control into a session-local operator
console — streamed replies, inline keyboards, weather, and a hard allowlist.

Built for single-user, security-first use on a personal machine.

## What it does

- Receives DMs (text, photos, documents, voice notes) and forwards them to pi
- Streams pi's reply back as Telegram messages with live draft preview
- Interactive inline keyboards for model picker, queue browser, thinking
  level, tool toggles, and **approve/deny** on every `tool_call` that needs
  permission
- Slash commands from Telegram forwarded to pi's command parser
  (`/compact`, `/new`, `/model`, `/thinking`, `/abort`, `/queue`,
  `/status`, plus the `tg*` family)
- Singleton lock so two pi processes don't both poll the same bot
- Bot token stored in the GNOME keyring — never on disk in plaintext
- Hard allowlist: only one configured `chat_id` may drive the bot

## Security model

| Concern | Mitigation |
|---|---|
| Bot token in plaintext | Token in GNOME keyring (`secret-tool`); JSON config holds only non-secret state |
| Random DM hijack | Hard allowlist of one `chat_id`; other updates dropped silently at the polling layer |
| Arbitrary command execution from update data | No `child_process.spawn` on any update-derived content. Buttons are typed; the only outbound commands are `deleteMessage` and `sendChatAction` |
| Two pi sessions both polling | O_EXCL pidfile at `~/.pi/agent/telegram.lock` (stale-pid detection + takeover) |
| Keyring unavailable | `secret-tool` lookup failure is treated as "no token" → startup fails loud. No silent fallback to plaintext |
| Token leaking to logs | `redactToken()` helper for any string that touches bot config; status output passes through it |

## Requirements

- **Node.js** ≥ 22.19.0
- **pi** (the coding agent) with the extension system
- `libsecret-tools` and `jq` (Ubuntu: `sudo apt install libsecret-tools jq`)
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- Your numeric Telegram chat ID

## Install

```bash
# 1. Install system deps (once)
sudo apt install libsecret-tools jq

# 2. Get a bot token from @BotFather and your numeric chat ID

# 3. Run the interactive setup
./scripts/setup.sh

# 4. Install dependencies
npm install
```

### Wire into pi

Add the local path to `~/.pi/agent/settings.json`:

```json
{
  "extensions": [
    "/path/to/pi-telegram"
  ]
}
```

For ad-hoc testing without editing settings:

```bash
pi -e /path/to/pi-telegram/index.ts
```

The first run will ask you to run `/telegram-setup` to configure the token
and chat ID.

## Commands available from Telegram

| Command | What it does |
|---|---|
| `/tgstatus` | Show transport + queue + session info |
| `/tgqueue` | Show queued turns, with 👍/🗑 inline buttons |
| `/tgmodel` | Open the model picker (paginated) |
| `/tgthinking` | Set thinking level |
| `/tgtools` | Toggle a tool on/off |
| `/tgabort` | Abort the current turn |
| `/tgnew` | New session |
| `/tgcompact` | Compact the session |
| `/tgreconnect` | Force a long-poll reconnect |
| `/tgapprove [clear]` | Show / clear the always-allow list |
| `/tgweather <location>` | Current weather + today's high/low via Open-Meteo |
| `/tgweather forecast <location>` | 7-day forecast for a location |
| `/tgweather <location> this week` | Shorthand for a forecast query |
| `/tgweather-setdefault <location>` | Set default location for bare weather queries |
| `/tgweather-cleargetdefault` | Clear the default weather location |
| `/telegram-setup` | One-shot config (token + chat ID) |
| `/abort` `/compact` `/new` `/model` `/thinking` `/queue` `/status` | pi core commands (forwarded) |

## Weather

Casual weather queries are intercepted before they reach the LLM:

- "what's the weather in London?" → current conditions + today's high/low
- "what's the weather for this week?" → 7-day daily forecast (uses default location)
- "forecast for Paris" → 7-day daily forecast
- "weather in Tokyo next week" → 7-day forecast
- `/tgweather Paris, France` → current weather
- `/tgweather forecast Rome` → 7-day forecast
- `/tgweather Berlin this week` → 7-day forecast

If you ask "what's the weather?" or "forecast" without a location, the bot
uses your default location (set via `/tgweather-setdefault`). If no default
is set, it asks you for one.

Data comes from [Open-Meteo](https://open-meteo.com) — no API key, no
rate-limit anxiety, no config. If the location is ambiguous, the reply shows
the resolved city/country and the original query.

### Forecast

The 7-day forecast shows each day with:

- Day name + date (e.g. "Wed 17 Jun")
- WMO weather condition (emoji + label)
- High and low temperatures

## Rich formatting

Weather replies are sent as **Telegram Bot API 10.1 Rich Messages**
(`sendRichMessage`) using native headings, paragraphs, and tables. This
means no raw HTML tags in the chat and proper structured rendering on
supported Telegram clients. If the Bot API rejects the rich message, the
bot falls back to a plain-text rendering of the same content.

## How replies are rendered

pi writes Markdown. The extension renders to **Telegram HTML** (the strict
subset: `<b>`, `<i>`, `<u>`, `<s>`, `<code>`, `<pre>`, `<a href>`), chunks
to 4096-char messages, and prepends a draft preview that is deleted when the
final reply is sent.

Assistant-authored inline buttons use a tiny markup language that the
extension parses and removes before sending:

```
click <!-- telegram_button text="Approve" action="app:yes:abc123" --> to continue
```

Renders as: a paragraph "click ... to continue" with one inline button
labelled "Approve" whose `callback_data` is `app:yes:abc123`.

The approval gate is automatic for any non-`read`/`glob`/`grep` tool call
that isn't on the always-allow list. The user sees a Telegram message with
three buttons: Approve / Deny / Always-allow-this-tool.

## File map

```
index.ts                       # Entry point — polling, lifecycle, command dispatch
src/
├── commandBody.ts             # Unified command body dispatcher (tgcmd: callbacks)
├── commands.ts                # Terminal slash-command registration
├── config.ts                  # Keyring + JSON config, token resolution
├── inline.ts                  # Inline keyboards, callback dispatch, approval gate
├── lifecycle.ts               # pi event hooks (agent_end, tool_call, message_update)
├── lock.ts                    # O_EXCL pidfile singleton
├── polling.ts                 # getUpdates loop with exponential backoff
├── queue.ts                   # Turn FIFO with control/prompt lanes
├── render.ts                  # Markdown → Telegram HTML, chunking
├── richMessage.ts             # Telegram Bot API 10.1 Rich HTML builder
├── transport.ts               # api.telegram.org HTTP client
├── turns.ts                   # Telegram Message → pi user message
├── types.ts                   # Shared types
└── weather.ts                 # Open-Meteo weather lookup + geocoding
tests/                         # Node --test suites (9 files)
scripts/
└── setup.sh                   # Interactive setup helper
deploy/
├── pi-telegram.service        # systemd user unit
├── pi-telegram-start.sh       # RPC-mode launch wrapper
└── README.md                  # Deployment instructions
```

## Development

```bash
npm test           # tsx --test --test-force-exit tests/*.test.ts
npm run typecheck  # tsc --noEmit
```

The `--test-force-exit` flag is intentional: the polling loop leaves
long-lived handles, and without it `node --test` hangs. Do not remove it to
"fix" a hang — fix the underlying handle first.

Run both before committing:

```bash
npm run typecheck && npm test
```

## Deployment (systemd)

The bot is designed to run headless under systemd as a user unit. Deployment
artifacts live in `deploy/`:

```bash
cp deploy/pi-telegram.service ~/.config/systemd/user/pi-telegram.service
cp deploy/pi-telegram-start.sh ~/.local/bin/pi-telegram-start.sh
chmod +x ~/.local/bin/pi-telegram-start.sh
systemctl --user daemon-reload
systemctl --user enable --now pi-telegram.service
```

The launch wrapper uses `pi -e index.ts --mode rpc` with stdin kept open.
RPC mode is pi's intended headless-embedding mode — it keeps the session
alive so `pi.sendUserMessage()` works. Plain `pi -e` (print mode) disposes
the session at startup, which stales the extension's captured `pi`.

See `deploy/README.md` for full details.

## What this is not

- Not a remote terminal or PTY. Pi's TUI runs in your terminal; this
  extension only talks to the Telegram Bot API.
- Not a multi-tenant platform. The allowlist is exactly one chat ID.
- Not a voice provider. `<!-- telegram_voice -->` markup is parsed, but v1
  does not generate audio.

## Why not the upstream?

This extension was inspired by upstream
[`llblab/pi-telegram`](https://github.com/llblab/pi-telegram) but rebuilt
from scratch with a different security posture: no `eval`-style template
handlers, no global registries for "companion extensions", no multi-user
pairing flow, no plain-text token storage. The upstream is a ~24k LOC
product for a one-user job. This is the subset we actually need, written so
that every byte is auditable.
