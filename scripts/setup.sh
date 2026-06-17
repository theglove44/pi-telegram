#!/usr/bin/env bash
# pi-telegram setup helper.
#
# Usage:
#   ./scripts/setup.sh
#
# Interactive: asks for the bot token, asks for your numeric chat id,
# stores the token in the GNOME keyring, writes the public config to
# ~/.pi/agent/telegram.json (mode 0o600).
#
# Idempotent: re-running lets you rotate the token.

set -euo pipefail

PI_AGENT_DIR="${PI_AGENT_DIR:-$HOME/.pi/agent}"
CONFIG_FILE="$PI_AGENT_DIR/telegram.json"
KEYRING_SERVICE="pi-telegram"
KEYRING_ACCOUNT="bot-token"

mkdir -p "$PI_AGENT_DIR"
chmod 700 "$PI_AGENT_DIR"

if ! command -v secret-tool >/dev/null 2>&1; then
    echo "secret-tool not found. Install it first:" >&2
    echo "  sudo apt install libsecret-tools" >&2
    exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
    echo "jq not found. Install it first:" >&2
    echo "  sudo apt install jq" >&2
    exit 1
fi

echo "Step 1: get a bot token"
echo "  Open @BotFather in Telegram, run /newbot, copy the token."
echo
read -r -s -p "Bot token: " BOT_TOKEN
echo
if [[ -z "$BOT_TOKEN" ]]; then
    echo "no token; aborting" >&2
    exit 1
fi

# Validate the token against the Telegram API.
ME_JSON=$(curl -fsS --max-time 15 "https://api.telegram.org/bot${BOT_TOKEN}/getMe")
if ! echo "$ME_JSON" | jq -e '.ok == true' >/dev/null; then
    echo "token validation failed:" >&2
    echo "$ME_JSON" | jq . >&2
    exit 1
fi
BOT_USERNAME=$(echo "$ME_JSON" | jq -r '.result.username')
BOT_ID=$(echo "$ME_JSON" | jq -r '.result.id')
echo "  ✓ token valid; bot @${BOT_USERNAME} (id ${BOT_ID})"

# Store in the keyring. secret-tool reads the secret on stdin.
echo -n "$BOT_TOKEN" | secret-tool store --label="pi-telegram bot token" \
    "service=${KEYRING_SERVICE}" "account=${KEYRING_ACCOUNT}" >/dev/null
echo "  ✓ token stored in GNOME keyring (service=${KEYRING_SERVICE}, account=${KEYRING_ACCOUNT})"

echo
echo "Step 2: get your numeric chat id"
echo "  Send /start to @${BOT_USERNAME}, then read your id from"
echo "  https://api.telegram.org/bot${BOT_TOKEN}/getUpdates"
echo "  (look for message.chat.id — for a private DM it's a positive integer)."
echo
read -r -p "Your numeric chat id: " CHAT_ID
if ! [[ "$CHAT_ID" =~ ^[0-9]+$ ]] || [[ "$CHAT_ID" -le 0 ]]; then
    echo "invalid chat id: $CHAT_ID" >&2
    exit 1
fi

# Write the public config atomically.
TMP=$(mktemp "$PI_AGENT_DIR/.telegram.json.XXXXXX")
chmod 600 "$TMP"
jq -n \
    --argjson chatId "$CHAT_ID" \
    --arg username "$BOT_USERNAME" \
    --argjson botId "$BOT_ID" \
    '{
        allowedChatId: $chatId,
        botUsername: $username,
        botId: $botId,
        lastUpdateId: 0
    }' >"$TMP"
mv -f "$TMP" "$CONFIG_FILE"
chmod 600 "$CONFIG_FILE"
echo "  ✓ wrote $CONFIG_FILE (mode 0600)"

echo
echo "Setup complete. To use pi-telegram:"
echo "  pi -e /home/christof21/Projects/pi-telegram/index.ts"
echo
echo "Or add to ~/.pi/agent/settings.json extensions list:"
echo "  \"/home/christof21/Projects/pi-telegram\""
