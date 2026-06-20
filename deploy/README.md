# Deployment artifacts

The live copies live outside the repo (system user unit + wrapper). These
mirrors are kept in version control for reproducibility.

| File | Install target |
| ---- | -------------- |
| `pi-telegram.service` | `~/.config/systemd/user/pi-telegram.service` |
| `pi-telegram-start.sh` | `~/.local/bin/pi-telegram-start.sh` (chmod +x) |

## Why RPC mode

`pi -e index.ts` (the default, print mode) disposes the session at headless
startup, which stales the extension's captured `pi` so `pi.sendUserMessage()`
throws. RPC mode keeps the session alive and sets `hasUI=true` (so the
Telegram tool-approval gate still works). RPC mode exits on stdin EOF, so the
wrapper feeds it a never-closing stream (`tail -f /dev/null`).

See `~/Documents/02-incidents/2026-06-20-pi-telegram-stale-ctx-headless.md`
and `AGENTS.md` Lesson #5.

## Install

```sh
cp deploy/pi-telegram.service ~/.config/systemd/user/pi-telegram.service
cp deploy/pi-telegram-start.sh ~/.local/bin/pi-telegram-start.sh
chmod +x ~/.local/bin/pi-telegram-start.sh
systemctl --user daemon-reload
systemctl --user enable --now pi-telegram.service
```

> Note: the committed `pi-telegram.service` uses `$HOME`; systemd expands
> `%h` to the home directory, so the live copy uses `%h` in
> `WorkingDirectory`/`ExecStart`. Either form works when installed.