#!/bin/bash
set -euo pipefail

# 05-sync-rooms.sh — Connect to Matrix, fetch joined rooms, write to DB, exit.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
LOG_FILE="$PROJECT_ROOT/logs/setup.log"

mkdir -p "$PROJECT_ROOT/logs"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [sync-rooms] $*" >> "$LOG_FILE"; }

cd "$PROJECT_ROOT"

# Build TypeScript
log "Building TypeScript"
BUILD="failed"
if npm run build >> "$LOG_FILE" 2>&1; then
  BUILD="success"
  log "Build succeeded"
else
  log "Build failed"
  cat <<EOF
=== NANOCLAW SETUP: SYNC_ROOMS ===
BUILD: failed
SYNC: skipped
ROOMS_IN_DB: 0
STATUS: failed
ERROR: build_failed
LOG: logs/setup.log
=== END ===
EOF
  exit 1
fi

# Read Matrix config from .env
ENV_FILE="$PROJECT_ROOT/.env"
MATRIX_HOMESERVER_URL=""
MATRIX_ACCESS_TOKEN=""
MATRIX_BOT_USER_ID=""

if [ -f "$ENV_FILE" ]; then
  MATRIX_HOMESERVER_URL=$(grep -E "^MATRIX_HOMESERVER_URL=" "$ENV_FILE" | cut -d= -f2- | tr -d '"' | tr -d "'" || true)
  MATRIX_ACCESS_TOKEN=$(grep -E "^MATRIX_ACCESS_TOKEN=" "$ENV_FILE" | cut -d= -f2- | tr -d '"' | tr -d "'" || true)
  MATRIX_BOT_USER_ID=$(grep -E "^MATRIX_BOT_USER_ID=" "$ENV_FILE" | cut -d= -f2- | tr -d '"' | tr -d "'" || true)
fi

export MATRIX_HOMESERVER_URL MATRIX_ACCESS_TOKEN MATRIX_BOT_USER_ID

if [ -z "$MATRIX_HOMESERVER_URL" ] || [ -z "$MATRIX_ACCESS_TOKEN" ] || [ -z "$MATRIX_BOT_USER_ID" ]; then
  log "Matrix config incomplete"
  cat <<EOF
=== NANOCLAW SETUP: SYNC_ROOMS ===
BUILD: $BUILD
SYNC: failed
ROOMS_IN_DB: 0
STATUS: failed
ERROR: missing_matrix_config
LOG: logs/setup.log
=== END ===
EOF
  exit 1
fi

# Connect to Matrix, fetch rooms, write to DB, exit
log "Fetching room metadata from Matrix"
SYNC="failed"

SYNC_OUTPUT=$(node -e "
import { createClient, ClientEvent } from 'matrix-js-sdk';
import path from 'path';
import Database from 'better-sqlite3';

const homeserverUrl = process.env.MATRIX_HOMESERVER_URL;
const accessToken = process.env.MATRIX_ACCESS_TOKEN;
const userId = process.env.MATRIX_BOT_USER_ID;

const dbPath = path.join('store', 'messages.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.exec('CREATE TABLE IF NOT EXISTS chats (jid TEXT PRIMARY KEY, name TEXT, last_message_time TEXT)');

const upsert = db.prepare(
  'INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?) ON CONFLICT(jid) DO UPDATE SET name = excluded.name'
);

const client = createClient({
  baseUrl: homeserverUrl,
  accessToken: accessToken,
  userId: userId,
});

// Timeout after 30s
const timeout = setTimeout(() => {
  console.error('TIMEOUT');
  client.stopClient();
  db.close();
  process.exit(1);
}, 30000);

client.on(ClientEvent.Sync, (state) => {
  if (state === 'PREPARED' || state === 'SYNCING') {
    try {
      const rooms = client.getRooms();
      const now = new Date().toISOString();
      let count = 0;
      for (const room of rooms) {
        const name = room.name || room.roomId;
        upsert.run(room.roomId, name, now);
        count++;
      }
      console.log('SYNCED:' + count);
    } catch (err) {
      console.error('FETCH_ERROR:' + err.message);
    } finally {
      clearTimeout(timeout);
      client.stopClient();
      db.close();
      process.exit(0);
    }
  } else if (state === 'ERROR') {
    clearTimeout(timeout);
    console.error('SYNC_ERROR');
    client.stopClient();
    db.close();
    process.exit(1);
  }
});

client.startClient({ initialSyncLimit: 0 });
" --input-type=module 2>&1) || true

log "Sync output: $SYNC_OUTPUT"

if echo "$SYNC_OUTPUT" | grep -q "SYNCED:"; then
  SYNC="success"
fi

# Check for rooms in DB
ROOMS_IN_DB=0
if [ -f "$PROJECT_ROOT/store/messages.db" ]; then
  ROOMS_IN_DB=$(sqlite3 "$PROJECT_ROOT/store/messages.db" "SELECT COUNT(*) FROM chats WHERE jid LIKE '!%' AND jid <> '__group_sync__'" 2>/dev/null || echo "0")
  log "Rooms found in DB: $ROOMS_IN_DB"
fi

STATUS="success"
if [ "$SYNC" != "success" ]; then
  STATUS="failed"
fi

cat <<EOF
=== NANOCLAW SETUP: SYNC_ROOMS ===
BUILD: $BUILD
SYNC: $SYNC
ROOMS_IN_DB: $ROOMS_IN_DB
STATUS: $STATUS
LOG: logs/setup.log
=== END ===
EOF

if [ "$STATUS" = "failed" ]; then
  exit 1
fi
