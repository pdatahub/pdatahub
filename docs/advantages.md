# Why pdatahub

A comparison of pdatahub with the alternatives, for engineers deciding what to build on. We focus on what's actually different — not features lists.

## At a glance

| | pdatahub | Composio | LangChain tools | Solid (W3C) |
|---|---|---|---|---|
| **Hosting** | Your laptop / server / cloud | Vendor's servers | Your code | Your pod |
| **Token storage** | You (AES-256-GCM, per-plugin key) | Vendor (single breach = all users) | In your code | On your pod |
| **Approval UX** | Native phone + biometric | Browser tab | None | None |
| **Grant lifetime** | Time-bounded (default 1h) | Permanent until revoked | Per-call | Per-call |
| **Cross-user delegation** | Federation v2 (Ed25519 signed) | None | None | Web Access Control |
| **Plugin ecosystem** | Open-source, GitHub Releases | Closed marketplace | Hand-rolled | Pod-specific |
| **AI-first design** | Native (MCP-native) | Retrofitted | Native | Data-first, no AI UX |
| **Pricing** | Free (self-hosted), $5/mo Cloud | Per-invocation + plan | Free (DIY) | Free (DIY) |
| **Open-source** | MIT | No | MIT | MIT |
| **Phone-mediated approval** | ✅ | ❌ | ❌ | ❌ |
| **Federation** | ✅ | ❌ | ❌ | Limited |

## Detailed comparisons

### vs Composio (commercial SaaS)

Composio is the closest commercial competitor: managed OAuth tokens + tool calling for AI agents. Same problem space, opposite design.

| Dimension | Composio | pdatahub |
|-----------|----------|---------|
| **Hosting model** | Vendor-managed. You give them OAuth tokens; they give you tool calls. | Self-hosted by default. Cloud v3 (in development) is a managed option but you can self-host forever. |
| **Token storage** | Vendor's database. A Composio breach = every user's tokens exposed. You trust them with the keys to your Google account. | Your laptop's encrypted SQLite. AES-256-GCM with HKDF per-plugin key. Even if one plugin is compromised, others aren't. |
| **Approval UX** | Browser tab. The user clicks "Allow" in a web UI, not in their normal workflow. | Native phone notification. Taps Approve with biometric. Sub-second latency. |
| **Grant lifetime** | Permanent until manually revoked. Most users never revoke. | Time-bounded (default 1h, lazy expiration). Grants auto-expire; old access disappears. |
| **Cross-user delegation** | None. User A's tokens cannot be shared with User B's AI agent. | **Federation v2.** User A delegates `listEvents` to User B with a single-tool scope; B's AI agent can call A's calendar; A's phone approves each call. |
| **Plugin ecosystem** | Closed marketplace. Composio curates which plugins exist. You can't install an unapproved plugin. | Open source. Anyone can write a plugin, distribute via GitHub Releases, install via `pdatahub-hub plugin install <url>`. |
| **AI-first design** | Retrofitted. Composio existed before MCP; it added tool calling as an API. | Native. MCP-native from day 1. The protocol is the architecture. |
| **Pricing** | Per-invocation + plan. Costs scale with usage. | Free (self-hosted). Cloud v3 will charge ~$5/mo for managed hosting — a fraction of Composio's per-call pricing. |
| **Open-source** | No. Closed source, opaque internals. | MIT. All code public. Security model documented. |
| **Vendor lock-in** | Total. Migrating away means re-authenticating every plugin. | None. Hub-core is a single binary you can move to any host. |

**When Composio is better:**
- You want zero setup. Sign up, paste tokens, get tool calls. pdatahub requires you to install hub-core and configure Tailscale.
- You need 100+ pre-built integrations today. Composio's marketplace is broader.
- Your AI agents don't care about audit trails.

**When pdatahub is better:**
- Privacy matters. Tokens never leave your hardware.
- You want per-action approval on your phone.
- You need cross-user delegation (federation).
- You want time-bounded grants by default.
- You want to read and modify the source code.
- You're building a multi-agent system where audit trails matter.

### vs LangChain tools (DIY)

Most teams start by writing tool-calling wrappers around `fetch()` and dropping OAuth tokens into environment variables. It works until it doesn't.

| Dimension | LangChain-style tools | pdatahub |
|-----------|----------------------|---------|
| **Where tokens live** | In your code's environment variables or a `.env` file. Visible to anyone with shell access. | Encrypted in hub's vault. Never visible to the AI agent or plugin. |
| **Approval UX** | None. Tool runs immediately. | Per-call phone approval with biometric. |
| **Revocation** | Rotate the API key everywhere. Painful. | Tap "Revoke" in the Android app. Instant, surgical. |
| **Audit log** | Whatever you wire up. Most teams don't. | Append-only SQLite. Every call recorded. |
| **Plugin sharing** | Hand-copy the wrapper between projects. | `pnpm --filter plugin install <github-release-url>` |
| **Token leakage** | If your laptop is compromised, all tokens are visible in plaintext. | Master key in memory only; tokens encrypted at rest. |

**When LangChain tools are better:**
- Prototyping. Faster to get something working.
- Single-agent, single-user, no audit requirements.
- You already have a token store you trust.

**When pdatahub is better:**
- Production deployment with multiple agents or users.
- Tokens must survive a breach of one component.
- Audit trail is a compliance requirement.
- You're tired of managing `.env` files.

### vs Solid (W3C standard)

[Solid](https://solidproject.org/) is a W3C standard for personal data pods. Each user owns a pod (a personal server), apps request access via Web Access Control.

| Dimension | Solid | pdatahub |
|-----------|-------|---------|
| **Mental model** | Data pods. Apps read/write to your pod. | Tools. AI agents call tools; the tool executes on the external service. |
| **AI integration** | None. Solid is data-first; AI agents are an afterthought. | Native. MCP-native from day 1. |
| **Approval UX** | Web Access Control — apps get blanket access per resource. | Per-call phone approval, scoped to one tool invocation. |
| **OAuth complexity** | You bring your own client_id to every service. | Hub runs the OAuth dance; plugins don't see credentials. |
| **Federation** | "Pod-to-pod" sharing. Works but is web-spec-shaped. | Federation v2 with explicit grants and per-call approval. Tool-scoped, not data-scoped. |
| **Plugin ecosystem** | Apps read/write to your pod. No "plugins" — apps are apps. | Plugins are subprocesses with scoped tool calls. |
| **Learning curve** | High. WAC, LDN, WebID, ... | Lower. Hub-core, plugin SDK, done. |

**When Solid is better:**
- You want a W3C standard with broad ecosystem support.
- Your use case is apps reading/writing your data, not AI agents calling tools.
- You're building for the long-term web platform, not the AI agent era.

**When pdatahub is better:**
- AI agents are the primary consumer.
- You want phone-mediated approval.
- You don't want to learn WAC.

### vs EUDI Wallet (EU government)

[EUDI Wallet](https://ec.europa.eu/digital-building-blocks/sites/display/EUDIGITALIDENTITYWALLET) is the EU's digital identity wallet. Government-issued, identity-focused.

| Dimension | EUDI Wallet | pdatahub |
|-----------|-------------|---------|
| **Issuer** | EU member state government | Self |
| **Use case** | Prove identity, share verified claims, sign documents | Approve AI agent tool calls |
| **Onboarding** | Identity verification, eIDAS compliance, government app | `pnpm install` |
| **Cryptography** | Same primitives (Ed25519, AES-256-GCM, HKDF) — we use the same building blocks | Same |
| **AI integration** | None | Native MCP |
| **Federation** | Cross-border via eIDAS | Federation v2 with explicit grants |
| **Trust model** | Government-issued | Self-issued |
| **Pricing** | Free (subsidized) | Free (self-hosted) / $5/mo (Cloud) |

**When EUDI Wallet is better:**
- You need to prove identity to a government or bank.
- You need a credential that a regulated entity accepts.
- You're in the EU and have an eID.

**When pdatahub is better:**
- You want to approve AI agent tool calls, not prove your identity.
- You're not in the EU.
- You don't want to share your government ID with a vendor.

### vs Digi.me

Digi.me is a closed-source personal data vault. Similar philosophy (you own your data), opposite execution.

| Dimension | Digi.me | pdatahub |
|-----------|---------|---------|
| **Hosting** | Vendor's cloud (with end-to-end encryption they claim they can't break) | Your hardware |
| **Source code** | Closed | MIT, public |
| **AI integration** | None | MCP-native |
| **Phone approval** | App-based but no biometric step | Native biometric |
| **Federation** | None | Federation v2 |
| **Pricing** | Freemium | Free (self-hosted) / $5/mo (Cloud) |

**When Digi.me is better:**
- You want a polished consumer app with zero setup.
- You don't need to inspect the source code.

**When pdatahub is better:**
- Source code matters.
- AI agents are the use case.
- You want federation.

## What makes pdatahub specifically different

These are the unique properties — features that none of the alternatives above offer in combination.

### Phone-mediated approval

Every tool call triggers a native push notification on your Android phone. You tap Approve or Deny. If biometric is enabled, the OS prompts for fingerprint/face. Sub-second latency verified end-to-end (~5s including the full MCP→events flow).

This UX pattern **does not exist** elsewhere. Composio uses browser tabs. LangChain has no approval. Solid has no approval. EUDI Wallet requires opening the government app.

The closest analog is mobile banking: tap a notification, biometric check, action proceeds. We've taken that pattern and applied it to AI agent tool calls.

### Federation v2 (cross-user AI agent coordination)

Two trusted hubs can share a single plugin tool. User A delegates `listEvents` (read-only) from A's Google Calendar plugin to User B's hub. B's AI agent invokes it; **A's phone approves each call**; A's token never crosses the hub boundary.

This is a novel primitive. There is no commercial or open-source equivalent at the time of writing. Composio doesn't do it. LangChain doesn't do it. Solid's pod-to-pod is web-spec-shaped and doesn't have per-call approval.

Use cases:

- A freelancer shares calendar availability with their assistant's AI agent.
- A small team shares a Notion workspace across multiple agents with per-action approval.
- A family member shares location (with their plugin) without giving the other person's AI agent blanket access.

The technical details are in [docs/federation.md](./federation.md) and [docs/threat-model.md §Federation inbound security](./threat-model.md#federation-inbound-security-13-steps).

### AI-first architecture

pdatahub was designed for AI tool calls from day 1. The plugin SDK is built around `@Tool` decorators, MCP-native transports, and JSON-RPC over stdio. There is no legacy HTTP API to layer on; no JSON-LD context negotiation; no XML namespace.

Compare with Composio, which existed as a general "integrations platform" before MCP existed. They added tool calling as an API on top.

The consequence: pdatahub's plugin SDK is ~30 lines for a working tool. A typical Composio integration is more.

### Self-hostable AND cloud-ready

The same binary runs on your laptop, on your home server, on a Raspberry Pi, or on a Hetzner VM managed by us. The protocol is identical; the deployment topology differs.

This is unusual. Most projects pick one (self-hosted or SaaS) and exclude the other. We pick both because:

1. **Personal use cases** want self-hosting. Trust and privacy matter; paying a vendor doesn't.
2. **Team / non-technical user cases** want managed hosting. They don't want to install hub-core.
3. **Migration should be trivial.** A user can self-host, then switch to Cloud, then switch back. Same data, same plugins.

## When NOT to use pdatahub

We are honest about our limits.

- **You need 100+ pre-built integrations today.** Composio's marketplace is broader.
- **You don't have a phone.** Hub assumes phone-mediated approval. A pure-desktop flow is on the roadmap but not shipped.
- **You're building a regulated identity product.** Use EUDI Wallet or a government-grade system. We're not that.
- **You need WebAuthn-grade authentication today.** WebAuthn for hub-core admin actions ships in v3.5, not today.
- **You need per-tenant encryption keys in a managed cloud product.** Cloud v3 ships with shared master key; per-tenant keys are v3.1.

## References

- [README.md](../README.md) — overview and quick start
- [docs/architecture.md](./architecture.md) — protocol and component design
- [docs/threat-model.md](./threat-model.md) — what we protect against and what we accept as residual risk
- [docs/federation.md](./federation.md) — federation v2 user guide
- [docs/self-hosting.md](./self-hosting.md) — running hub-core on your own hardware