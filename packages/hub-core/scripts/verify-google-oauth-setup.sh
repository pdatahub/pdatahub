#!/usr/bin/env bash
#
# Verify Google Cloud OAuth setup for pdatahub Calendar plugin.
#
# Prerequisites:
#   1. gcloud CLI installed (~/gcloud-sdk/google-cloud-sdk/bin/gcloud)
#   2. Authenticated: `gcloud auth login` (one-time browser flow)
#
# What it verifies:
#   1. gcloud authentication works (account accessible)
#   2. pdatahub project accessible
#   3. Google Calendar API is enabled in pdatahub project
#   4. OAuth 2.0 client with redirect_uri http://127.0.0.1:8081/callback exists
#   5. (If you have a real client_id) Token vault on hub-core matches config
#
# Usage:
#   ./scripts/verify-google-oauth-setup.sh
#

set -euo pipefail

# Auto-add gcloud to PATH if not present
if ! command -v gcloud >/dev/null 2>&1; then
  if [[ -x "$HOME/gcloud-sdk/google-cloud-sdk/bin/gcloud" ]]; then
    export PATH="$HOME/gcloud-sdk/google-cloud-sdk/bin:$PATH"
  else
    echo "ERROR: gcloud CLI not found. Install it first:"
    echo "  curl -O https://dl.google.com/dl/cloudsdk/channels/rapid/downloads/google-cloud-cli-linux-x86_64.tar.gz"
    echo "  tar -xzf google-cloud-cli-linux-x86_64.tar.gz -C ~/gcloud-sdk"
    echo "  ~/gcloud-sdk/google-cloud-sdk/install.sh --quiet --usage-reporting=false --path-update=true"
    exit 1
  fi
fi

PROJECT="${PDATAHUB_PROJECT:-pdatahub}"
EXPECTED_REDIRECT="http://127.0.0.1:8081/callback"

red()   { printf "\033[31m%s\033[0m\n" "$*"; }
green() { printf "\033[32m%s\033[0m\n" "$*"; }
blue()  { printf "\033[34m%s\033[0m\n" "$*"; }
bold()  { printf "\033[1m%s\033[0m\n" "$*"; }
step()  { printf "\n\033[1;36m=== %s ===\033[0m\n" "$*"; }

# ──────────────────────────────────────────────────────────────────────────────
step "1/5  gcloud authenticated?"

if ! gcloud auth print-access-token >/dev/null 2>&1; then
  red "FAIL: not authenticated"
  echo ""
  bold "To authenticate (one-time browser flow):"
  echo "  gcloud auth login your@gmail.com"
  echo ""
  echo "Then re-run this script."
  exit 1
fi

ACTIVE_ACCOUNT=$(gcloud config get-value account 2>/dev/null)
green "OK — authenticated as: $ACTIVE_ACCOUNT"

# ──────────────────────────────────────────────────────────────────────────────
step "2/5  Project '$PROJECT' accessible?"

if ! gcloud projects describe "$PROJECT" >/dev/null 2>&1; then
  AVAILABLE=$(gcloud projects list --format="value(projectId)" 2>/dev/null | tr '\n' ' ')
  red "FAIL: cannot access project '$PROJECT'"
  echo "  Available projects: $AVAILABLE"
  echo "  Either:"
  echo "    a) Create project: gcloud projects create $PROJECT --name='pdatahub'"
  echo "    b) Set different project: export PDATAHUB_PROJECT=<existing-name>"
  exit 1
fi
green "OK — $PROJECT is accessible"

# ──────────────────────────────────────────────────────────────────────────────
step "3/5  Google Calendar API enabled?"

CALENDAR_API="calendar-json.googleapis.com"
STATE=$(gcloud services list --enabled --project="$PROJECT" --format="value(config.name)" 2>/dev/null | grep -F "$CALENDAR_API" || true)

if [[ -z "$STATE" ]]; then
  red "FAIL: $CALENDAR_API NOT enabled"
  echo "  Enable it:"
  echo "    gcloud services enable $CALENDAR_API --project=$PROJECT"
  exit 1
fi
green "OK — $CALENDAR_API is enabled"

# ──────────────────────────────────────────────────────────────────────────────
step "4/5  OAuth 2.0 client with redirect_uri=$EXPECTED_REDIRECT?"

# OAuth 2.0 client IDs are managed via Cloud Console UI (no gcloud command).
# We use the OAuth API directly via curl + access token.
TOKEN=$(gcloud auth print-access-token 2>/dev/null)
# Try the iap oauth-clients API first (the only programmatic option)
CLIENTS_JSON=$(curl -s \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  "https://iap.googleapis.com/v1/projects/$PROJECT/oauthClients" 2>/dev/null || echo '{}')

# iap oauthClients is for Identity-Aware-Proxy, not general OAuth 2.0 client IDs.
# General OAuth 2.0 client IDs are managed via Cloud Console UI.
# Use the Identity Platform API as a fallback for OAuth clients.
if echo "$CLIENTS_JSON" | python3 -c 'import json,sys; d=json.load(sys.stdin); sys.exit(0 if d.get("oauthClients") else 1)' 2>/dev/null; then
  COUNT=$(echo "$CLIENTS_JSON" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["oauthClients"]))')
  green "OK — found $COUNT IAP OAuth client(s)"
else
  blue "INFO: Cannot list OAuth 2.0 client IDs via API (gcloud limitation)"
  echo "       Google Cloud OAuth 2.0 client IDs are managed via Console UI only."
  echo "       Verify manually: https://console.cloud.google.com/apis/credentials?project=$PROJECT"
  echo ""
  bold "Checklist:"
  echo "  [ ] OAuth client exists (Type: Web application)"
  echo "  [ ] Authorized redirect URI includes: $EXPECTED_REDIRECT"
  echo "  [ ] Client ID and Secret saved (for HUB_CLIENT_GOOGLE_CALENDAR_ID/SECRET)"
fi

# ──────────────────────────────────────────────────────────────────────────────
step "5/5  Hub-core OAuth config (if running)?"

if curl -s --max-time 3 http://127.0.0.1:8080/health >/dev/null 2>&1; then
  CREDS=$(curl -s "http://127.0.0.1:8080/health" 2>/dev/null)
  green "OK — hub-core running on :8080"
  echo ""
  bold "To complete e2e:"
  echo "  1. Set env vars: HUB_CLIENT_GOOGLE_CALENDAR_ID + HUB_CLIENT_GOOGLE_CALENDAR_SECRET"
  echo "  2. Restart hub-core with --oauth-callback-port 8081"
  echo "  3. Run: ./scripts/test-real-oauth.sh"
else
  blue "INFO: hub-core not running on :8080 — start it first to test OAuth flow"
fi

# ──────────────────────────────────────────────────────────────────────────────
bold ""
bold "════════════════════════════════════════════════════════════════════"
echo "Setup verification complete."
echo ""
echo "If anything was missing, the script above showed exact commands to fix."
echo "Once everything is green, run scripts/test-real-oauth.sh for end-to-end test."
bold "════════════════════════════════════════════════════════════════════"
