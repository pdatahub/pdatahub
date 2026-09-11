#!/usr/bin/env bash
# Plugin installer smoke test — verifies the full install flow against
# a running hub-core instance.
#
# Usage:
#   HUB_PORT=8765 ./scripts/install-plugin-smoke.sh
#
# Tests:
#   1. http:// URL → rejected with INSTALL_FAILED (HTTPS-only guard)
#   2. Path-based install (name + entry_path) → plugin starts, tools appear
#   3. List installed plugins via /v1/plugins
#
# The HTTPS-only guard is unit-tested in tests/plugin-installer.test.ts.
# This script exercises the server-side wiring (POST handler, plugin
# subprocess spawn, registry update).

set -euo pipefail

: "${HUB_PORT:=8765}"
HUB="http://127.0.0.1:${HUB_PORT}"
TOKEN="${HUB_API_TOKEN:-}"
if [ -z "$TOKEN" ]; then
  echo "ERROR: HUB_API_TOKEN env not set" >&2
  exit 1
fi

PASS=0
FAIL=0
check() {
  if eval "$2"; then
    echo "  PASS: $1"
    PASS=$((PASS+1))
  else
    echo "  FAIL: $1"
    FAIL=$((FAIL+1))
  fi
}

echo "=== Test 1: http:// URL → INSTALL_FAILED ==="
RESP=$(curl -s -X POST "$HUB/v1/plugins/install" \
  -H "Authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{"url":"http://example.com/x.tgz"}')
echo "  response: $RESP"
check "INSTALL_FAILED in response" 'echo "$RESP" | grep -q INSTALL_FAILED'

echo ""
echo "=== Test 2: bad request shape → 400 INVALID_INSTALL_REQUEST ==="
RESP=$(curl -s -X POST "$HUB/v1/plugins/install" \
  -H "Authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{}')
echo "  response: $RESP"
check "INVALID_INSTALL_REQUEST in response" 'echo "$RESP" | grep -q INVALID_INSTALL_REQUEST'

echo ""
echo "=== Test 3: path-based install → success ==="
# Use the local plugin-template as a known-good test plugin. If it has
# built artifacts, this verifies end-to-end install + tool listing.
TEMPLATE_DIR="/home/vladimirmyshkovski/Programs/AI/pdatahub-plugin-template"
if [ ! -d "$TEMPLATE_DIR/dist" ]; then
  echo "  SKIP: plugin-template not built at $TEMPLATE_DIR/dist"
else
  RESP=$(curl -s -X POST "$HUB/v1/plugins/install" \
    -H "Authorization: Bearer $TOKEN" \
    -H "content-type: application/json" \
    -d "{\"name\":\"plugin-template\",\"entry_path\":\"$TEMPLATE_DIR/dist/plugin.js\"}")
  echo "  response: $(echo "$RESP" | head -c 300)"
  check "name plugin-template in response" 'echo "$RESP" | grep -q plugin-template'

  echo ""
  echo "=== Test 4: /v1/plugins lists plugin-template ==="
  RESP=$(curl -s -H "Authorization: Bearer $TOKEN" "$HUB/v1/plugins")
  echo "  response: $(echo "$RESP" | head -c 300)"
  check "plugin-template in plugins list" 'echo "$RESP" | grep -q plugin-template'
fi

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
exit $FAIL
