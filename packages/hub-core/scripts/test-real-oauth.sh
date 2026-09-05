#!/usr/bin/env bash
#
# Smoke test for real Google Calendar OAuth flow.
#
# Prerequisites:
#   1. OAuth client created in Google Cloud Console:
#      - Type: Web application
#      - Authorized redirect URI: http://127.0.0.1:8081/callback
#      - Calendar API enabled
#      - Your Google account added as test user (if in Testing mode)
#
#   2. Hub-core running with OAuth credentials in env:
#      HUB_CLIENT_GOOGLE_CALENDAR_ID=<your-client-id>
#      HUB_CLIENT_GOOGLE_CALENDAR_SECRET=<your-client-secret>
#      AND started with --oauth-callback-port 8081
#
# Usage:
#   ./scripts/test-real-oauth.sh
#
# What it does:
#   1. Verifies hub-core is running and creds are loaded
#   2. Installs google-calendar plugin
#   3. Triggers OAuth flow, displays authorization_url
#   4. Prompts user to open URL in browser and approve
#   5. Polls /v1/tokens until google-calendar token appears (90s timeout)
#   6. Verifies token metadata (no secret leak)
#   7. Checks audit log for OAuth-related entries
#

set -euo pipefail

HUB_URL="${HUB_URL:-http://127.0.0.1:8080}"
PLUGIN_PATH="${PLUGIN_PATH:-/home/vladimirmyshkovski/Programs/AI/pdatahub-plugin-google-calendar/dist/index.js}"
POLL_INTERVAL="${POLL_INTERVAL:-2}"
POLL_TIMEOUT="${POLL_TIMEOUT:-90}"

red()   { printf "\033[31m%s\033[0m\n" "$*"; }
green() { printf "\033[32m%s\033[0m\n" "$*"; }
blue()  { printf "\033[34m%s\033[0m\n" "$*"; }
bold()  { printf "\033[1m%s\033[0m\n" "$*"; }

step() { printf "\n\033[1;36m=== %s ===\033[0m\n" "$*"; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    red "missing required command: $1"
    exit 1
  }
}

json_get() {
  python3 -c "import json,sys; print(json.loads(sys.stdin.read())$1)" 2>/dev/null
}

require_cmd curl
require_cmd python3

# ──────────────────────────────────────────────────────────────────────────────
step "1/6  Hub-core alive?"

if ! HEALTH=$(curl -s --max-time 3 "$HUB_URL/health"); then
  red "FAIL: hub-core not responding at $HUB_URL"
  echo "  Start it: see CONTEXT.md 'Restart hub-core after reboot' section"
  exit 1
fi
green "OK — $(echo "$HEALTH" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["status"])')"

# ──────────────────────────────────────────────────────────────────────────────
step "2/6  OAuth credentials loaded by hub-core?"

# Check that the running hub-core process has the env vars
HUB_PID=$(pgrep -f "node.*hub-core.*dist/index.js" | head -1)
if [[ -z "$HUB_PID" ]]; then
  red "FAIL: no hub-core process found"
  exit 1
fi
ENV_ID=$(tr '\0' '\n' </proc/$HUB_PID/environ 2>/dev/null | grep '^HUB_CLIENT_GOOGLE_CALENDAR_ID=' | cut -d= -f2-)
ENV_SECRET=$(tr '\0' '\n' </proc/$HUB_PID/environ 2>/dev/null | grep '^HUB_CLIENT_GOOGLE_CALENDAR_SECRET=' | cut -d= -f2-)

if [[ -z "$ENV_ID" ]] || [[ -z "$ENV_SECRET" ]]; then
  red "FAIL: HUB_CLIENT_GOOGLE_CALENDAR_ID and/or HUB_CLIENT_GOOGLE_CALENDAR_SECRET not set in hub-core env"
  echo "  Restart hub-core with these vars before running this script."
  exit 1
fi
green "OK — client_id: ${ENV_ID:0:20}... secret: ${ENV_SECRET:0:4}***"

# ──────────────────────────────────────────────────────────────────────────────
step "3/6  Install google-calendar plugin (idempotent)"

INSTALL_RESP=$(curl -s -X POST "$HUB_URL/v1/plugins/install" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"google-calendar\",\"entry_path\":\"$PLUGIN_PATH\"}")
if echo "$INSTALL_RESP" | python3 -c 'import json,sys; sys.exit(0 if "google-calendar" in sys.stdin.read() else 1)'; then
  green "OK — plugin ready"
else
  red "FAIL: install response: $INSTALL_RESP"
  exit 1
fi

# ──────────────────────────────────────────────────────────────────────────────
step "4/6  Trigger OAuth flow"

AUTH_RESP=$(curl -s --max-time 5 -X POST "$HUB_URL/v1/plugins/google-calendar/authenticate")
AUTH_URL=$(echo "$AUTH_RESP" | json_get '["authorization_url"]')
STATE=$(echo "$AUTH_RESP" | json_get '["state"]')
PORT=$(echo "$AUTH_RESP" | json_get '["callback_port"]')

if [[ -z "$AUTH_URL" ]] || [[ "$AUTH_URL" == "None" ]]; then
  red "FAIL: no authorization_url in response"
  echo "  $AUTH_RESP"
  exit 1
fi

bold ""
bold "════════════════════════════════════════════════════════════════════"
bold "  OPEN THIS URL IN YOUR BROWSER:"
bold "  $AUTH_URL"
bold ""
bold "  Then:"
bold "    1. Log in to your Google account"
bold "    2. Approve the calendar.readonly + calendar.events scopes"
bold "    3. Google redirects to http://127.0.0.1:$PORT/callback"
bold "       (Hub-core on your laptop catches this — token stored automatically)"
bold "  This script will detect the token in ${POLL_TIMEOUT}s."
bold "════════════════════════════════════════════════════════════════════"
echo ""

# ──────────────────────────────────────────────────────────────────────────────
step "5/6  Waiting for token to appear in vault..."

elapsed=0
while (( elapsed < POLL_TIMEOUT )); do
  TOKENS=$(curl -s "$HUB_URL/v1/tokens")
  if echo "$TOKENS" | python3 -c 'import json,sys; d=json.load(sys.stdin); sys.exit(0 if any(t["plugin"]=="google-calendar" for t in d.get("tokens",[])) else 1)'; then
    green "OK — token stored after ${elapsed}s"
    break
  fi
  printf "  [%3ds] no token yet, polling...\n" "$elapsed"
  sleep "$POLL_INTERVAL"
  elapsed=$(( elapsed + POLL_INTERVAL ))
done

if (( elapsed >= POLL_TIMEOUT )); then
  red "FAIL: timeout after ${POLL_TIMEOUT}s — token never appeared"
  echo "  Possible causes:"
  echo "    - You didn't approve in browser"
  echo "    - Browser redirect failed (port 8081 not reachable from browser → laptop)"
  echo "    - Hub-core rejected the token exchange (check /tmp/hub-core.log)"
  exit 1
fi

# Verify token metadata (no secret leak)
TOKEN_INFO=$(curl -s "$HUB_URL/v1/tokens" | python3 -c '
import json, sys
d = json.load(sys.stdin)
for t in d["tokens"]:
  if t["plugin"] == "google-calendar":
    print(f"plugin={t[\"plugin\"]} scope={t[\"scope\"][:60]}... expires_at={t[\"expires_at\"]}")
    break
')
echo "  $TOKEN_INFO"

if echo "$TOKEN_INFO" | grep -q "access_token"; then
  red "FAIL: /v1/tokens response LEAKS access_token — security bug!"
  exit 1
fi
green "OK — token metadata correct, no secret leak in /v1/tokens"

# ──────────────────────────────────────────────────────────────────────────────
step "6/6  Check audit log for OAuth-related entries"

AUDIT=$(curl -s "$HUB_URL/v1/audit?limit=5")
ENTRY_COUNT=$(echo "$AUDIT" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["entries"]))')
green "OK — audit log has $ENTRY_COUNT recent entries"
echo ""
echo "Recent audit entries:"
echo "$AUDIT" | python3 -c '
import json, sys
d = json.load(sys.stdin)
for e in d["entries"][:5]:
  err = f" err={e[\"error\"]}" if e.get("error") else ""
  print(f"  {e[\"decision\"]:8s} {e[\"tool_name\"]:30s} agent={e[\"agent_id\"]}{err}")
'

bold ""
bold "════════════════════════════════════════════════════════════════════"
green "OAuth flow COMPLETE. Token stored in encrypted vault."
echo ""
echo "Next steps (manual, requires phone approval):"
echo "  1. Open Honor CMA-LX1 → pdatahub app"
echo "  2. Trigger listEvents from this laptop:"
echo "     curl -s -X POST $HUB_URL/v1/tools/listEvents/call \\"
echo "       -H 'Content-Type: application/json' \\"
echo "       -d '{\"name\":\"listEvents\",\"arguments\":{\"from\":\"2026-09-01T00:00:00Z\",\"to\":\"2026-09-30T23:59:59Z\",\"limit\":3},\"context\":{\"agent_id\":\"smoke-test\",\"justification\":\"verify real data\"}}'"
echo "  3. Approve in pdatahub app on phone (biometric or direct tap)"
echo "  4. Real Google Calendar events should appear"
bold "════════════════════════════════════════════════════════════════════"
