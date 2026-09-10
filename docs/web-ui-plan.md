# pdatahub Web UI — Implementation Plan

> **Status:** Planning. Makefile shipped (`0098de2`). Web UI builds per phased roadmap below, starting after public launch + first round of feedback (so we prioritize pages users actually need).

## Goals

1. **Reduce first-run friction** from "install Node + Android app + pair devices" (~45 min) to "docker compose up + open browser" (~1 min)
2. **Approval parity** — anyone with a browser can approve tool calls; Android remains for power users with biometric
3. **Reduce support load** — visual plugin install, settings, audit log explorer replace CLI acrobatics
4. **PWA-ready** — web UI installs as phone/desktop app, gradually replaces Android app long-term

## Non-goals

- No native desktop app (Electron, Tauri) — web is enough
- No rich plugin marketplace UI in v1 — install via URL paste is fine
- No federation UI in v1 — CLI is sufficient for the ~5% of users who need it
- No replacing Android app immediately — web is complementary entry point

## Architecture decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Repo location | Monorepo (`packages/web/`) | Coordinate with hub-core API changes; one PR for full-stack changes |
| Deployment model | Static SPA embedded in hub-core Docker image | One container, one port (8080), no CORS, simplest self-host |
| Framework | SvelteKit + adapter-static | 40 KB runtime (vs React 140 KB); less boilerplate; great for self-hosted tools |
| API integration | Reuse existing `/v1/*` REST endpoints — no new backend | mcp-server already proves the API surface works |
| WebSocket | Reuse `/approval-stream` — no new protocol | Same endpoint Android app uses |
| URL structure | `/` for web UI, `/v1/*` for API, `/approval-stream` for WS | Cleaner separation; existing API stays at v1 prefix |
| Auth (localhost) | None — same-machine access only | No threat model: physical access = root access |
| Auth (exposed) | PIN + optional WebAuthn (browser biometric) | WebAuthn supports Touch ID, Face ID, Windows Hello — real biometric on web! |
| Session | HttpOnly + SameSite=Strict cookie, 15-min TTL | Standard secure pattern |
| Storage | None — pure SPA, all data from `/v1/*` | No IndexedDB needed for v1 |

## File structure

```
packages/web/
├── src/
│   ├── routes/                       # SvelteKit file-based routing
│   │   ├── +layout.svelte           # global shell (header, nav, status indicator)
│   │   ├── +layout.ts               # load session on every nav
│   │   ├── +page.svelte             # dashboard (uptime, grants, recent activity)
│   │   ├── approval/+page.svelte    # full-screen approval tray + history
│   │   ├── plugins/
│   │   │   ├── +page.svelte         # list + status
│   │   │   └── install/+page.svelte # paste GitHub release URL → install
│   │   ├── audit/+page.svelte       # searchable + filterable + exportable
│   │   ├── settings/+page.svelte    # API token, PIN, network info
│   │   ├── onboarding/+page.svelte  # first-time wizard
│   │   └── unlock/+page.svelte      # PIN entry (for exposed deployments)
│   ├── lib/
│   │   ├── api.ts                   # typed wrappers for /v1/*
│   │   ├── ws.ts                    # WebSocket client for /approval-stream
│   │   ├── auth.ts                  # session/PIN/WebAuthn helpers
│   │   ├── format.ts                # time/duration/byte formatters
│   │   ├── components/
│   │   │   ├── ApprovalCard.svelte      # pending approval request UI
│   │   │   ├── PluginCard.svelte        # one plugin + its tools
│   │   │   ├── AuditTable.svelte        # paginated, filterable audit rows
│   │   │   ├── StatPill.svelte          # small KPI tile
│   │   │   ├── ConnectionStatus.svelte  # hub online/offline + API token
│   │   │   └── EmptyState.svelte        # zero-data CTAs
│   │   └── stores/
│   │       ├── session.ts               # writable store: session + token
│   │       ├── approvals.ts             # pending approval queue
│   │       └── toasts.ts                # ephemeral notifications
│   ├── app.html                     # SvelteKit app template
│   └── app.css                      # global styles (CSS vars + reset)
├── static/
│   ├── favicon.svg
│   ├── icon-192.png
│   ├── icon-512.png
│   └── manifest.webmanifest
├── tests/
│   ├── unit/                        # vitest + @testing-library/svelte
│   │   ├── api.spec.ts
│   │   ├── auth.spec.ts
│   │   └── components/
│   └── e2e/                         # Playwright
│       ├── dashboard.spec.ts
│       ├── approval.spec.ts
│       └── plugin-install.spec.ts
├── package.json
├── tsconfig.json
├── svelte.config.js                 # adapter-static, fallback: index.html
├── vite.config.ts
├── playwright.config.ts
├── .npmrc                           # node-linker=hoisted (pnpm 9 fix)
└── README.md
```

## Build integration (Docker)

`Dockerfile` changes — add web build stage:

```dockerfile
# Stage 2.5 — web UI
FROM deps AS web-build
WORKDIR /repo
COPY packages/web/package.json ./packages/web/
RUN pnpm install --frozen-lockfile --filter @pdatahub/web...
COPY packages/web/ ./packages/web/
RUN pnpm --filter @pdatahub/web run build    # → packages/web/build/

# Stage 3 — runtime
FROM node:20-alpine AS runtime
# ... existing runtime setup ...
COPY --from=web-build --chown=node:node /repo/packages/web/build ./web
```

`hub-core` server.ts — serve static files:

```typescript
const WEB_DIR = join(import.meta.dirname ?? '', 'web');

private async serveWebUi(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (!existsSync(WEB_DIR)) return false;  // no web UI built yet — fall through to 404
  const urlPath = new URL(req.url ?? '/', 'http://localhost').pathname;
  const filePath = join(WEB_DIR, urlPath === '/' ? 'index.html' : urlPath);
  // Serve file if it exists, otherwise SPA fallback (client-side routing).
  const target = existsSync(filePath) && statSync(filePath).isFile()
    ? filePath
    : join(WEB_DIR, 'index.html');
  const mime = MIME[extname(target)] ?? 'application/octet-stream';
  res.setHeader('content-type', mime);
  res.setHeader('cache-control', urlPath === '/' ? 'no-cache' : 'public, max-age=3600');
  res.end(readFileSync(target));
  return true;
}
```

In `handleRequest`: try API route → try WS → try static web → 404.

## Auth model

### Localhost (default)

- No auth — same machine, physical access = root access
- Web UI just shows the hub, no prompts

### Exposed (Tailscale / Cloud v3 / public IP)

**Setup flow (first run on non-loopback):**
1. Hub detects bind address is not loopback
2. Hub generates a 6-digit PIN, prints to entrypoint logs
3. Web UI shows "Enter PIN" screen → validates → sets session cookie
4. Cookie: `HttpOnly; Secure; SameSite=Strict; Max-Age=900` (15 min)

**WebAuthn (optional, opt-in per browser):**
1. After PIN login, user sees "Register this device" prompt
2. Browser's WebAuthn API generates a keypair (private key never leaves the device)
3. Public key + credential ID stored in hub vault
4. Next login from same browser → fingerprint/Face ID/PIN prompt, no PIN entry needed
5. Same browser experience as Android biometric — full biometric via platform authenticator

**Backend endpoints (new):**
- `POST /v1/auth/setup-pin` — first-time setup (requires X-Hub-Setup-Token header with HUB_API_TOKEN)
- `POST /v1/auth/pin` — verify PIN, set session cookie
- `DELETE /v1/auth/session` — clear cookie
- `POST /v1/auth/webauthn/register/start` — begin registration (requires session)
- `POST /v1/auth/webauthn/register/finish` — store credential (requires session)
- `POST /v1/auth/webauthn/login/start` — generate auth challenge
- `POST /v1/auth/webauthn/login/finish` — verify signed challenge, set session

**Session cookie:** signed JWT (HMAC-SHA256 with HUB_MASTER_KEY), claims: `{ sub: 'web-ui', iat, exp }`. 15-min TTL, refresh on activity.

## Phased roadmap

### Phase 1 — Scaffold + Approval (week 1)

| Day | Deliverable |
|-----|-------------|
| 1 | SvelteKit scaffold (`packages/web/`), TypeScript + Vite, adapter-static, vitest setup |
| 1 | `lib/api.ts` typed wrappers for `GET /v1/tools`, `GET /v1/identity`, `GET /health` |
| 2 | `lib/ws.ts` WebSocket client for `/approval-stream` |
| 2 | `lib/stores/approvals.ts` — pending queue store |
| 2 | `<ApprovalCard>` component (Allow 1h / Allow once / Deny buttons) |
| 3 | `/approval` page — full-screen tray + history |
| 4 | `/` dashboard page (stat pills: uptime, active grants, plugins installed) |
| 5 | Layout shell (header with hub status indicator + nav) |
| 5 | Tests: api.spec.ts, components/ApprovalCard.spec.ts |

**Phase 1 exit criteria:** Click approve on a test tool call, see request → approve → audit row.

### Phase 2 — Plugins + Audit (week 2)

| Day | Deliverable |
|-----|-------------|
| 1 | `<PluginCard>` + `/plugins` page (calls `GET /v1/tools`) |
| 2 | `/plugins/install` page — paste GitHub release URL → POST → restart |
| 2 | Backend: `POST /v1/plugins/install` endpoint (if not already in hub-core) |
| 3 | `<AuditTable>` component with pagination, filters (date, plugin, decision) |
| 3 | `/audit` page (calls `GET /v1/audit` with query params) |
| 4 | Export to CSV button (calls new `GET /v1/audit/export` endpoint) |
| 5 | Tests: components/AuditTable.spec.ts, e2e/plugin-install.spec.ts |

**Phase 2 exit criteria:** Install plugin via UI, see it appear in plugin list, query audit log via UI.

### Phase 3 — Settings + PIN auth + Onboarding (week 3)

| Day | Deliverable |
|-----|-------------|
| 1 | Backend: `/v1/auth/setup-pin`, `/v1/auth/pin`, `/v1/auth/session` |
| 2 | `/unlock` page — PIN entry with backoff |
| 2 | `/settings` page — regenerate API token, change PIN, see master_key fingerprint |
| 3 | `/onboarding` wizard (first-time setup): welcome → install first plugin → success |
| 4 | Session cookie middleware (server-side: validate JWT on every /v1/* except public) |
| 4 | Tests: auth.spec.ts (JWT sign/verify, PIN hashing with bcrypt) |

**Phase 3 exit criteria:** First-run wizard on non-loopback bind → set PIN → dashboard accessible. Restart hub → PIN still works.

### Phase 4 — WebAuthn + Polish + Docker + PWA (week 4)

| Day | Deliverable |
|-----|-------------|
| 1 | Backend: WebAuthn register/login endpoints (using `@simplewebauthn/server`) |
| 2 | Frontend: "Register this device" UI after PIN login |
| 3 | Dark/light theme toggle (respects `prefers-color-scheme`) |
| 3 | Mobile-responsive layout (test on phone viewport) |
| 4 | Dockerfile multi-stage web build |
| 4 | `hub-core` serves `/ui/*` from static dir |
| 5 | PWA manifest + service worker (`/manifest.webmanifest`) |
| 5 | "Install as app" button on dashboard (uses `beforeinstallprompt`) |

**Phase 4 exit criteria:** `make up` boots hub → open browser → PWA install prompt → biometric login → app installed on phone home screen.

### Phase 5 — Federation UI + Marketplace (post-launch, weeks 5+)

- `/federation` page — manage delegations (list, revoke, view peer info)
- `/marketplace` page — browse community plugins (fetches from GitHub topic `pdatahub-plugin`)
- Per-plugin config UI (e.g. Google Calendar: choose which calendar)
- Theme customization

**Phase 5 exit criteria:** Federation user can complete entire flow in browser without touching CLI.

## Risk register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| SvelteKit adapter-static SPA breaks on hub-core URL routing | Medium | High | Test all routes (especially `/approval`, `/plugins/install/abc-123`) work via SPA fallback before merge |
| WebAuthn complexity | High | Medium | Use battle-tested `@simplewebauthn/server` lib; degrade gracefully to PIN-only |
| Static file serving breaks Docker volume mount | Medium | High | Test multi-stage build → `docker compose up` → all assets load in `<10ms` |
| Plugin install UI needs backend changes (CLI → HTTP) | High | Medium | Already have `POST /v1/federation/delegate` pattern — copy for `/v1/plugins/install` |
| PWA service worker caching stale assets | Low | Medium | Use cache-busting `index.html`; hash-bust static assets in adapter-static |
| Users confuse "no auth on localhost" with "no auth on exposed" | Medium | High | Big banner on settings page when HUB_NOT_LOOPBACK; force PIN setup |

## Testing strategy

- **Unit**: vitest + @testing-library/svelte for components + stores
- **E2E**: Playwright drives real browser against hub-core test instance (in-process)
- **Visual regression**: Playwright screenshots on every PR
- **Manual**: Browserstack or local on Chrome/Firefox/Safari (desktop + mobile viewports)
- **Accessibility**: axe-core in Playwright (WCAG 2.1 AA target)
- **Performance**: Lighthouse CI on every PR (target: Performance ≥95, Accessibility ≥95)

## Open decisions (deferrable)

| Decision | Default | Revisit when |
|----------|---------|--------------|
| Service worker caching strategy | Cache-first for static, network-first for API | After 100+ active users |
| Internationalization (i18n) | English only | When non-English users request it |
| Custom theming per user | Single dark theme | When design team exists |
| Plugin config UI (per-plugin settings) | Generic "edit JSON" form | When 5+ plugins need config |
| Plugin marketplace (browse community) | None (URL install only) | When 30+ plugins exist |

## Integration with existing launch

**Before launch:**
- ✅ Makefile shipped (`0098de2`) — immediate win
- ⏳ Demo video (3-min Loom)
- ⏳ HN submit + Reddit posts

**After first feedback (~2 weeks post-launch):**
- Start Phase 1 (1 week)
- Phase 2-4 follow based on user feedback (which pages do users actually need?)

**Why not build web UI before launch:**
- Don't ship untested feature on day 1
- Real user feedback tells you which pages matter (avoid building unused pages)
- 2 weeks of build after launch = web UI ready for "v0.4" announcement

## Success metrics (6 months post-web-UI)

| Metric | Target | Why |
|--------|--------|-----|
| % users using web UI vs Android | 60% web, 40% Android | If 90% web, deprecate Android |
| Time to first tool call (new users) | < 1 minute | Currently ~45 min |
| Plugin installs via UI | 80%+ | If 80% via UI, CLI is power-user-only |
| Approval latency (click → tool runs) | < 2 seconds | Sub-second UX wins trust |
| WebAuthn adoption (exposed deployments) | 30%+ | Proves biometric-on-web is wanted |
| Support tickets ("how do I...?") | -50% vs CLI-only | Visual UI should reduce basic questions |
