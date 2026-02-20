#!/bin/bash
set -euo pipefail

# 04-configure-matrix.sh — Validate Matrix credentials from .env

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
LOG_FILE="$PROJECT_ROOT/logs/setup.log"

mkdir -p "$PROJECT_ROOT/logs"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [configure-matrix] $*" >> "$LOG_FILE"; }

cd "$PROJECT_ROOT"

log "Starting Matrix configuration check"

ENV_FILE="$PROJECT_ROOT/.env"

# Read Matrix config from .env
MATRIX_HOMESERVER_URL=""
MATRIX_ACCESS_TOKEN=""
MATRIX_BOT_USER_ID=""

if [ -f "$ENV_FILE" ]; then
  MATRIX_HOMESERVER_URL=$(grep -E "^MATRIX_HOMESERVER_URL=" "$ENV_FILE" | cut -d= -f2- | tr -d '"' | tr -d "'" || true)
  MATRIX_ACCESS_TOKEN=$(grep -E "^MATRIX_ACCESS_TOKEN=" "$ENV_FILE" | cut -d= -f2- | tr -d '"' | tr -d "'" || true)
  MATRIX_BOT_USER_ID=$(grep -E "^MATRIX_BOT_USER_ID=" "$ENV_FILE" | cut -d= -f2- | tr -d '"' | tr -d "'" || true)
fi

# Check all three are present
if [ -z "$MATRIX_HOMESERVER_URL" ] || [ -z "$MATRIX_ACCESS_TOKEN" ] || [ -z "$MATRIX_BOT_USER_ID" ]; then
  log "Matrix config incomplete: homeserver=${MATRIX_HOMESERVER_URL:-(empty)} token=${MATRIX_ACCESS_TOKEN:+set} user=${MATRIX_BOT_USER_ID:-(empty)}"
  cat <<EOF
=== NANOCLAW SETUP: CONFIGURE_MATRIX ===
MATRIX_CONFIG: missing
STATUS: failed
ERROR: incomplete_config
LOG: logs/setup.log
=== END ===
EOF
  exit 1
fi

log "Matrix config found, testing connection to $MATRIX_HOMESERVER_URL"

# Test connection by calling the whoami endpoint
WHOAMI_RESPONSE=$(curl -sf -H "Authorization: Bearer $MATRIX_ACCESS_TOKEN" \
  "${MATRIX_HOMESERVER_URL}/_matrix/client/v3/account/whoami" 2>&1) || {
  log "Matrix whoami request failed: $WHOAMI_RESPONSE"
  cat <<EOF
=== NANOCLAW SETUP: CONFIGURE_MATRIX ===
MATRIX_CONFIG: invalid
STATUS: failed
ERROR: whoami_failed
LOG: logs/setup.log
=== END ===
EOF
  exit 1
}

# Extract user_id from response
WHOAMI_USER=$(echo "$WHOAMI_RESPONSE" | node -e "
  let data = '';
  process.stdin.on('data', c => data += c);
  process.stdin.on('end', () => {
    try { console.log(JSON.parse(data).user_id); }
    catch { process.exit(1); }
  });
" 2>/dev/null) || WHOAMI_USER=""

log "Whoami response user: $WHOAMI_USER (expected: $MATRIX_BOT_USER_ID)"

if [ "$WHOAMI_USER" != "$MATRIX_BOT_USER_ID" ]; then
  log "WARNING: whoami user_id ($WHOAMI_USER) does not match MATRIX_BOT_USER_ID ($MATRIX_BOT_USER_ID)"
fi

cat <<EOF
=== NANOCLAW SETUP: CONFIGURE_MATRIX ===
MATRIX_CONFIG: valid
HOMESERVER: $MATRIX_HOMESERVER_URL
BOT_USER: $WHOAMI_USER
STATUS: success
LOG: logs/setup.log
=== END ===
EOF
