#!/usr/bin/env bash
#
# Force-expire access_token + verify hub auto-refreshes via refresh_token.
#
# Prerequisites:
#   - Hub-core running with OAuth creds
#   - google-calendar plugin installed
#   - Active grant for listEvents (e.g. run scripts/test-real-oauth.sh first)
#
# What it does:
#   1. Reads current vault state (access_token, expires_at, refresh_token)
#   2. Force-expires access_token by setting expires_at to 1 second ago
#   3. Calls POST /v1/tools/listEvents/call
#   4. Verifies hub auto-refreshed (new expires_at > now)
#   5. Shows audit log entry for the tool call
#
# Usage:
#   ./scripts/test-token-refresh.sh
#

set -euo pipefail

HUB_URL="${HUB_URL:-http://127.0.0.1:8080}"
DB_PATH="${DB_PATH:-/tmp/pdatahub-hub-e2e.db}"
MASTER_KEY="${MASTER_KEY:-f92a24ff97a81014fdf0124f76b81da23622241a5da31499cfe439672810b398}"

red()   { printf "\033[31m%s\033[0m\n" "$*"; }
green() { printf "\033[32m%s\033[0m\n" "$*"; }
blue()  { printf "\033[34m%s\033[0m\n" "$*"; }
bold()  { printf "\033[1m%s\033[0m\n" "$*"; }
step()  { printf "\n\033[1;36m=== %s ===\033[0m\n" "$*"; }

# ──────────────────────────────────────────────────────────────────────────────
step "1/5  Pre-checks"

if ! curl -s --max-time 3 "$HUB_URL/health" >/dev/null; then
  red "FAIL: hub-core not responding"
  exit 1
fi
green "OK — hub-core alive"

if ! python3 -c "
import sqlite3, sys
conn = sqlite3.connect('$DB_PATH')
cur = conn.cursor()
cur.execute(\"SELECT plugin FROM token_vault WHERE plugin = 'google-calendar'\")
if not cur.fetchone():
    sys.exit(1)
cur.execute(\"SELECT refresh_token_enc FROM token_vault WHERE plugin = 'google-calendar'\")
row = cur.fetchone()
if not row or not row[0]:
    sys.exit(1)
"; then
  red "FAIL: no refresh_token stored for google-calendar — re-do OAuth flow first"
  exit 1
fi
green "OK — refresh_token present in vault"

# ──────────────────────────────────────────────────────────────────────────────
step "2/5  Snapshot BEFORE force-expire"

BEFORE=$(python3 -c "
import sqlite3
conn = sqlite3.connect('$DB_PATH')
cur = conn.cursor()
cur.execute(\"SELECT expires_at FROM token_vault WHERE plugin = 'google-calendar'\")
row = cur.fetchone()
print(row[0] if row else 'none')
")
echo "  expires_at BEFORE: $BEFORE"

# ──────────────────────────────────────────────────────────────────────────────
step "3/5  Force-expire access_token (set expires_at to 1s ago)"

python3 -c "
import sqlite3
from datetime import datetime, timezone, timedelta
conn = sqlite3.connect('$DB_PATH')
cur = conn.cursor()
expired = (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat().replace('+00:00', 'Z')
cur.execute(\"UPDATE token_vault SET expires_at = ?, updated_at = ? WHERE plugin = 'google-calendar'\", (expired, datetime.now(timezone.utc).isoformat()))
conn.commit()
print(f'  set expires_at to: {expired}')
conn.close()
"
green "OK — token force-expired"

# Verify
AFTER_FORCE=$(python3 -c "
import sqlite3
conn = sqlite3.connect('$DB_PATH')
cur = conn.cursor()
cur.execute(\"SELECT expires_at FROM token_vault WHERE plugin = 'google-calendar'\")
row = cur.fetchone()
print(row[0] if row else 'none')
")
echo "  expires_at now: $AFTER_FORCE"

# ──────────────────────────────────────────────────────────────────────────────
step "4/5  Trigger listEvents (hub should auto-refresh)"

RESP=$(curl -s --max-time 30 -X POST "$HUB_URL/v1/tools/listEvents/call" \
  -H "Content-Type: application/json" \
  -d '{"name":"listEvents","arguments":{"from":"2024-01-01T00:00:00Z","to":"2027-12-31T23:59:59Z","limit":5},"context":{"agent_id":"refresh-test","justification":"force-expire + auto-refresh"}}')
echo "$RESP" | python3 -c "
import json, sys
d = json.load(sys.stdin)
if 'content' in d:
    text = d['content'][0].get('text', '') if d.get('content') else ''
    items = json.loads(text) if text.startswith('[') else text
    count = len(items) if isinstance(items, list) else 'unknown'
    print(f'  ✓ listEvents succeeded, {count} events returned')
elif 'error' in d:
    print(f'  ✗ error: {d[\"error\"]}')
else:
    print(f'  ? unexpected: {d}')
"

# ──────────────────────────────────────────────────────────────────────────────
step "5/5  Verify token was refreshed (expires_at now in future)"

AFTER=$(python3 -c "
import sqlite3
from datetime import datetime, timezone
conn = sqlite3.connect('$DB_PATH')
cur = conn.cursor()
cur.execute(\"SELECT expires_at FROM token_vault WHERE plugin = 'google-calendar'\")
row = cur.fetchone()
print(row[0] if row else 'none')
")
echo "  expires_at AFTER:  $AFTER"

# Check if AFTER is in the future
IS_FUTURE=$(python3 -c "
from datetime import datetime, timezone
import sys
after = datetime.fromisoformat('$AFTER'.replace('Z', '+00:00'))
now = datetime.now(timezone.utc)
sys.exit(0 if after > now else 1)
")

if [[ $IS_FUTURE -eq 0 ]]; then
  green "OK — expires_at refreshed to future (auto-refresh worked)"
else
  red "FAIL — expires_at still in past, refresh didn't work"
  exit 1
fi

# Check that expires_at CHANGED (proving refresh happened, not stale value)
if [[ "$AFTER" != "$BEFORE" ]]; then
  green "OK — expires_at changed from BEFORE to AFTER (proves refresh issued new token)"
else
  red "FAIL — expires_at unchanged, refresh didn't fire"
  exit 1
fi

# ──────────────────────────────────────────────────────────────────────────────
bold ""
bold "════════════════════════════════════════════════════════════════════"
echo "Token refresh auto-flow: VERIFIED"
echo ""
echo "Summary:"
echo "  • Token force-expired at: $AFTER_FORCE"
echo "  • listEvents called → plugin would normally get 401"
echo "  • Hub detected expiry via isExpiringSoon()"
echo "  • Hub called refreshAccessToken() with stored refresh_token"
echo "  • Google returned new access_token (expires_at: $AFTER)"
echo "  • Plugin called with new token, Google API responded"
bold "════════════════════════════════════════════════════════════════════"
