# pi-telegram

In-house Telegram adapter for pi. Runs as a headless persistent bot supervised by systemd. Source: `~/Projects/pi-telegram/`. Extension docs: `~/Documents/06-pi-agents/pi-telegram-extension.md`.

## Commands

- `npm test` — runs `tsx --test --test-force-exit tests/*.test.ts`. The `--test-force-exit` is **intentional** (Lesson #2): the polling loop leaves long-lived handles; without it `node --test` hangs. Do not remove it to "fix" a hang — fix the underlying handle first.
- `npm run typecheck` — `tsc --noEmit`.

## Hard rules (see the `pi-extension-dev` skill for full incident detail)

1. **RPC mode, not print mode.** The bot launches via `~/.local/bin/pi-telegram-start.sh` as `pi -e index.ts --mode rpc < <(tail -f /dev/null)`. Plain `pi -e` (print mode) disposes the session and stales the captured `pi` within seconds (Lesson #5). Never "simplify" the launch to drop `--mode rpc` or the stdin feed.
2. **Polling owns its own lifetime.** Start polling once at extension load. Do NOT abort it on `session_shutdown` (Lesson #4) — under systemd, `session_start` fires then `session_shutdown` fires immediately, which would kill the bot ~6 s after start. `session_start` only refreshes per-session snapshots (e.g. the model registry).
3. **Yield in tight loops.** Any `while (!signal.aborted)` path that can resolve synchronously must `await sleep(0)` or it spins at 100% CPU and starves macrotasks (Lesson #1).
4. **Supervised + health-checked.** Runs under `~/.config/systemd/user/pi-telegram.service` (`Restart=always`). If the session log hasn't been written for >10 min, the process is wedged — restart it (Lesson #3).
5. **Approval buttons must match server state.** Stale nonce handlers must render "Approval prompt expired", not no-op silently (Lesson #3).

## Where things live

- Extension entry: `index.ts`; modules in `src/`; tests in `tests/`.
- Launch wrapper: `~/.local/bin/pi-telegram-start.sh`.
- Health check / restart wrapper: `~/.local/bin/pi-telegram-health.sh`.
- systemd unit: `~/.config/systemd/user/pi-telegram.service`.
- Public config: `~/.pi/agent/telegram.json`; approvals: `~/.pi/agent/telegram-approvals.json`.

## Verify after changes

```bash
npm test
npm run typecheck
# Headless restart check (the path that actually matters):
systemctl --user restart pi-telegram.service && sleep 12 && systemctl --user is-active pi-telegram.service
# Confirm polling stayed up — startup log should show session_start → "Polling started" with NO session_shutdown in between:
journalctl --user -u pi-telegram.service -n 30 --no-pager
```