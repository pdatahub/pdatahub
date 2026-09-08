**Status:** `draft`
**Date:** 2026-09-08
**Domain:** `work`
**Tags:** `#project/pdatahub`

# Personal Data Hub — Cloud v3 Design

> **TL;DR:** Multi-tenant SaaS на базе self-hosted pdatahub. Один юзер = одна VM с собственным hub-core instance, своей SQLite БД, своими плагинами. Federation v2 интероп полный (cloud↔self-hosted). Auth через Google OAuth. Pricing $5/mo + free tier. Infrastructure runner на Go. Region: Hetzner Cloud (EU + US East). Это **adoption story**, не core architecture — cloud-юзеры используют те же SDK, тот же MCP server, ту же Federation protocol.

---

## Architectural decisions (locked 2026-09-08)

| Decision | Choice | Why |
|----------|--------|-----|
| Multi-tenancy | **DB-per-user + dedicated VM** | Полная isolation, проще security audit, легко debug. Multi-tenant DB добавляет сложности без явной выгоды на этом масштабе |
| Infrastructure | **Hetzner Cloud (Falkenstein + Ashburn)** | EU compliance для GDPR, цены в 3-5x ниже AWS, snapshot-based backups. US East для latency |
| VM size | **CX22 (4GB RAM, 2 vCPU, 40GB SSD)** — €4.5/mo | Hub-core + plugin runtime + SQLite = ~300MB RSS, room for headroom |
| Plugin isolation | **Subprocess model (как сейчас)** | Дёшево, проверено в self-hosted. V8 isolates — v4 если понадобится |
| Runner | **Go binary на control plane** | SSH к VMs, авто-deploy hub-core, snapshot management, health checks. ~1500 LOC |
| Auth | **Google OAuth для sign-in** | Минимум friction. Email/password + WebAuthn — v3.1 |
| Data location | **EU по умолчанию, opt-in US** | GDPR first. Юзеры выбирают при signup |
| Pricing | **$5/mo Starter + Free tier (1 plugin)** | Unit economics: €4.5/mo infra + margin = $5 sustainable |
| Domain | **`hub.pdatahub.io`** ✅ locked 2026-09-08 | Cloudflare Pages (бесплатно), юзеры получают `userX.hub.pdatahub.io` через MagicDNS |
| Region strategy | **EU only first** ✅ locked 2026-09-08 | Hetzner Falkenstein (DE). US East (Ashburn) добавим когда будут US-юзеры |
| Repo layout | **`packages/runner/` в monorepo** ✅ locked 2026-09-08 | Go binary в существующем monorepo pdatahub/pdatahub, общий CI/release |

## Architecture

```
                          ┌─────────────────────────────┐
                          │  Control Plane (Go runner)  │
                          │  - User signup via OAuth    │
                          │  - VM provisioning          │
                          │  - hub-core deploy          │
                          │  - Health monitoring        │
                          │  - Billing (Stripe)         │
                          └──────────────┬──────────────┘
                                         │ SSH + cloud-init
                ┌────────────────────────┼────────────────────────┐
                ▼                        ▼                        ▼
        ┌──────────────┐          ┌──────────────┐          ┌──────────────┐
        │ user1 Hetzner│          │ user2 Hetzner│          │ user3 Hetzner│
        │ CX22 EU      │          │ CX22 EU      │          │ CX22 US East │
        │              │          │              │          │              │
        │ ┌──────────┐ │          │ ┌──────────┐ │          │ ┌──────────┐ │
        │ │hub-core  │ │          │ │hub-core  │ │          │ │hub-core  │ │
        │ │SQLite    │ │          │ │SQLite    │ │          │ │SQLite    │ │
        │ │Plugin    │ │          │ │Plugin    │ │          │ │Plugin    │ │
        │ │runtime   │ │          │ │runtime   │ │          │ │runtime   │ │
        │ │+ MagicDNS│ │          │ │+ MagicDNS│ │          │ │+ MagicDNS│ │
        │ │host name │ │          │ │host name │ │          │ │host name │ │
        │ └──────────┘ │          │ └──────────┘ │          │ └──────────┘ │
        │ user1.hub... │          │ user2.hub... │          │ user3.hub... │
        └──────────────┘          └──────────────┘          └──────────────┘
              │                          │                          │
              └──────────────────────────┴──────────────────────────┘
                                         │
                              Tailscale mesh (как self-hosted)
                                         │
                            Federation v2 cross-user
```

Каждый cloud-юзер = виртуально self-hosted юзер с hub-core + SQLite + plugin runtime. Единственная разница:
- VM provisioning через runner (не руками)
- Auth через control plane (не локальный)
- Billing через Stripe (не самообслуживание)
- HTTPS через Tailscale Serve runner-side (не самостоятельная настройка)

## Phased rollout

### Phase 0 — Design + decisions lock (1-2 дня)
- [ ] Domain decision: `hub.pdatahub.io` vs `pdatahub.cloud`
- [ ] Hetzner Cloud account + project setup (api token)
- [ ] Stripe account (test mode)
- [ ] Google OAuth client for sign-in (separate from per-plugin OAuth)
- [ ] Tailscale tailnet for `cloud.pdatahub.io`
- [ ] Cloud v3 design doc (this file) — Momus review
- [ ] Threat model: shared OAuth client risk vs per-user
- [ ] Backup strategy: Hetzner Snapshots daily (retain 7) + nightly SQLite dump to S3-compatible storage

### Phase 1 — Control plane runner (5-7 дней)

**Phase 1A (skeleton) ✅ DONE 2026-09-08** — commit `3d92677`, 22 files, 41 tests, 93.5% coverage
- [x] Go module `packages/runner/` в monorepo
- [x] Hetzner Client interface + MockHetzner (deterministic IDs, injectable errors, race-safe)
- [x] SSH key generation (ed25519, OpenSSH format, ParseAuthorizedKey roundtrip)
- [x] cloud-init script generator (idempotent, golden-file test)
- [x] Hub-core deploy PLANNER (Step[] — не executor)
- [x] Core types (User, VM, HubInstance, Region enum)
- [x] CLI entry point с `--dry-run` (default true)
- [x] Makefile (build/test/test-race/cover/vet/tidy/clean)
- [x] CI workflow: новый `go-runner` job gated на `packages/runner/**`

**Phase 1B (real integration) ⏳ blocked on Hetzner API token**
- [ ] Hetzner Cloud API client (hcloud-go) — реальный client вместо Mock
- [ ] SSH executor: SCP tarball → install → systemd enable --now → verify /health
- [ ] Health monitor: ping /v1/identity каждые 30s, restart если down
- [ ] Public API: `POST /v1/cloud/users` (admin) → create VM + return MagicDNS hostname
- [ ] Snapshot management (Hetzner Snapshot API для daily backups)
- [ ] Integration test: реальная CX11 VM (€3.5/mo — дешевле для тестов чем CX22)

### Phase 2 — Sign-up flow + auth (3-5 дней)
- [ ] Static landing page: `hub.pdatahub.io` (Cloudflare Pages, Next.js)
- [ ] Google OAuth client_id для sign-in (NOT plugin OAuth — отдельный!)
- [ ] `POST /v1/auth/google` callback → JWT → cookie
- [ ] Free tier check (если юзер уже есть)
- [ ] Trigger Phase 1 runner.createUserVM(email)
- [ ] Email verification (magic link, optional для free tier)

### Phase 3 — Billing + quotas (3-4 дня)
- [ ] Stripe Customer + Subscription на signup
- [ ] Webhook handler: subscription cancelled → runner.destroyUserVM (after grace period)
- [ ] Free tier: 1 plugin, 100 calls/day, 100MB storage
- [ ] Quota enforcement: hub-core reads `quota.json` from cloud metadata endpoint
- [ ] Upgrade flow: `/settings/billing` → Stripe Checkout

### Phase 4 — Per-plugin OAuth simplification (2-3 дня)
- [ ] Shared OAuth client (one google-calendar client для всех cloud-юзеров) vs per-user
  - **Decision needed**: shared = simpler UX (один consent screen для всего hub.pdatahub.io), но security implication если наш secret leaked → все юзеры compromised
  - **Per-user** = стандартный OAuth flow, юзер сам вводит свои credentials (или делает consent через свой Google account на нашем authorized domain)
- [ ] Plugin catalog (curated subset) — только проверенные plugins на cloud

### Phase 5 — Federation interop (1-2 дня)
- [ ] Cloud-юзер federation discovery: peer URL `userX.hub.pdatahub.io:8080` через MagicDNS
- [ ] Mixed-mode test: cloud юзер A delegates self-hosted юзеру B → call works
- [ ] Reverse: self-hosted A delegates cloud B → call works
- [ ] Audit log forwarding: оба пишут в свою БД, cross-hub reconcile

### Phase 6 — Polish + launch (3-5 дней)
- [ ] HTTPS everywhere (Tailscale Serve на runner side, не на юзер VM)
- [ ] Monitoring: Grafana cloud или self-hosted (Hetzner)
- [ ] Status page: status.hub.pdatahub.io
- [ ] Onboarding tour в Android app
- [ ] Privacy policy + ToS
- [ ] Backup restore drill (еженедельно)
- [ ] Pricing page

**Total estimate: 18-26 дней (4-5 недель)**

## Open decisions (need user input before Phase 1)

1. ✅ **Domain**: `hub.pdatahub.io` (locked 2026-09-08)
2. ✅ **Region**: EU only first (locked 2026-09-08)
3. ✅ **Repo layout**: `packages/runner/` в monorepo (locked 2026-09-08)
4. ⏳ **Shared OAuth client** для plugins — риск vs UX tradeoff (Phase 4)
5. ⏳ **Discovery** для cloud-юзеров: central directory нужен? (Phase 5)

## Что не входит в MVP slice

- iOS app (только Android пока)
- Web UI для Hub (только Android app + landing page для signup)
- V8 isolate plugin runtime (deferred)
- Key rotation (`key_epoch` deferred до v3.1)
- Per-tenant encryption keys (shared master key OK для MVP, миграция в v3.1)
- WebAuthn (deferred)
- Multi-region failover (deferred)

## Связанные

- [[pdatahub — Implementation Progress]] — Phase-by-phase log
- [[Personal Data Hub — Architecture Decisions]] — общие architecture решения
- [[Personal Data Hub — Project Structure & Repo Organization]] — repo layout (нужно решить: новый repo `pdatahub-cloud` или subpackage в monorepo?)
- [[Personal Data Hub — Overview]] — что такое pdatahub
