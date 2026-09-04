#!/usr/bin/env bash
# pdatahub on-device setup — automates adb steps from Pairing Runbook.
#
# Run this script AFTER plugging in your Android device (USB debugging on).
# It will:
#   1. Verify prerequisites (adb, ANDROID_HOME, device connection)
#   2. Install Hub APK
#   3. Push Calendar plugin to device
#   4. Set up adb reverse for Hub MCP port
#   5. Print manual steps you need to do on the phone screen
#
# Idempotent: safe to re-run.
# Rollback: see "Cleanup" section at the bottom.
#
# Usage: ./on-device-setup.sh [--skip-apk] [--skip-plugin] [--skip-reverse]
#                          [--plugin-source DIR] [--device-path PATH]

set -euo pipefail

# ---------- Configuration ----------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MONOREPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PLUGIN_DEFAULT="$HOME/Programs/AI/pdatahub-plugin-google-calendar"
PLUGIN_SOURCE="${PLUGIN_DEFAULT}"
DEVICE_PLUGIN_PATH="/data/local/tmp/pdatahub-plugin-google-calendar"
HUB_MCP_PORT=8080  # McpHttpServer.kt: const val DEFAULT_PORT = 8080

# ---------- Args ----------
SKIP_APK=0
SKIP_PLUGIN=0
SKIP_REVERSE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-apk)     SKIP_APK=1;     shift ;;
    --skip-plugin)  SKIP_PLUGIN=1;  shift ;;
    --skip-reverse) SKIP_REVERSE=1; shift ;;
    --plugin-source) PLUGIN_SOURCE="$2"; shift 2 ;;
    --device-path) DEVICE_PLUGIN_PATH="$2"; shift 2 ;;
    --help|-h)
      sed -n '2,20p' "$0"
      exit 0
      ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

# ---------- Helpers ----------
RED=$'\e[0;31m'; GREEN=$'\e[0;32m'; YELLOW=$'\e[0;33m'; BLUE=$'\e[0;34m'; NC=$'\e[0m'
log()   { printf "${BLUE}[setup]${NC} %s\n" "$*"; }
ok()    { printf "${GREEN}[  ✓  ]${NC} %s\n" "$*"; }
warn()  { printf "${YELLOW}[ warn ]${NC} %s\n" "$*"; }
fail()  { printf "${RED}[ FAIL ]${NC} %s\n" "$*" >&2; exit 1; }

# ---------- 1. Prerequisites ----------
log "Step 0: Verifying prerequisites..."

# adb in PATH?
if ! command -v adb >/dev/null 2>&1; then
  fail "adb not in PATH. Run:
    export ANDROID_HOME=\$HOME/.android-sdk
    export PATH=\$ANDROID_HOME/platform-tools:\$PATH
  Then re-run this script."
fi
ok "adb at $(command -v adb)"

# ANDROID_HOME?
if [ -z "${ANDROID_HOME:-}" ]; then
  warn "ANDROID_HOME not set (using default ~/.android-sdk)"
  export ANDROID_HOME="$HOME/.android-sdk"
fi
ok "ANDROID_HOME=$ANDROID_HOME"

# Relay running?
if ! curl -sf --max-time 3 http://127.0.0.1:8787/health >/dev/null; then
  warn "Relay not running on 127.0.0.1:8787. Start it with:
    cd $MONOREPO_ROOT/packages/relay && pnpm exec wrangler dev --port 8787 --local"
else
  ok "Relay on http://127.0.0.1:8787/health"
fi

# Device connected?
DEVICE_COUNT=$(adb devices 2>&1 | grep -E '^\S+\s+device\s*$' | wc -l)
if [ "$DEVICE_COUNT" -eq 0 ]; then
  fail "No Android device detected. Plug in via USB with USB debugging on.
  Then check 'adb devices' shows your device as 'device' (not 'unauthorized')."
fi
DEVICE_SERIAL=$(adb devices | grep -E '^\S+\s+device\s*$' | head -1 | awk '{print $1}')
ok "Device connected: $DEVICE_SERIAL"

# ---------- 2. Install Hub APK ----------
if [ "$SKIP_APK" -eq 0 ]; then
  APK="$MONOREPO_ROOT/packages/android-app/app/build/outputs/apk/debug/app-debug.apk"
  if [ ! -f "$APK" ]; then
    fail "Hub APK not found at $APK. Build it with:
      cd $MONOREPO_ROOT/packages/android-app
      export JAVA_HOME=~/.local/jdk/jdk-17.0.13+11
      ./gradlew assembleDebug"
  fi
  APK_SIZE=$(ls -lh "$APK" | awk '{print $5}')
  log "Step 3: Installing Hub APK ($APK_SIZE)..."
  if adb install -r "$APK" >/dev/null 2>&1; then
    ok "Hub APK installed (replaced if existing)"
  else
    fail "adb install failed. Check 'adb logcat' for details."
  fi
else
  log "Step 3: SKIPPED (--skip-apk)"
fi

# ---------- 3. Push Calendar plugin ----------
if [ "$SKIP_PLUGIN" -eq 0 ]; then
  if [ ! -d "$PLUGIN_SOURCE" ]; then
    fail "Plugin source not found: $PLUGIN_SOURCE
  Use --plugin-source DIR to specify, or --skip-plugin to skip."
  fi

  # Build plugin if dist doesn't exist
  if [ ! -f "$PLUGIN_SOURCE/dist/index.js" ]; then
    log "Building Calendar plugin (dist/index.js missing)..."
    (cd "$PLUGIN_SOURCE" && pnpm build) >/dev/null
  fi

  # Verify SDK is installed in plugin's node_modules
  if [ ! -d "$PLUGIN_SOURCE/node_modules/@pdatahub/plugin-sdk" ]; then
    fail "Plugin node_modules missing @pdatahub/plugin-sdk.
  Run inside plugin dir: pnpm install"
  fi

  log "Step 8: Pushing Calendar plugin to $DEVICE_PLUGIN_PATH..."
  # Create device dir, remove existing first for clean state
  adb shell "rm -rf $DEVICE_PLUGIN_PATH && mkdir -p $DEVICE_PLUGIN_PATH/dist"

  # dist + package.json: regular files, adb push is fine
  adb push "$PLUGIN_SOURCE/dist/" "$DEVICE_PLUGIN_PATH/dist/" >/dev/null
  adb push "$PLUGIN_SOURCE/package.json" "$DEVICE_PLUGIN_PATH/" >/dev/null

  # node_modules contains .bin/ symlinks (tsc, vitest etc.) that adb push
  # can't handle cleanly AND Android tar on /data/local/tmp fails to create
  # symlinks (Permission denied). Fix: cp -RL creates symlink-free copy first,
  # then tar -czf produces tarball with NO symlinks at all.
  log "Packaging node_modules as tarball (symlink-free via cp -RL)..."
  NODE_MODULES_TARBALL="$(mktemp -t plugin-node_modules.XXXXXX.tar.gz)"
  NM_COPY_DIR="$(mktemp -d -t pdatahub-nm.XXXXXX)"
  cp -RL "$PLUGIN_SOURCE/node_modules" "$NM_COPY_DIR/node_modules"
  tar -czf "$NODE_MODULES_TARBALL" -C "$NM_COPY_DIR" node_modules
  rm -rf "$NM_COPY_DIR"
  TARBALL_SIZE=$(ls -lh "$NODE_MODULES_TARBALL" | awk '{print $5}')
  log "Tarball: $NODE_MODULES_TARBALL ($TARBALL_SIZE)"

  log "Pushing tarball to /data/local/tmp/ and extracting..."
  DEVICE_TARBALL="/data/local/tmp/plugin-node_modules.tar.gz"
  adb push "$NODE_MODULES_TARBALL" "$DEVICE_TARBALL" >/dev/null
  # Extract on device. Termux has tar by default; standard Android shell has it too.
  adb shell "cd $DEVICE_PLUGIN_PATH && tar -xzf $DEVICE_TARBALL && rm $DEVICE_TARBALL"
  # Cleanup local tarball
  rm -f "$NODE_MODULES_TARBALL"

  # Verify
  if adb shell "test -f $DEVICE_PLUGIN_PATH/dist/index.js" 2>/dev/null; then
    ok "Plugin pushed to device"
  else
    fail "Plugin push failed — check adb logcat"
  fi
  if adb shell "test -f $DEVICE_PLUGIN_PATH/node_modules/@pdatahub/plugin-sdk/dist/index.js" 2>/dev/null; then
    ok "Plugin SDK present on device"
  else
    warn "@pdatahub/plugin-sdk NOT FOUND in plugin node_modules on device.
    Plugin will fail to spawn. Check that node_modules was pushed correctly."
  fi
  ENTRY_PATH="$DEVICE_PLUGIN_PATH/dist/index.js"
else
  log "Step 8: SKIPPED (--skip-plugin)"
  ENTRY_PATH="$DEVICE_PLUGIN_PATH/dist/index.js"  # expected path
fi

# ---------- 4. adb reverse ----------
if [ "$SKIP_REVERSE" -eq 0 ]; then
  log "Setting up adb reverse: laptop:$HUB_MCP_PORT -> device:$HUB_MCP_PORT..."
  # Remove existing reverse if any
  adb reverse --remove tcp:$HUB_MCP_PORT 2>/dev/null || true
  if adb reverse tcp:$HUB_MCP_PORT tcp:$HUB_MCP_PORT 2>&1; then
    ok "adb reverse tcp:$HUB_MCP_PORT -> device:$HUB_MCP_PORT"
  else
    warn "adb reverse failed. Fallback: use phone's LAN IP for PDAHUB_HUB_URL"
  fi
else
  log "adb reverse: SKIPPED (--skip-reverse)"
fi

# ---------- 5. Print next steps ----------
LAPTOP_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
[ -z "$LAPTOP_IP" ] && LAPTOP_IP="<laptop_ip>"

cat <<EOF

${GREEN}╔══════════════════════════════════════════════════════════════════╗
║  AUTOMATED SETUP COMPLETE — Manual steps remaining:              ║
╚══════════════════════════════════════════════════════════════════╝${NC}

${BLUE}On your Android phone:${NC}
  1. Open Hub app (installed as "pdatahub" or "Personal Data Hub")
  2. Settings → Relay URL → enter: http://${LAPTOP_IP}:8787
  3. Settings → pair with laptop → scan QR (or use Hub URL directly)
  4. Plugins → "+ Install plugin":
       Plugin Path: ${ENTRY_PATH}
       Plugin Name: google-calendar (or any identifier)
  5. Authorize Google OAuth when prompted (loopback http://127.0.0.1:8080)

${BLUE}On your laptop:${NC}
  After pairing, Hub returns a session_token. Add to ~/.bashrc:
    export PDAHUB_HUB_URL='http://localhost:${HUB_MCP_PORT}'
    export PDAHUB_SESSION_TOKEN='<token_from_hub>'
    source ~/.bashrc

  Then enable pdatahub MCP in ~/.config/opencode/opencode.json
  (set "enabled": true in mcp.pdatahub) and restart OpenCode.

${BLUE}Test end-to-end:${NC}
  In OpenCode, ask: "покажи мои события календаря на эту неделю"
  Expected: real events from your Google Calendar.

${BLUE}Cleanup (rollback):${NC}
  adb uninstall com.pdatahub.hub
  adb shell rm -rf ${DEVICE_PLUGIN_PATH}
  adb reverse --remove tcp:${HUB_MCP_PORT}
EOF
