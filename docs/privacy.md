# Privacy Policy

> **Short version:** pdatahub is self-hosted. We (the project maintainers) don't collect, store, transmit, or sell any of your data — because we don't have access to it. Your hub runs on your hardware, with your tokens, and your data never leaves your network except for the API calls you explicitly authorize (e.g. reading a calendar event via the Google Calendar plugin).

Last updated: 2026-09-10

## Scope

This policy covers pdatahub-hub, pdatahub-mcp-server, and the official pdatahub-plugin-* packages distributed from this GitHub organization.

It does NOT cover:

- **Third-party plugins** you install yourself (their respective policies apply)
- **Upstream APIs** your plugins talk to (Google Calendar, Slack, Gmail, etc. — their policies apply)
- **Peer hubs** in a Federation v2 setup (each peer is independently operated; the trust anchor is the signed delegation blob)

## What we (the project maintainers) collect

**Nothing.** There is no central service. No analytics, no telemetry, no error reporting, no upgrade pings, no crash reports. The hub-core binary is plain Node.js with no outbound connections except those YOU configure (OAuth callbacks to Google/Slack/etc., and federated calls to peer hubs you authorize).

You can verify this yourself: `grep -r "fetch\|http.request\|undici" packages/hub-core/src/` shows every network call. Each one is either (a) to your local file system, (b) to an upstream API you've configured, or (c) to a peer hub you have a delegation for.

## What YOU collect (when you run your own hub)

Your hub stores on your local disk:

- **OAuth access tokens** for each plugin (e.g. Google's access token for your Calendar account)
- **OAuth refresh tokens** (long-lived; rotated when Google's token endpoint returns a new one)
- **Grant records** (which tool calls you approved, when, and how long they're valid for)
- **Audit log** (every tool call you made, when, what the AI agent was, what data it accessed)
- **Hub identity** (Ed25519 signing keypair for Federation v2)
- **Master encryption key** (the secret that decrypts everything above; you control it)

All of this lives in your hub's SQLite database file (`hub.db`) and is encrypted at rest with AES-256-GCM using your master key. See [docs/threat-model.md](./threat-model.md) for the full security model.

## What your plugins do

Each plugin you install talks to its upstream API (Google Calendar, Slack, Gmail, etc.). Those calls happen directly between your hub and the upstream API — they don't go through any pdatahub-controlled intermediary. The upstream's privacy policy and terms govern what happens to that data.

Examples:

- The Google Calendar plugin calls `googleapis.com/calendar/v3/...` using your OAuth access token. Google's [Privacy Policy](https://policies.google.com/privacy) governs what Google sees.
- The Slack plugin calls `slack.com/api/...` using your bot token. Slack's [Privacy Policy](https://slack.com/privacy) governs what Slack sees.
- The Gmail plugin calls `googleapis.com/gmail/v1/...` similarly.

We have no access to the request/response bodies of these calls.

## Federation v2

If you set up federation between two hubs (yours and a trusted friend's, or your laptop and your phone), the following crosses the network:

- **Signed delegation blobs** (Ed25519 signatures, base64-encoded, no plaintext)
- **Federated tool call requests/responses** (TLS-encrypted; only the data your delegation explicitly authorizes)

Each peer hub is independently operated. The trust model is: you sign a delegation blob allowing a specific peer hub to invoke a specific tool on a specific plugin for a specific scope, with an explicit expiration. See [docs/federation.md](./federation.md).

## Children's data

pdatahub is a developer tool for personal data orchestration. It is not directed at children under 13 (COPPA) or under 16 (GDPR). We do not knowingly collect data from minors because we do not collect any data at all.

## Data retention and deletion

**You** control retention. Your hub stores data in SQLite on your disk. To delete:

```bash
# Stop the hub
docker compose down

# Delete the volume (Hub data + vault + audit log)
docker volume rm pdatahub-hub-data

# Or for self-hosted installs:
rm ~/.local/share/pdatahub/hub.db
rm -rf ~/.local/share/pdatahub/backups/
```

Deleted data is gone from your hub immediately. We have no copies because we never had copies.

## Changes to this policy

If this policy changes, the diff will be in this repo's git history. We do not maintain a "previous versions" archive. Check the commit history if you care.

Material changes will also be announced in the [CHANGELOG](../CHANGELOG.md).

## Contact

- **GitHub:** [github.com/pdatahub/pdatahub/issues](https://github.com/pdatahub/pdatahub/issues) (public — do not post security issues here, use [SECURITY.md](../SECURITY.md))
- **Email:** TBD (`security@pdatahub.io` — pending provisioning)

## License

pdatahub is licensed under the MIT License. See [LICENSE](../LICENSE).

**THIS SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.** See [TERMS.md](./terms.md) for the full disclaimer.
