---
title: "pi-telegram — roadmap"
created: 2026-07-29
updated: 2026-07-29
status: active
tags: [pi-telegram, roadmap]
---

# pi-telegram — roadmap

> **Project outcome:** A single-user, security-first Telegram adapter for pi
> that runs headless under systemd and lets the operator drive pi from a
> private DM — streamed replies, inline keyboards, weather, and a hard
> allowlist.

## Scope

- Private Telegram DM as a session-local operator console
- Text, photos, documents, voice notes → pi user messages
- Streamed Markdown → Telegram HTML replies with live draft preview
- Inline keyboards: model picker, thinking level, tool toggles, queue,
  approve/deny for `tool_call` permission gates
- Local weather & 7-day forecast (Open-Meteo, no API key)
- Singleton lock so two pi processes don't both poll the same bot
- systemd supervision + health check

### Non-goals / explicit out-of-scope

- **Not** a remote terminal or PTY (only Bot API messages)
- **Not** multi-tenant (exactly one allowed `chat_id`)
- **Not** a voice provider (`<!-- telegram_voice -->` parsed but no TTS)
- **Not currently** a dynamic-catalog model browser (`ollama-cloud` models
  must be addressed by ID directly; automatic discovery requires explicit
  promotion from the candidate backlog)

## Decision rules (scope-creep defence)

1. **One-user axiom.** Any feature that assumes or enables a second user is
   rejected at the proposal stage. The allowlist is exactly one `chat_id`.
2. **No template engine.** No `child_process.spawn` or eval on update-derived
   content. Client-side button types only; no "hook" or "companion extension"
   registry.
3. **Token never on disk unencrypted.** The bot token lives in the GNOME
   keyring. An env-var override is accepted but never written to disk.
4. **Fail loud on config errors.** A missing token or config file must crash
   startup, not silently degrade.
5. **Existing test suite must pass** before merging any non-trivial change.
   121 tests covering render, queue, transport, command body, inline, polling,
   config, weather, and rich messages.

---

## Completed phases (retrospective)

### Phase 1 — Core scaffolding (commit `41a6c22`)

- Extension entry (`index.ts`), Telegram HTTP client (`src/transport.ts`),
  long-poll loop (`src/polling.ts`), config & keyring (`src/config.ts`),
  types (`src/types.ts`), O_EXCL pidfile lock (`src/lock.ts`)
- Interactive setup script (`scripts/setup.sh`) — token via `secret-tool`,
  chat ID, JSON config at `~/.pi/agent/telegram.json`
- Package manifest, tsconfig, `.gitignore`

### Phase 2 — Lifecycle & streaming

- Lifecycle event hooks (`src/lifecycle.ts`) — reply routing, draft
  streaming, tool-call approval gate
- Markdown→Telegram HTML renderer + 4096-char chunker (`src/render.ts`)
- Turn queue with pending/running/completed states (`src/queue.ts`)
- Telegram message→pi message builder (`src/turns.ts`)
- Terminal `/tg*` command registrations (`src/commands.ts`)

### Phase 3 — Interactive controls

- Inline keyboards (`src/inline.ts`) — model picker, thinking-level picker,
  tool toggles, queue browser, approve/deny/always-allow buttons
- Unified command body (`src/commandBody.ts`) shared between terminal and
  Telegram callback paths; `dispatchTelegramCommand()` / `dispatchTgCmdCallback()`
- Always-allow list persisted to `~/.pi/agent/telegram-approvals.json`
- Stale approval detection: expired nonce handlers render "Approval prompt
  expired" instead of no-op (`b984784`)
- `setMyCommands` menu registration (hyphenated commands excluded; manual
  slash entry still works — `fe1c2f1`)

### Phase 4 — Weather subsystem

- Open-Meteo geocoding + weather + 7-day forecast (`src/weather.ts`)
- Telegram Bot API 10.1 Rich HTML builder (`src/richMessage.ts`) — tables,
  blockquotes, pull-quotes, footers, `sendRichMessage` with plain-text
  fallback (`0912f2f`)
- `/tgweather`, `/tgweather forecast`, `/tgweather-setdefault`,
  `/tgweather-cleargetdefault`
- Plain-English weather interception before LLM round-trip; default-location
  fallback gated on `\bweather\b` (routing regression fixed in `bd2ae81`)
- Forecast qualifiers: day-specific ("this Sunday"), weekend, stacked
  ("for this coming Sunday") (`06ee68b`, `525bbb0`, `5193765`)
- Unambiguous default-location persistence from Telegram (`ac64764`)

### Phase 5 — Production hardening

- Polling decoupled from session lifecycle (`fe1c2f1`): polling starts at
  extension load, NOT in `session_start`; `session_shutdown` no longer stops
  polling — a persistent bot must outlive individual chat sessions
- Systemd user unit (`deploy/pi-telegram.service`, `Restart=always`) with
  RPC-mode launch wrapper (`deploy/pi-telegram-start.sh` — `145f473`)
  — `pi -e index.ts --mode rpc < <(tail -f /dev/null)` keeps the session
  alive under headless systemd (print mode disposes it immediately)
- Health check (`~/.local/bin/pi-telegram-health.sh`) — cron every 5 min:
  checks service active, lock PID alive, session file fresh (<10 min)
- `loginctl enable-linger` so user service survives logouts

### Phase 6 — Maintenance & compatibility

- `AuthStorage` → direct `auth.json` file read for provider discovery
  (`e7949ec`). The upstream class still exists internally but is no longer
  exported from pi's public package entry; `commandBody.ts` now reads provider
  names from `auth.json` using the public `getAgentDir()` API.
- Test isolation: config writes use temp files so concurrent `npm test` runs
  cannot clobber live bot config (`c5185ff`)
- Rich HTML vocabulary fix: Telegram Bot API rejects `<thead>`/`<tbody>`;
  rewritten to flat `<table><caption><tr><th><td>` (`1839de9`)
- README overhaul: security model table, full file map, deployment
  instructions, "what this is not" section (`78c4bda`)
- 121 passing tests (9 files, 1583 LOC of test code)

---

## Phase 7 — Current (forward plan)

**Goal:** Fix the known stale-lock-after-reboot vulnerability, add post-deploy
verification, and establish the maintenance baseline.

### Open checklist

| # | Action | Exit criteria | Owner |
|---|---|---|---|
| 7.1 | **Deploy and verify the compatibility fix already on `main`.** Restart `pi-telegram.service` so commit `e7949ec` is loaded, then test an LLM-bound message and `/tgmodel`. | Journal shows `Polling started`; Telegram receives an LLM reply within 30 seconds; `/tgmodel` lists configured providers without an import error. | |
| 7.2 | **Fix stale-lock-after-reboot (PID reuse).** `src/lock.ts` uses `process.kill(pid, 0)`, which reports a recycled PID as live. Record `/proc/sys/kernel/random/boot_id` alongside the PID and validate both. Add equivalent validation to a tracked health-check script, deploy it to `~/.local/bin/pi-telegram-health.sh`, and add regression tests. (Incident: `Documents/02-incidents/2026-07-28-pi-telegram-stale-lock-after-reboot.md`) | Tests cover a live owner, a dead PID, and a recycled live PID from another boot; a simulated stale lock cannot prevent startup; the deployed health check uses the same identity rule. | |
| 7.3 | **Run post-fix live verification.** After 7.2 is merged and deployed, restart the service and confirm: (a) journal shows `Polling started`, (b) the LLM replies within 30 seconds, (c) `/tgstatus` returns expected state, and (d) the lock owner matches the service MainPID and current boot ID. | Manual checklist passes on the first deployment after the lock fix. | |
| 7.4 | **Document deployment verification.** Add a restart→verify→rollback checklist with journal signatures for successful polling and known lock failures. | `deploy/deploy-checklist.md` exists and is linked from `README.md`. | |

### Candidate backlog (requires explicit promotion to Phase 8)

These items have been surfaced by incidents or code inspection. Promote only
when there is a concrete use-case and capacity:

- **Inline-button N-second timeout revert.** `registerOnceCallback` uses a
  fixed 5-minute auto-expiry (`src/inline.ts`). If approval-timeout UX is
  poor, make it configurable or event-driven. (Source: `inline.ts` timers.)

- **Polling CPU baseline.** The RPC-mode process runs at ~8–10% idle CPU
  (vs ~0.5% in print mode). Acceptable per incident doc, but worth profiling
  if the box is resource-constrained. (Source: incident 2026-06-20, §"What
  this does NOT do".)

- **Automatic reconnect on lock takeover.** If a stale lock is detected after
  the service starts (not just at startup), the health script should
  self-heal without waiting for the next cron tick. (Source: health script
  only checks on the cron cycle.)

- **Session file rotation.** Session `.jsonl` files grow unbounded. Add a
  max-size or max-age cleanup. (Noted in incident 2026-06-18 — file was
  11 hours old, but no rotation existed.)

- **Dynamic-catalog model discovery.** `ollama-cloud` models do not appear in
  the picker and currently require `/tgmodel ollama-cloud/<id>`. Promote only
  if picker discovery can use a stable public pi API. (Source: extension doc
  "What this does NOT do".)

## Update protocol

- Phases 1–6 are frozen — do not reorder or backfill.
- When a Phase-7 item is closed, mark it with a completion date and move it to
  "Closed" below.
- When a backlog item is promoted, create a Phase 8+ section with its own
  checklist and exit criteria.
- After any Phase-7+ change that touches `lock.ts`, `config.ts`, or the health
  script, run the full verification checklist and file the result under
  `Documents/` when the documentation protocol requires it.

### Closed Phase-7 items

*(none yet)*
