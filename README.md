# pi-telegram

In-house Telegram runtime adapter for [`pi`](https://github.com/badlogic/pi).

Built for **single-user, security-first** use on a personal machine. We do
not install third-party pi extensions from npm or git; this is the version
we maintain ourselves.

## What it does

Turns a private Telegram DM with a bot you control into a session-local
operator console for pi:

- Receive DMs (text, photos, documents, voice notes) → forward to pi
- Stream pi's reply back as Telegram messages with live draft preview
- Interactive inline keyboards for model picker, queue browser, and
  **approve/deny** on every `tool_call` that needs permission
- Slash commands from Telegram forward to pi's command parser
  (`/compact`, `/new`, `/model`, `/thinking`, `/abort`, `/queue`,
  `/status`, plus the `tg*` family)
- Singleton lock so two pi processes don't both poll the same bot
- File-based and keyring-backed config; bot token **never** in plaintext
- Hard allowlist: only the configured `chat_id` may drive the bot

## Security model

| Concern | Mitigation |
|---|---|
| Bot token in plaintext | Token in GNOME keyring (`secret-tool`); JSON config holds only non-secret state |
| Random DM hijack | Hard allowlist of one `chat_id`; other updates dropped silently at the polling layer |
| Arbitrary command execution from update data | No `child_process.spawn` on any update-derived content. Buttons are typed; the only outbound commands are `deleteMessage` and `sendChatAction` |
| Two pi sessions both polling | `flock(2)` on `~/.pi/agent/telegram.lock` (exclusive, non-blocking) |
| Keyring unavailable | `secret-tool` lookup failure is treated as "no token" → startup fails loud. No silent fallback to plaintext |
| Token leaking to logs | `redactToken()` helper for any string that touches bot config; status output passes through it |

## Install

```bash
# 1. Install keyring CLI (once)
sudo apt install libsecret-tools jq

# 2. Get a bot token from @BotFather
# 3. Get your numeric chat id (DM your bot, then read from getUpdates)

# 4. Run setup (interactive)
cd ~/Projects/pi-telegram
./scripts/setup.sh

# 5. Install dependencies
npm install

# 6. Wire into pi via ~/.pi/agent/settings.json
```

### `settings.json`

```json
{
  "extensions": [
    "/home/christof21/Projects/pi-telegram"
  ]
}
```

For ad-hoc testing:

```bash
pi -e /home/christof21/Projects/pi-telegram/index.ts
```

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
| `/tgweather <location>` | Get current weather + today's high/low via Open-Meteo |
| `/telegram-setup` | One-shot config (token + chat id) |
| `/abort` `/compact` `/new` `/model` `/thinking` `/queue` `/status` | pi core commands (forwarded) |

## Weather

Casual weather queries are intercepted before they reach the LLM:

- "what's the weather in London?"
- "weather in Tokyo"
- "/tgweather Paris, France"

Data comes from [Open-Meteo](https://open-meteo.com) — no API key, no
rate-limit anxiety, no config. If the location is ambiguous, the reply
shows the resolved city/country and the original query.

## How replies are rendered

pi writes Markdown. We render to **Telegram HTML** (the strict subset:
`<b>`, `<i>`, `<u>`, `<s>`, `<code>`, `<pre>`, `<a href>`), chunk to
4096-char messages, and prepend a draft preview that's deleted when the
final reply is sent.

Assistant-authored inline buttons use a tiny markup language that the
extension parses and removes before sending:

```
click <!-- telegram_button text="Approve" action="app:yes:abc123" --> to continue
```

Renders as: a paragraph "click ... to continue" with one inline button
labelled "Approve" whose `callback_data` is `app:yes:abc123`.

The approval gate is automatic for any non-`read`/`glob`/`grep` tool call
that isn't on the always-allow list. The user sees a Telegram message
with three buttons: Approve / Deny / Always-allow-this-tool.

## File map

```
index.ts                       # Entry point
src/
├── config.ts                  # Keyring + JSON config
├── transport.ts               # api.telegram.org HTTP client
├── polling.ts                 # getUpdates loop with backoff
├── lock.ts                    # flock(2) singleton
├── queue.ts                   # Turn FIFO with control/prompt lanes
├── turns.ts                   # Telegram Message → pi user message
├── render.ts                  # Markdown → Telegram HTML, chunking
├── inline.ts                  # Inline keyboards, callback dispatch, approval gate
├── commands.ts                # Slash commands
├── lifecycle.ts               # pi event hooks (agent_end, tool_call, message_update)
├── weather.ts                 # Open-Meteo weather lookup
└── types.ts                   # Shared types
tests/                         # Node --test, 5 suites
scripts/setup.sh               # Interactive setup helper
```

## Tests and daily development

```bash
npm test           # node --experimental-strip-types --test
npm run typecheck  # tsc --noEmit
```

For quick local iteration, run everything before committing:

```bash
npm run typecheck && npm test
```

Then push:

```bash
git add .
git commit -m "<what changed>"
git push origin main
```

The repository is at `https://github.com/theglove44/pi-telegram`.

## What this is *not*

- Not a remote terminal or PTY. Pi's TUI runs in your terminal; this
  extension only talks to the Telegram Bot API.
- Not a multi-tenant platform. The allowlist is exactly one chat id.
- Not a voice provider. `<!-- telegram_voice -->` markup is parsed, but
  v1 does not generate audio. Future work.

## Why not install the upstream?

This extension was inspired by the architecture of upstream
[`llblab/pi-telegram`](https://github.com/llblab/pi-telegram), but we
rebuilt it from scratch with a different security posture: no `eval`-style
template handlers, no global registries for "companion extensions", no
multi-user pairing flow, no plain-text token storage. The upstream is a
~24k LOC product for a one-user job. This is the ~2k LOC subset we
actually need, written so that every byte is auditable.
