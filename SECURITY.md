# Security Policy

## Supported versions

We are pre-1.0 (`v0.x`). Security fixes land on `main` and are backported only to the most recent minor. Older minors are not maintained.

| Version | Supported |
|---------|-----------|
| `main` (unreleased) | ✅ |
| `v0.1.x`            | ✅ |
| `v0.0.x`            | ❌ |

Once we ship `v1.0.0`, this table will track the latest three minor releases per the standard LTS window.

## Reporting a vulnerability

**Email:** [`security@pdatahub.io`](mailto:security@pdatahub.io) (TBD — pending provisioning; until then, see GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability) on this repository).

**GitHub:** Use the [private vulnerability report](https://github.com/pdatahub/pdatahub/security/advisories/new) form on this repository. This is encrypted and visible only to maintainers.

**Do not** open a public GitHub issue for security bugs. Issues labeled `security` will be closed without public comment.

## Disclosure timeline

We follow a **90-day coordinated disclosure** window:

| Day | Action |
|-----|--------|
| 0 | Acknowledgement of report (target: ≤48h) |
| 7 | Triage and severity assessment |
| 30 | Working patch available (for high/critical) |
| 60 | Patch tested and ready for release |
| 90 | Coordinated public disclosure |

We will negotiate extensions for valid reasons (e.g. complex exploit chains, dependent upstream fixes). We will not negotiate beyond 120 days.

We credit reporters in the patch release notes (unless you ask us not to). When the bug bounty program launches, reporters become eligible for bounty payment — see [Hall of fame](#hall-of-fame) below.

## Threat model summary

This section is the executive summary. The full table — assets, adversaries, trust boundaries, mitigations, out-of-scope items — lives in [docs/threat-model.md](./docs/threat-model.md).

### What we protect

1. **OAuth tokens** — your Google/Slack/Notion/etc. tokens, one encrypted entry per plugin.
2. **Grant data** — who approved what, when, for how long.
3. **Audit log** — append-only SQLite on the hub; single source of truth.
4. **User identity (Ed25519 hub key)** — for federation v2 cross-hub verification.
5. **Plugin source code integrity** — by sandbox and signing (signing deferred to v3.1).

### Adversaries we designed against

- **Compromised plugin** — semi-trusted; never sees raw OAuth token; can only act within granted scope.
- **Malicious AI agent** — must satisfy per-call phone approval; audit log records every decision.
- **Network attacker** — MITM between hub and external service mitigated by TLS; between hub and phone mitigated by WireGuard (Tailscale) or WSS-over-CF (relay).
- **Compromised phone** — can approve anything, but only with biometric prompt (when enabled) and is itself authenticated to the hub via session token.
- **Compromised laptop** — has direct access to tokens. This is the residual risk of self-hosting; see [docs/self-hosting.md §Security hardening](./docs/self-hosting.md#security-hardening).
- **Compromised peer hub (federation v2)** — see "Federation-specific" mitigations below.

### Security mechanisms (what's actually shipped)

| Mechanism | Status | Where |
|-----------|--------|-------|
| AES-256-GCM token vault with HKDF per-plugin keys | ✅ shipped | `packages/hub-core/src/vault.ts` |
| Plugin subprocess isolation (separate Node.js process) | ✅ shipped | `packages/hub-core/src/plugin-process.ts` |
| Per-action phone approval (WebSocket + biometric) | ✅ shipped | `packages/hub-core/src/approval-stream.ts` |
| Time-bounded grants (default 1h, lazy expiration) | ✅ shipped | `packages/hub-core/src/grant-store.ts` |
| Lazy revocation (<2s latency for next access denial) | ✅ shipped | `packages/hub-core/src/grant-store.ts` |
| Append-only audit log with WebSocket broadcast | ✅ shipped | `packages/hub-core/src/audit-log.ts` |
| OAuth injection via SDK `this.http` (plugin never sees raw token) | ✅ shipped | `packages/plugin-sdk/src/http-client.ts` |
| Federation v2 — Ed25519 signed delegation blobs | ✅ shipped | `packages/hub-core/src/federation/` |
| Federation v2 — 13-step inbound security on `/v1/federation/call` | ✅ shipped | `packages/hub-core/src/federation/call-handler.ts` |
| Federation v2 — nonce dedup, clock skew check, rate limit | ✅ shipped | `packages/hub-core/src/federation/nonces.ts` |
| Hard-fail on missing `HUB_API_TOKEN` when bound to non-loopback | ✅ shipped | `packages/hub-core/src/server.ts` |
| BIP-39 encrypted backup/restore | ✅ shipped | `packages/hub-core/src/backup.ts` |
| Proactive OAuth refresh (5 min before expiry) | ✅ shipped | `packages/hub-core/src/vault.ts` |

### Known limitations / out-of-scope (current)

These are **accepted residual risks** in v0.x, scheduled for later versions:

| Limitation | Mitigation today | Lands in |
|------------|------------------|----------|
| **V8 isolate plugin isolation** — plugins share Node.js global objects in the subprocess. A plugin that exploits a Node.js bug could potentially reach the hub process. | Subprocess isolation is in place; rely on Node.js security updates. | v4 (2027+) |
| **No per-tenant encryption keys** in Cloud v3 — all cloud users share one master key, with multi-VM isolation. | Physical VM isolation; master key is in memory only on each VM. | Cloud v3.1 |
| **No key rotation** (`key_epoch` field) — once you set a master key, you cannot rotate without re-issuing all tokens. | Users with compromised keys must do a BIP-39 backup restore on a fresh master key. | v3.1 |
| **No WebAuthn / phone OTP** for hub-core admin actions (init, restore). | Master key + BIP-39 mnemonic only. | v3.5 |
| **No plugin signature verification** — plugins are trusted by URL/path. | Distribute only via signed GitHub Releases; SHA256 in release notes. | v3.1 |
| **Tailscale dependency for phone approval** — if Tailscale is blocked, only USB tether works. | `adb reverse` fallback documented in [docs/self-hosting.md](./docs/self-hosting.md). Cloudflare Worker relay is shipped but in stub mode. | relay v1 (production hardening) |
| **Federation: no signed revocation broadcast** — when A revokes, B only learns on next call (`403 DELEGATION_REVOKED`). | B can manually delete the `peer_delegations` row. | v3 |
| **Federation: no perfect forward secrecy** — Ed25519 doesn't ratchet. | Per-call phone approval is the real backstop. If signing key is compromised, revoke all delegations and rotate. | v3.1 (`key_epoch`) |

See [docs/threat-model.md §Future hardening](./docs/threat-model.md#future-hardening) for the full roadmap.

### Federation-specific protections (v2)

When Hub B calls Hub A on behalf of an AI agent:

- **No raw OAuth token crosses the hub boundary.** A decrypts its own token from its own vault; B never sees it. The plugin subprocess on A's side receives the token via the SDK's `context.token` injection.
- **Per-call phone approval by default.** A's phone approves every federated call; there is no auto-grant for trusted peers in v2.
- **One tool per delegation.** Each delegation is a single `(plugin, tool, scope)` triple. No blanket "share my whole hub" in v2.
- **Out-of-band fingerprint verification.** When B accepts a delegation blob, the CLI prints the issuer's fingerprint; B must compare it against what A told them separately. Defense against forged blobs.
- **Defense in depth on `/v1/identity`.** Even if `/v1/identity` lies about a verify_key, the signed blob carries A's verify_key embedded; B verifies against the embedded key, not the endpoint.
- **Cross-hub audit.** Both sides log every call with `delegated_by` / `delegated_to` populated. Tampering requires compromising both hubs.
- **13-step inbound verification.** Signature → clock skew → nonce dedup → delegation lookup → peer match → approval stream check → 503 fast-fail if no approver connected. See [docs/threat-model.md §Federation inbound security](./docs/threat-model.md#federation-inbound-security-13-steps).

## Security audit history

| Date | Scope | Reviewer | Result |
|------|-------|----------|--------|
| 2026-09-07 | Federation v2 design (RFC-level) | Momus round 1 | 7 blockers, 5 spec contradictions, 10 important — **all addressed** |
| 2026-09-08 | Federation v2 design (final docs) | Momus round 2 | 4 final doc fixes — **applied** |
| 2026-09-08 | Cloud v3 design (Phase 1A) | Momus round 1 | OKAY — references verified, Phase 1A verified done |

Detailed findings are linked from `.omo/plans/federation-v2-design.md` and `.omo/plans/cloud-v3-design.md`. We plan to commission an external audit before v1.0.

## Hall of fame

Security reporters who helped pdatahub (alphabetical):

> _None yet — be the first._ When the bug bounty program launches (planned for v1.0), reporters listed here will be eligible for bounty payment.

## References

- [docs/threat-model.md](./docs/threat-model.md) — full threat model with adversaries, trust boundaries, mitigations
- [docs/architecture.md §Security model](./docs/architecture.md#security-model) — token vault, plugin isolation, approval flow
- [docs/federation.md §Threat model (TL;DR)](./docs/federation.md#threat-model-tldr) — federation-specific mitigations
- [docs/self-hosting.md §Security hardening](./docs/self-hosting.md#security-hardening) — deployment-side hardening (bind interfaces, firewall, master-key strength)
- [CONTRIBUTING.md](./CONTRIBUTING.md) — code style, test requirements, Momus review triggers

---

If you're an external security researcher and you find something we haven't, please email [security@pdatahub.io](mailto:security@pdatahub.io) — we respond fast, we credit public disclosure, and we pay bounties once the program is live.