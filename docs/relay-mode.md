# Relay Mode (current: Tailscale)

**Status:** Tailscale active (2026-09-06). hub-core reachable via Tailscale IP from any device on the same Tailscale account.

## What this solves

Hub-core runs on your laptop. Before relay mode, phone had to be on the same network (USB tether via `adb reverse` or same WiFi). With Tailscale:

- Phone on cellular in a café → reaches hub-core at home
- OpenCode on a different machine → reaches hub-core
- All traffic encrypted via WireGuard
- Zero infrastructure to maintain (Tailscale handles mesh networking)

## Architecture

```
[Phone (Tailscale IP)] ──┐
                         │  WireGuard encrypted
[Laptop (Tailscale IP)]  ┴── hub-core :8080
```

hub-core binds `0.0.0.0:8080` like before. Tailscale attaches a virtual interface with a `100.x.y.z` IP. Phone connects to that IP — same hub-core, no code changes.

## Setup (already done)

### Laptop

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
# Browser opens for OAuth login
tailscale status  # shows your Tailscale IP
```

### Phone

1. Install **Tailscale** from Google Play
2. Open app, log in with same account
3. Wait for "Connected" status
4. Open browser → `http://<laptop-tailscale-ip>:8080/health`
5. Should see `{"status":"ok","service":"pdatahub-hub"}`

### Android app (pdatahub client)

The Android app needs to know the Tailscale IP instead of localhost:

```
hub-core URL: http://<laptop-tailscale-ip>:8080
```

This is the same URL whether phone is on WiFi, cellular, or different country — as long as Tailscale is connected.

## Operational notes

- **Tailscale IP can change** if you log out and back in. Use `tailscale status` to check current IP.
- **MagicDNS** lets you use `<your-hostname>.tail<hash>.ts.net` instead of IP. Stable as long as the hostname is configured. Set in the Tailscale admin console.
- **Auto-start**: Tailscale daemon auto-starts on boot (`tailscaled.service` enabled).
- **Logs**: `journalctl -u tailscaled` or `tailscale status` for current state.

## Security

- All traffic encrypted with **WireGuard** (modern, audited, fast)
- Tailscale **coordination server** only sees key exchange, not your traffic
- hub-core has no auth layer beyond its own grant system (`HUB_API_TOKEN` env var)
- For multi-user / public exposure, see `.omo/plans/relay-mode-design.md` (option B: Cloudflare Worker)

## When to migrate to Cloudflare Worker (option B)

See decision criteria in `.omo/plans/relay-mode-design.md`. Short version:
- Stay on Tailscale for personal use
- Migrate to Worker only if: 5+ devices, want public URL, need edge rate limiting, want shared access without Tailscale accounts

## Verification (2026-09-06)

```bash
$ tailscale status
<laptop-tailscale-ip>  <your-hostname>  linux  -

$ curl http://<laptop-tailscale-ip>:8080/health
{"status":"ok","service":"pdatahub-hub"}
```
