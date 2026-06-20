#!/bin/bash
# Launch the pi-telegram bot in RPC mode with stdin kept open.
#
# Why RPC mode: pi detects no TTY under systemd and would otherwise run in
# "print" mode, which creates a session then immediately disposes it
# (session_shutdown). That stales the extension's captured `pi`, so
# pi.sendUserMessage() throws "extension ctx is stale" and no Telegram message
# ever reaches the LLM. RPC mode is pi's intended headless-embedding mode and
# keeps the session alive. RPC mode exits on stdin EOF, so we feed it a
# never-closing stream (tail -f /dev/null) to keep the process alive.
# hasUI is true in RPC mode, so the Telegram tool-approval gate still works.
exec pi -e "$HOME/Projects/pi-telegram/index.ts" --mode rpc < <(tail -f /dev/null)