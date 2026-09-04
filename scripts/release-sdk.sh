#!/usr/bin/env bash
# pdatahub SDK release automation.
#
# Bumps @pdatahub/plugin-sdk version, builds, packs tarball, creates GH Release,
# prints updated dependency URLs for plugin repos.
#
# Usage:
#   ./scripts/release-sdk.sh [VERSION]
#
# Examples:
#   ./scripts/release-sdk.sh patch       # 0.1.0 → 0.1.1
#   ./scripts/release-sdk.sh minor       # 0.1.0 → 0.2.0
#   ./scripts/release-sdk.sh major       # 0.1.0 → 1.0.0
#   ./scripts/release-sdk.sh 0.5.0       # explicit version
#   ./scripts/release-sdk.sh             # interactive prompt
#
# After release, plugin repos (template + calendar) need:
#   - package.json dep URL bumped
#   - pnpm-lock.yaml or package-lock.json regenerated
#   - Commit + push
#
# Requires: gh CLI authenticated, pnpm, npm, git clean working tree.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MONOREPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SDK_DIR="$MONOREPO_ROOT/packages/plugin-sdk"
SDK_PKG="$SDK_DIR/package.json"

# ---------- Helpers ----------
RED=$'\e[0;31m'; GREEN=$'\e[0;32m'; YELLOW=$'\e[0;33m'; BLUE=$'\e[0;34m'; NC=$'\e[0m'
log()  { printf "${BLUE}[release]${NC} %s\n" "$*"; }
ok()   { printf "${GREEN}[  ✓  ]${NC} %s\n" "$*"; }
warn() { printf "${YELLOW}[ warn ]${NC} %s\n" "$*"; }
fail() { printf "${RED}[ FAIL ]${NC} %s\n" "$*" >&2; exit 1; }

# ---------- Check prerequisites ----------
log "Checking prerequisites..."

command -v gh >/dev/null || fail "gh CLI not installed"
command -v pnpm >/dev/null || fail "pnpm not installed"
command -v npm >/dev/null || fail "npm not installed (needed for npm pack)"
command -v jq >/dev/null || warn "jq not installed — falling back to grep/sed for JSON parsing"

gh auth status >/dev/null 2>&1 || fail "gh not authenticated. Run: gh auth login"
ok "gh authenticated"

# Verify clean working tree
if ! git -C "$MONOREPO_ROOT" diff --quiet HEAD 2>/dev/null; then
  fail "Working tree has uncommitted changes. Commit or stash first."
fi
ok "Working tree clean"

# Get current version
get_current_version() {
  node -e "console.log(require('$SDK_PKG').version)"
}

CURRENT_VERSION=$(get_current_version)
log "Current version: $CURRENT_VERSION"

# ---------- Determine new version ----------
NEW_VERSION=""

if [ $# -eq 0 ]; then
  printf "Enter new version (current $CURRENT_VERSION), or bump type [patch|minor|major]: "
  read -r NEW_VERSION
fi

# Resolve bump type to actual version
case "$NEW_VERSION" in
  patch|minor|major)
    IFS='.' read -r major minor patch <<< "$CURRENT_VERSION"
    case "$NEW_VERSION" in
      patch) NEW_VERSION="$major.$minor.$((patch + 1))" ;;
      minor) NEW_VERSION="$major.$((minor + 1)).0" ;;
      major) NEW_VERSION="$((major + 1)).0.0" ;;
    esac
    ;;
  "")
    fail "No version provided"
    ;;
esac

# Validate semver-ish (X.Y.Z or X.Y.Z-pre+build)
if ! [[ "$NEW_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?(\+[a-zA-Z0-9.]+)?$ ]]; then
  fail "Invalid version format: $NEW_VERSION (expected X.Y.Z)"
fi

log "Will release: $CURRENT_VERSION → $NEW_VERSION"
printf "Proceed? [y/N] "
read -r CONFIRM
[[ "$CONFIRM" =~ ^[Yy]$ ]] || fail "Aborted by user"

# ---------- 1. Update version in package.json ----------
log "Updating version in package.json..."
node -e "
const fs = require('fs');
const p = JSON.parse(fs.readFileSync('$SDK_PKG', 'utf8'));
p.version = '$NEW_VERSION';
fs.writeFileSync('$SDK_PKG', JSON.stringify(p, null, 2) + '\n');
"
ok "package.json updated"

# ---------- 2. Build SDK ----------
log "Building SDK..."
(cd "$SDK_DIR" && pnpm build 2>&1 | tail -3)
ok "Build complete"

# ---------- 3. Verify tests pass ----------
log "Running vitest..."
(cd "$SDK_DIR" && pnpm test 2>&1 | tail -5)
ok "Tests pass"

# ---------- 4. Pack tarball ----------
log "Creating tarball..."
(cd "$SDK_DIR" && npm pack 2>&1 | tail -2)
TARBALL="$SDK_DIR/pdatahub-plugin-sdk-$NEW_VERSION.tgz"
[ -f "$TARBALL" ] || fail "Tarball not found at $TARBALL"
TARBALL_SIZE=$(ls -lh "$TARBALL" | awk '{print $5}')
ok "Tarball: pdatahub-plugin-sdk-$NEW_VERSION.tgz ($TARBALL_SIZE)"

# ---------- 5. Commit version bump ----------
log "Committing version bump..."
git -C "$MONOREPO_ROOT" add "packages/plugin-sdk/package.json"
git -C "$MONOREPO_ROOT" commit -m "chore(sdk): bump version to $NEW_VERSION"
ok "Committed"

# ---------- 6. Create GitHub Release ----------
TAG="v$NEW_VERSION"
log "Creating GitHub release $TAG..."

# Check if tag already exists
if git -C "$MONOREPO_ROOT" rev-parse "$TAG" >/dev/null 2>&1; then
  fail "Tag $TAG already exists locally. Delete with: git tag -d $TAG"
fi

RELEASE_NOTES=$(cat <<EOF
@pdatahub/plugin-sdk $NEW_VERSION

Bump version in plugin repos:
\`\`\`
"@pdatahub/plugin-sdk": "https://github.com/pdatahub/pdatahub/releases/download/${TAG}/pdatahub-plugin-sdk-${NEW_VERSION}.tgz"
\`\`\`

Then regenerate lockfile (\`pnpm install --no-frozen-lockfile\` or \`npm install\`).

See CONTEXT.md for the npm-published-but-blocked-on-2FA context.
EOF
)

gh release create "$TAG" \
  --repo pdatahub/pdatahub \
  --title "$TAG — @pdatahub/plugin-sdk" \
  --notes "$RELEASE_NOTES" \
  "$TARBALL"
ok "Release $TAG published"

# ---------- 7. Cleanup local tarball (GH has it now) ----------
rm -f "$TARBALL"

# ---------- 8. Push commit ----------
log "Pushing commit to main..."
git -C "$MONOREPO_ROOT" push origin main

# ---------- 9. Print next steps ----------
DOWNLOAD_URL="https://github.com/pdatahub/pdatahub/releases/download/${TAG}/pdatahub-plugin-sdk-${NEW_VERSION}.tgz"

cat <<EOF

${GREEN}╔══════════════════════════════════════════════════════════════════╗
║  SDK $NEW_VERSION RELEASED                                    ║
╚══════════════════════════════════════════════════════════════════╝${NC}

${BLUE}Download URL:${NC}
  $DOWNLOAD_URL

${BLUE}Next: update plugin repos${NC}

In \`pdatahub-plugin-template\` and \`pdatahub-plugin-google-calendar\`:
  1. Edit package.json:
       "@pdatahub/plugin-sdk": "$DOWNLOAD_URL"
  2. Regenerate lockfile:
       template: pnpm install --no-frozen-lockfile
       calendar: npm install
  3. Commit + push
  4. Verify CI green for each repo

EOF
