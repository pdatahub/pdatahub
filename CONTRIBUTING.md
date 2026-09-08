# Contributing to pdatahub

Welcome — pdatahub is a privacy-first platform for personal data, and we're glad you're here. The goal of this document is to get a new contributor from zero to a merged pull request without surprises. The audience is senior engineers who can read code and RFCs; we assume you know how to use a terminal.

## Code of conduct

All contributors are expected to follow our [Code of Conduct](./CODE_OF_CONDUCT.md). Be direct, be technical, be kind. Disagreements are fine; rudeness is not.

## Security issues

**Do not open a public issue for security bugs.** Email [`security@pdatahub.io`](mailto:security@pdatahub.io) (TBD — see [SECURITY.md](./SECURITY.md)) or use GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability). See [SECURITY.md](./SECURITY.md) for the supported-versions table, disclosure timeline, and the threat model summary.

## Development setup

### Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| Node.js | 20+ | Hub-core, mcp-server, plugin-sdk, relay all run on Node |
| pnpm | 9+ | Workspace monorepo (`pnpm-workspace.yaml`) |
| JDK | 17 | Required for `android-app` |
| Go | 1.23 | Required for `runner` (Cloud v3 control plane) |
| Android SDK | API 35 + build-tools 35.0.0 | Optional unless you build the Android app |
| Tailscale | latest | Recommended for phone-mediated approval in development |

### Bootstrap

```bash
git clone https://github.com/pdatahub/pdatahub
cd pdatahub
pnpm install
pnpm build      # builds all workspaces via turbo
pnpm test       # runs vitest for all TS packages
```

### Per-package commands

| Package | Build | Test | Lint | Watch |
|---------|-------|------|------|-------|
| `hub-core` | `pnpm --filter hub-core build` | `pnpm --filter hub-core test` | `pnpm --filter hub-core lint` | `pnpm --filter hub-core dev` |
| `mcp-server` | `pnpm --filter mcp-server build` | `pnpm --filter mcp-server test` | `pnpm --filter mcp-server lint` | `pnpm --filter mcp-server dev` |
| `plugin-sdk` | `pnpm --filter plugin-sdk build` | `pnpm --filter plugin-sdk test` | `pnpm --filter plugin-sdk lint` | `pnpm --filter plugin-sdk dev` |
| `relay` | `pnpm --filter relay build` | `pnpm --filter relay test` | `pnpm --filter relay lint` | `pnpm --filter relay dev` |
| `android-app` | `cd packages/android-app && ./gradlew assembleDebug` | `cd packages/android-app && ./gradlew test` | — | — |
| `runner` | `cd packages/runner && make build` | `cd packages/runner && make test` | `cd packages/runner && make vet` | — |

## Project structure

This is a pnpm workspace monorepo with five production packages and one in-progress Cloud v3 control plane:

```
pdatahub/
├── packages/
│   ├── hub-core/        # Node.js Hub core — HTTP server, plugin subprocess,
│   │                    #   token vault (AES-256-GCM), audit log, OAuth,
│   │                    #   approval stream, federation engine
│   ├── mcp-server/      # MCP bridge — AI agents (OpenCode, Claude Code,
│   │                    #   Cursor, ...) talk MCP to Hub via HTTP
│   ├── plugin-sdk/      # Author SDK for plugins — decorators (@Tool, @OAuth),
│   │                    #   HTTP client, JSON-RPC transport, lifecycle hooks
│   ├── relay/           # Cloudflare Worker — WS-over-HTTP fallback when
│   │                    #   Tailscale is blocked (Phase 1A stub today)
│   ├── android-app/     # Kotlin UI — approval notifications, audit log,
│   │                    #   biometric prompt, pairing via QR
│   └── runner/          # Go control plane — Cloud v3 Hetzner provisioning
│                        #   (Phase 1A skeleton; mocked Hetzner)
├── docs/                # Architecture, federation, self-hosting, threat model
├── .omo/plans/          # Design docs (Momus-reviewed)
├── .github/workflows/   # CI (TypeScript, Go, Android jobs)
├── turbo.json           # Turborepo task graph
└── pnpm-workspace.yaml
```

## Branch and commit conventions

- **Branch from `main`.** Don't fork into long-lived personal branches.
- **Branch names** follow `type/scope` — e.g. `feat/hub-core-rate-limit`, `fix/federation-revoke-broadcast`, `docs/threat-model-update`.
- **Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/)** with a scope prefix matching the package:
  - `feat(hub-core): add per-plugin rate limit`
  - `fix(federation): broadcast revocation via peer_delegations`
  - `docs(architecture): update e2e timing notes`
  - `test(plugin-sdk): cover OAuth refresh edge cases`
  - `chore(runner): bump hcloud-go to v1.x`
- **One logical change per commit.** If your PR touches `hub-core` + `docs` + `mcp-server`, that's three commits.
- **Reference the design doc when relevant.** E.g. `fix(federation): apply Momus B5 migration runner (#.omo/plans/federation-v2-design.md#migrations)`.

## Pull request process

1. **Branch from `main`.** `git checkout main && git pull && git checkout -b feat/my-change`.
2. **PR title format** matches commit subject: `type(scope): description`. Examples: `feat(hub-core): add rate limiting`, `fix(plugin-sdk): handle null OAuth config`, `docs(architecture): explain 13-step federation flow`.
3. **Tests are required.** Any code change without tests gets a review blocker. Pure doc changes don't need tests.
4. **No type suppressions.** `// @ts-ignore`, `// @ts-expect-error`, `as any`, Kotlin `@Suppress("UNCHECKED_CAST")`, Go `any` where an interface exists — all rejected unless accompanied by an inline comment justifying the exception. Even then, expect pushback.
5. **No spec contradictions.** If your change makes a test fail or makes a documented behavior wrong, that's a blocker. Update the test, the doc, or your change — but make them agree.
6. **Momus review for significant design changes.** Anything that:
   - Touches the federation protocol (`packages/hub-core/src/federation/`)
   - Touches the token vault or crypto (`packages/hub-core/src/vault.ts`, anything AES/HKDF/Ed25519)
   - Touches OAuth or approval flow (`packages/hub-core/src/oauth.ts`, `approval-stream.ts`)
   - Touches schema migrations (`packages/hub-core/src/migrations.ts`)
   - Introduces a new persistent network listener
   
   …must be reviewed by [Momus](https://github.com/pdatahub/pdatahub/wiki/Momus-reviews) before merge. Momus is a strict-mode reviewer that catches design contradictions, missing security properties, and ambiguity in RFC-level docs. Tag your PR with `momus-review` and link the design doc under `.omo/plans/`.
7. **CI must pass.** Three jobs: TypeScript (`pnpm lint && pnpm test && pnpm build`), Go (gated on `packages/runner/**` changes), Android (gated on `packages/android-app/**` changes).
8. **Squash-merge or rebase-merge.** Don't merge with the merge button unless you have a good reason.

## Testing

We prefer **mock-first tests** that don't touch the network. Real network tests belong in `*.integration.test.ts` and are gated separately.

| Package | Test runner | Mock hub |
|---------|-------------|----------|
| `hub-core` | vitest | `tests/helpers/mock-hub.ts` |
| `mcp-server` | vitest | `examples/hub-mock.js` |
| `plugin-sdk` | vitest | Plugin subprocess fakes via fixtures |
| `relay` | vitest + miniflare | `@cloudflare/vitest-pool-workers` |
| `android-app` | JUnit | JVM tests for crypto; instrumented tests for UI |
| `runner` | Go `testing` | `MockHetzner` + golden-file cloud-init |

### What "no network in tests" means in practice

- Don't spin up a real Google Calendar server. Use a JSON fixture and assert request shape.
- Don't talk to Tailscale in CI. Use the loopback IP and skip the `HUB_PUBLIC_HOSTNAME` check in tests.
- Don't hit GitHub Releases from tests. Vendor the SDK via `npm link` or a relative path.
- Federation: two real hub-core processes on loopback ports is OK (the multi-process tests do this).

### Test commands

```bash
# hub-core (vitest, ~3s)
pnpm --filter hub-core test

# mcp-server (vitest + example hub-mock.js smoke)
pnpm --filter mcp-server test

# plugin-sdk (vitest)
pnpm --filter plugin-sdk test

# relay (vitest in miniflare)
pnpm --filter relay test

# android-app (JUnit + Robolectric for JVM, instrumented for UI)
cd packages/android-app && ./gradlew test

# runner (Go with -race for federated tests)
cd packages/runner && make test-race
```

## Code style

### TypeScript

- **Strict mode on.** `strict: true` in every `tsconfig.json` (we extend a shared base).
- **No `any`.** No `as any`. No `// @ts-ignore` without justification. No `// @ts-expect-error` without justification.
- **ESLint** via `@typescript-eslint/recommended` + `@typescript-eslint/recommended-type-checked`. Imports sorted by `simple-import-sort`.
- **Exhaustive matching** — `switch (x) { case 'a': ...; default: assertNever(x); }`. Never leave a `default:` that silently does nothing.
- **No `interface` for shapes that are data-only; use `type`.** Exception: when you intend third-party extension via `declare module`.
- **Error types are domain types.** Don't throw `Error("bad")` — define `class OAuthError extends Error` with a stable `code` field.

### Kotlin

- **[Official Kotlin style](https://kotlinlang.org/docs/coding-conventions.html)**.
- **No suppression annotations** without an inline explanation that survives review (`@Suppress("TooManyFunctions")` on a 3-function class is a smell).
- **Compose** for UI; no XML layouts unless wrapping a system view.
- **Hilt** for DI; no manual `ServiceLocator` singletons.
- **Tink + Android Keystore** for crypto. Don't roll your own.

### Go

- **`go vet` clean.** `gofmt -s` clean. `gofumpt` clean (when added).
- **`golangci-lint`** once the linter config lands (Phase 1B).
- **Table-driven tests.** `for _, tc := range tests { t.Run(tc.name, ...) }`.
- **`any`, not `interface{}`.** (Go ≥1.18.)
- **Errors are values.** Wrap with `fmt.Errorf("...: %w", err)`. Don't discard.
- **No `panic` outside `cmd/`** (where it's appropriate for a CLI that should fail fast on misconfiguration).

### Comments and identifiers

- **Code identifiers and comments in English.**
- **Prose in English.** Russian prose is acceptable in `docs/` only (per AGENTS.md in the maintainer's notes); we ask that PR descriptions and commit messages stay English so anyone can review them.
- **Don't over-comment.** A comment explaining *why* is gold; a comment restating *what the code does* is noise. We accept `// Momus C3: decision_federated column needs NULL...` style — those are intentional context anchors.

## Release process

The plugin SDK is distributed via **GitHub Releases** (not npm — see [docs/architecture.md §Plugin SDK distribution](./docs/architecture.md#plugin-sdk-distribution)). To publish a new SDK version:

```bash
# 1. Bump version in packages/plugin-sdk/package.json
# 2. Tag the monorepo
git tag v0.2.0
git push --tags
# 3. CI builds the .tgz and attaches it to the release
gh release create v0.2.0 \
  packages/plugin-sdk/pdatahub-plugin-sdk-0.2.0.tgz \
  --title "v0.2.0" \
  --notes "..."
```

Hub-core, mcp-server, relay, android-app, and runner are not separately published — they evolve in lockstep with the monorepo. A monorepo version bump is a single PR that touches every `package.json` (or `build.gradle.kts` for android-app, `go.mod` for runner). Don't bump one package alone unless you're patching a hot-fix.

Tag format: `vX.Y.Z`. We are pre-1.0 (currently v0.1.0), so breaking changes bump the minor version and may include any number of patches.

## Plugin author guidance

If you're writing a plugin (Google Calendar, Slack, Notion, GitHub, ...), see **[docs/plugin-author-guide.md](./docs/plugin-author-guide.md)** for the end-to-end guide — scaffold, decorators, OAuth, HTTP client, packaging, distribution via GitHub Releases. The canonical example plugin is [`pdatahub-plugin-google-calendar`](https://github.com/pdatahub/pdatahub-plugin-google-calendar); the canonical scaffold is [`pdatahub-plugin-template`](https://github.com/pdatahub/pdatahub-plugin-template).

## Questions?

- Open a [GitHub Discussion](https://github.com/pdatahub/pdatahub/discussions) — best for design questions and "how do I".
- Open an [issue](https://github.com/pdatahub/pdatahub/issues/new/choose) — best for concrete bugs and feature requests.
- Read the [docs/](./docs/) directory — architecture, federation, self-hosting, threat model, advantages.

Thanks for contributing.