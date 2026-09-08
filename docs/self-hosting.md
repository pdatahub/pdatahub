# Self-Hosting pdatahub

Self-hosting pdatahub means running `hub-core` on your own laptop or home server. Your OAuth tokens, your grant data, your audit log. No third party holds anything.

This guide covers the full setup from zero to a working hub on your laptop, plus hardening, monitoring, and disaster recovery.

## What self-hosting gives you

- **Your tokens stay on your hardware.** Encrypted at rest with AES-256-GCM and a per-plugin HKDF-derived key. A breach of the plugin process doesn't compromise another plugin's tokens. See [docs/threat-model.md §Token vault](./threat-model.md#token-vault-aes-256-gcm-hkdf-per-plugin).
- **Phone-mediated approval.** Every tool call triggers a push notification to your phone; you tap Approve with biometric. Sub-second latency over a Tailscale mesh.
- **Federation v2.** You can share a single tool with another trusted hub owner's data — and your phone stays the approval authority. See [docs/federation.md](./federation.md).
- **No vendor.** No usage cap, no per-invocation fee, no rate limit. Runs offline (except for the actual API calls your plugins make).
- **Same code as Cloud.** When pdatahub Cloud v3 ships, you'll be able to migrate your hub state to a hosted instance via the same `pdatahub-hub` CLI.

## Hardware requirements

The hub is small. 300 MB RSS typical, ~50 MB on disk for SQLite. Anything from a Raspberry Pi 4 upward is fine.

| Form factor | Min RAM | Notes |
|-------------|---------|-------|
| Laptop (any) | 2 GB free | Easiest — same machine that runs your AI agent |
| Raspberry Pi 4 / 5 | 4 GB | Runs headless; Tailscale for remote access |
| Mini PC (Intel NUC, Beelink, etc.) | 4 GB | Always-on; lowest power |
| Old desktop repurposed | 4 GB+ | Often cheapest; check Tailscale support for your NIC |

CPU is irrelevant — hub-core spends 99% of its time waiting on I/O. Disk is irrelevant — SQLite is tiny. RAM is the only thing that matters; 2 GB is comfortable.

## Network options

You need a path between your laptop (running hub-core) and your phone (running the Android app). Pick one:

| Option | When | Trade-offs |
|--------|------|------------|
| **Tailscale** (recommended) | Default choice for personal use | Zero-config mesh, free for ≤100 devices, audited WireGuard, works on cellular. **This is what the docs assume.** |
| **Direct LAN WiFi** | Laptop and phone on same home WiFi, no internet needed | Fastest latency, but only works at home |
| **`adb reverse` over USB** | Phone plugged into laptop, debugging | Works without WiFi; intended for development |
| **Cloudflare Tunnel** (`cloudflared`) | Tailscale blocked in your country | Public URL, free tier, more setup; see [docs/relay-mode.md](./relay-mode.md) |
| **Self-hosted relay (Cloudflare Worker or VPS)** | Multiple hubs, edge rate limiting, public access | Most flexibility; most setup. Documented in `.omo/plans/relay-mode-design.md` |

We recommend **Tailscale** because it's zero-config, works on cellular, and uses audited WireGuard. If you can't use Tailscale, the relay packages in `packages/relay/` are the fallback — they're in stub today but the path is laid.

## Step-by-step setup

### 1. Install prerequisites

| OS | Commands |
|----|----------|
| macOS | `brew install node pnpm` (Node 20+ required); for Android: Android Studio + SDK 35 |
| Ubuntu 24.04 | `sudo apt install -y nodejs npm && sudo npm i -g pnpm` |
| Fedora 40+ | `sudo dnf install -y nodejs pnpm` |
| Arch | `sudo pacman -S nodejs pnpm` |
| Windows | `winget install OpenJS.NodeJS.LTS pnpm.pnpm` |

Verify:

```bash
node --version    # v20.x or newer
pnpm --version    # 9.x or newer
```

### 2. Clone and build

```bash
git clone https://github.com/pdatahub/pdatahub
cd pdatahub
pnpm install
pnpm build
```

This builds `hub-core`, `mcp-server`, `plugin-sdk`, and `relay` via Turborepo. The Android app and Go runner are built separately when you need them.

### 3. Generate a master key and an API token

These two secrets are the keys to the kingdom:

```bash
# Master key — encrypts your OAuth tokens at rest (32 bytes hex)
MASTER_KEY=$(openssl rand -hex 32)

# API token — authenticates MCP clients (mcp-server, curl scripts)
HUB_API_TOKEN=$(openssl rand -hex 32)
```

**Back these up.** If you lose `MASTER_KEY`, you cannot decrypt your OAuth tokens anymore — you'd need to re-authenticate every plugin. If you lose `HUB_API_TOKEN`, you can't talk to your hub from the AI agent.

Backup strategies:

- Password manager (1Password, Bitwarden, KeePassXC) — best for most people
- Printed paper in a safe — best for paranoid setups
- Encrypted USB drive — middle ground

### 4. Start hub-core

The simplest form is foreground:

```bash
node packages/hub-core/dist/index.js \
  --port 8080 \
  --master-key "$MASTER_KEY" \
  --db-path ~/.local/share/pdatahub/hub.db \
  --oauth-callback-port 8081 \
  --plugins-dir ~/.local/share/pdatahub/plugins
```

For long-running use, run as a systemd service. Create `/etc/systemd/system/pdatahub-hub.service`:

```ini
[Unit]
Description=pdatahub hub-core
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
Type=simple
User=<your-username>
Environment=MASTER_KEY=<paste-hex-here>
Environment=HUB_API_TOKEN=<paste-hex-here>
ExecStart=/usr/bin/node /home/<your-username>/Programs/AI/pdatahub/packages/hub-core/dist/index.js \
  --port 8080 \
  --master-key ${MASTER_KEY} \
  --db-path /home/<your-username>/.local/share/pdatahub/hub.db \
  --oauth-callback-port 8081 \
  --plugins-dir /home/<your-username>/.local/share/pdatahub/plugins \
  --bind 100.64.0.1
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now pdatahub-hub
sudo systemctl journalctl -u pdatahub-hub -f   # follow logs
```

The `--bind 100.64.0.1` (your Tailscale IP, not `0.0.0.0`) limits the listener to the tailnet — see [Security hardening](#security-hardening).

### 5. Set up Tailscale

Tailscale gives you a stable IP and MagicDNS hostname on every device that joins your account.

```bash
# On laptop
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
# Browser opens for OAuth login
tailscale status    # note your Tailscale IP (100.x.y.z) and hostname (<your-host>.tail<hash>.ts.net)
```

```bash
# On phone
# Install "Tailscale" from Google Play (or App Store)
# Open, log in with the same account, wait for "Connected"
```

Verify from your phone's browser: `http://<your-tailscale-ip>:8080/health` should return `{"status":"ok","service":"pdatahub-hub"}`.

### 6. Configure the Android phone

Build and install the Android app (UI client only — see [packages/android-app/README.md](../packages/android-app/README.md)):

```bash
cd packages/android-app
JAVA_HOME=/path/to/jdk-17 ./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

The first time you launch the app, it shows a pairing screen. Either:

- **Scan a QR code** from `pdatahub-hub pair` (CLI on the laptop), or
- **Enter settings manually**: hub URL = `http://<your-tailscale-ip>:8080`, token = your `HUB_API_TOKEN`.

Once paired, the app stays connected over WebSocket. Approvals arrive as push notifications.

### 7. Install your first plugin

The reference plugin is `pdatahub-plugin-google-calendar`. Download it from its GitHub Release:

```bash
PLUGIN_DIR=~/.local/share/pdatahub/plugins
mkdir -p "$PLUGIN_DIR"
curl -L https://github.com/pdatahub/pdatahub-plugin-google-calendar/releases/latest/download/google-calendar.tgz \
  | tar -xz -C "$PLUGIN_DIR"
```

Restart hub-core (or `systemctl restart pdatahub-hub`). The plugin will be picked up on next tool call.

For development (modifying the plugin), symlink instead of unpacking:

```bash
ln -s /path/to/pdatahub-plugin-google-calendar "$PLUGIN_DIR/google-calendar"
```

The hub uses `realpathSync()` so symlinks resolve cleanly. See [docs/architecture.md §Plugin lifecycle](./architecture.md#plugin-lifecycle).

### 8. Configure Google OAuth (for the Calendar plugin)

1. Open [Google Cloud Console → APIs & Services → Credentials](https://console.cloud.google.com/apis/credentials).
2. **Create OAuth client** → Application type = **Web application**.
3. **Authorized redirect URIs** (add one per network setup you use):

   | Setup | URI |
   |-------|-----|
   | `adb reverse` over USB | `http://127.0.0.1:8081/callback` |
   | Direct LAN | `http://192.168.x.x:8081/callback` |
   | Tailscale | `http://<your-host>.tail<hash>.ts.net:8081/callback` |

4. Copy the client ID and client secret into your hub's environment:

   ```bash
   export HUB_CLIENT_GOOGLE_CALENDAR_ID="xxx.apps.googleusercontent.com"
   export HUB_CLIENT_GOOGLE_CALENDAR_SECRET="GOCSPX-xxx"
   ```

   For Tailscale cross-device, also set:

   ```bash
   export HUB_PUBLIC_HOSTNAME="<your-host>.tail<hash>.ts.net"
   ```

   This tells the OAuth flow to use the Tailscale URL in the redirect URI it advertises to the user. Without this, Google will reject the redirect on a phone that's not on the same WiFi as your laptop.

5. Restart hub-core. From your phone, open the pdatahub Android app, tap "Authenticate Google Calendar" — the OAuth dance runs in your phone's browser, returns to the hub's callback, and the access token lands in your encrypted vault.

### 9. Verify end-to-end

The fastest smoke test:

```bash
HUB_API_TOKEN=$(cat ~/.config/pdatahub/api-token)   # or paste
curl -sS -H "Authorization: Bearer $HUB_API_TOKEN" \
  http://127.0.0.1:8080/v1/tools | jq .
```

You should see `google-calendar` with its tools (`listEvents`, etc.).

Now run an actual call from your MCP-capable AI agent (OpenCode, Claude Code, Cursor). It will:

1. Send `listEvents` via MCP → `mcp-server` → `hub-core`.
2. Hub-core has no active grant → push notification to your phone.
3. You tap Approve (with biometric if enabled).
4. Hub-core spawns the plugin subprocess, injects the decrypted OAuth token.
5. Plugin calls Google Calendar, returns events.
6. Hub-core writes an audit row, broadcasts to phone, returns result to AI agent.

Total time: ~5 seconds on a healthy setup. If it hangs, jump to [Troubleshooting](#troubleshooting).

## Backup and restore

Hub state lives in `~/.local/share/pdatahub/hub.db` (SQLite) plus the master key. To back up:

```bash
pdatahub-hub backup --output ~/.pdatahub-backup \
  --master-key "$MASTER_KEY"
```

This writes a BIP-39-encrypted file containing the SQLite dump (grants, audit, encrypted tokens). To restore on another machine:

```bash
# On the new machine
pdatahub-hub restore --input ~/.pdatahub-backup \
  --master-key "$(echo 'word1 word2 word3 ... word12' | mnemonic-to-hex)" \
  --db-path ~/.local/share/pdatahub/hub.db
```

The CLI prints the 12-word BIP-39 mnemonic on backup. **Write it down on paper** as a third-tier disaster backup — your master key can be regenerated from it.

Test the restore path **before you need it.** Losing your hub state because the restore was broken is the worst kind of learning experience.

## Federation

If you want to share a tool with another hub owner, see [docs/federation.md](./federation.md). Federation v2 ships; all eight phases are tested. You can:

- Delegate a single tool (`google-calendar.listEvents` with `calendar:read`) to one trusted peer's hub.
- Approve each federated call from your phone, just like a local call.
- Revoke at any time (`pdatahub-hub delegation revoke <id>`).
- Audit every call on both hubs.

Cross-hub audit retention: see [docs/federation.md §Audit retention](./federation.md#audit-retention-phase-7b) — a federation call produces two audit rows (one on each hub), so plan to purge periodically.

## Security hardening

The defaults are sane for development. Before exposing your hub to anything beyond a loopback, harden it.

### Bind to specific interfaces

By default, hub-core binds to `0.0.0.0`, which means anything that can route to your machine can reach the hub. Bind to your Tailscale IP only:

```bash
--bind 100.64.0.1    # your Tailscale IP, not 0.0.0.0
```

This way only devices on your tailnet can reach the hub. The hub also refuses to start on a non-loopback interface without `HUB_API_TOKEN`:

```
HUB_API_TOKEN must be set when binding to a non-loopback interface.
For local development only, bind to 127.0.0.1.
```

### Strong `HUB_API_TOKEN`

Use at least 32 bytes of randomness. Don't reuse a personal password. Don't share it with people who shouldn't have full hub access (they should use the Android app, which scopes by per-call approval).

### Firewall rules

If you bind to `0.0.0.0` (don't), at least firewall the port:

```bash
# Allow only Tailscale subnet
sudo ufw allow from 100.64.0.0/10 to any port 8080
sudo ufw deny 8080
```

### Plugin sandboxing

Currently plugins run as Node.js subprocesses. They share Node.js global state and have the same OS privileges as the hub process. The v4 sandbox uses V8 isolates for memory isolation; until then, **only install plugins you trust**. The plugin SDK source is open — read it.

### Audit log review

Periodically scan `/v1/audit`:

```bash
curl -H "Authorization: Bearer $HUB_API_TOKEN" \
  "http://127.0.0.1:8080/v1/audit?limit=100" | jq .
```

Look for unexpected `agent_id` values, denied calls, or unusual scopes. If something looks wrong, `POST /v1/grants/:id/revoke` kills the grant immediately.

## Monitoring

| Signal | How |
|--------|-----|
| Hub process health | `systemctl status pdatahub-hub` |
| Hub logs | `journalctl -u pdatahub-hub -f` |
| Audit log live stream | `GET /v1/audit?since=<timestamp>` (poll) or WebSocket `/approval-stream` (live) |
| Phone approval failures | Filter journal for `ApprovalStream.* timeout` |
| Plugin crash rate | Filter journal for `PluginProcess.* exited with code` |
| Audit row growth | `wc -l ~/.local/share/pdatahub/hub.db` (or `pdatahub-hub audit count`) |

A minimal monitoring setup: a daily cron job that checks `journalctl -u pdatahub-hub --since "1 day ago" | grep -c ERROR` and alerts if >5. For multi-hub setups, see [docs/federation.md §Audit retention](./federation.md#audit-retention-phase-7b).

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Hub won't start on non-loopback | `HUB_API_TOKEN` not set | Set `HUB_API_TOKEN` in the systemd unit or environment |
| `401 Unauthorized` from MCP client | Wrong or missing token | Re-check the bearer token; rotate via `pdatahub-hub rotate-token` |
| Phone never receives approval | WebSocket disconnected | Open the Android app, check Settings → Hub URL, verify `tailscale status` on phone shows "Connected" |
| Approval notification but no biometric prompt | `biometric_enabled` not set | In Android app: Settings → Biometric → Enable |
| `plugin not found` after install | Hub wasn't restarted | `systemctl restart pdatahub-hub` (or `--plugins-dir` watch isn't on) |
| OAuth callback `redirect_uri_mismatch` | Google Cloud Console doesn't have the right URI | Add the URI you're currently using; `HUB_PUBLIC_HOSTNAME` controls which one Hub advertises |
| `Token decryption failed` | Wrong master key | Restore from BIP-39 backup |
| Federation: `401 CLOCK_SKEW` | Your laptop clock is off | Enable NTP (`timedatectl set-ntp true`) |
| Federation: `503 NO_APPROVER_CONNECTED` | Peer's phone offline | Wait for them to reconnect, or have them bind `/approval-stream` from desktop too |
| Federation: `409 REPLAY` | Same `request_id` reused | Restart the MCP client; this is a bug in the client, not the hub |

For more federation-specific issues, see [docs/federation.md §What to do if things break](./federation.md#what-to-do-if-things-break).

## When to upgrade to Cloud

Self-hosting is the right default. Move to **pdatahub Cloud v3** when:

- **You want always-on availability.** Cloud v3 provisions a Hetzner VM per user, monitors it, backs it up.
- **You have multiple devices** and don't want to set up Tailscale on all of them.
- **You're sharing with non-technical users.** The Cloud onboarding is one OAuth click; self-hosting requires the steps in this guide.
- **You want SLA-grade audit retention.** Cloud ships scheduled `audit purge` with configurable retention.

When Cloud launches, your hub state migrates with `pdatahub-hub migrate --to-cloud` — same database format, same master key, same plugin compatibility.

See [packages/runner/README.md](../packages/runner/README.md) for the current Cloud v3 status (Phase 1A skeleton today). See `.omo/plans/cloud-v3-design.md` for the full design.

---

Questions? Open a [Discussion](https://github.com/pdatahub/pdatahub/discussions) or [an issue](https://github.com/pdatahub/pdatahub/issues/new). Security issues: see [SECURITY.md](../SECURITY.md).