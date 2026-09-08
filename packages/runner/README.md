# pdatahub-runner

Control-plane daemon for **pdatahub Cloud v3** (hosted Hub SaaS). One Go binary that provisions Hetzner VMs, deploys [`@pdatahub/hub-core`](../hub-core/) onto them as a systemd service, and monitors health.

> **Phase 1A — skeleton only.** This commit ships:
> - Go module + directory layout
> - Hetzner client interface + in-memory `MockHetzner`
> - Domain types (`User`, `VM`, `HubInstance`, `Region`)
> - Cloud-init script generator (pure function, no execution)
> - SSH key generator (ed25519, OpenSSH format)
> - Hub-core **deploy planner** (plan only, no executor)
> - `cmd/runner` CLI skeleton (`--dry-run` default)
> - Unit tests with race detector + golden file
>
> Phase 1B (after user provides Hetzner API token) wires real provisioning, SSH executor, health monitor, and HTTP control API. See [§Roadmap](#roadmap) below.

## Module

```
github.com/pdatahub/pdatahub/runner
```

Go 1.23. Single external dep: `github.com/stretchr/testify` (plus its transitive deps). Real `hcloud-go` lands in Phase 1B.

## Directory layout

```
packages/runner/
├── cmd/runner/         # binary entry point
├── internal/
│   ├── cloudinit/      # YAML generator for VM first-boot (golden file tests)
│   ├── hetzner/        # Client interface + MockHetzner (deterministic, in-memory)
│   ├── hubcore/        # DeployPlan planner (no execution in Phase 1A)
│   ├── sshkey/         # ed25519 keypair generator
│   └── types/          # User, VM, HubInstance, Region enum
├── Makefile            # build / test / cover / vet
├── go.mod / go.sum
└── README.md (this file)
```

## Architecture

```
                          ┌─────────────────────────────┐
                          │  pdatahub-runner (this pkg)  │
                          │  - HTTP API (Phase 1B)       │
                          │  - Hetzner client            │
                          │  - cloud-init generator      │
                          │  - SSH executor              │
                          │  - Health monitor            │
                          └──────────────┬──────────────┘
                                         │ SSH + cloud-init
                              ┌──────────▼──────────┐
                              │  Hetzner CX22 VM    │
                              │  ubuntu-24.04       │
                              │  hub-core systemd   │
                              │  + Tailscale agent  │
                              └─────────────────────┘
```

Each cloud user gets exactly one VM (Phase 1A assumption; multi-VM per user is out of scope). The VM hosts one `hub-core` instance. The runner manages VM lifecycle (create, snapshot, delete) and hub-core lifecycle (deploy, upgrade, restart).

### Architectural decisions locked (2026-09-08)

| Decision | Choice | Notes |
|----------|--------|-------|
| Multi-tenancy | DB-per-user + dedicated VM | Full isolation. |
| VM type | Hetzner CX22 (4GB / 2 vCPU / 40GB) | €4.5/mo; hub-core + SQLite + plugins ≈ 300MB RSS. |
| VM image | Ubuntu 24.04 | LTS, well-supported by Hetzner. |
| Runner | Go binary in monorepo | Single static binary, ~1500 LOC total target. |
| Tailnet | `cloud.pdatahub.io` | Every cloud VM joins for cross-device approval. |
| Hub-core deploy | GitHub Releases tarball + SHA256 verify | Matches existing release flow. |
| Domain | `hub.pdatahub.io` (user MagicDNS) | Locked. |
| Region | EU only first (Hetzner Falkenstein, `fsn1`) | Locked. |

## Build & test

```bash
# Run from packages/runner/
make build     # → bin/runner
make test      # unit tests
make test-race # unit tests with -race
make cover     # coverage HTML report
make vet       # go vet
make tidy      # go mod tidy
```

Direct invocation (without the Makefile):

```bash
cd packages/runner
go mod tidy
go vet ./...
go test ./... -race -coverprofile=coverage.out
go build ./...
```

## CLI

```text
pdatahub-runner v0.1.0-alpha (Phase 1A skeleton)
Usage:
  --port <int>      HTTP port (default 8081; Phase 1B only)
  --dry-run         Print intended startup and exit (Phase 1A default)
  --verbose         Echo parsed flags
```

Phase 1A always exits after the dry-run line. Phase 1B wires `--dry-run=false` to a real HTTP listener that exposes `/v1/cloud/users` and friends.

## What's in Phase 1A

| Component | Status |
|-----------|--------|
| `internal/types` | ✅ Pure data + validation. |
| `internal/hetzner` (`Client` interface + `MockHetzner`) | ✅ In-memory, deterministic, race-safe. |
| `internal/cloudinit.Generate` | ✅ Pure function returning YAML. Golden file test. |
| `internal/sshkey.Generate` | ✅ ed25519, OpenSSH PEM, SHA256 fingerprint. |
| `internal/hubcore.PlanDeployment` | ✅ Plan only; no executor. |
| `cmd/runner` | ✅ Parses flags, dry-run exit, panics otherwise. |
| Real `hcloud-go` client | ⏳ Phase 1B |
| SSH executor | ⏳ Phase 1B |
| Health monitor | ⏳ Phase 1B |
| HTTP API (`POST /v1/cloud/users`, etc.) | ⏳ Phase 1B |
| SQLite control-plane DB | ⏳ Phase 1B |
| Stripe webhook handler | ⏳ Phase 3 |

## Roadmap

| Phase | Scope | Status |
|-------|-------|--------|
| **0** | Design + decisions lock | ✅ Complete (2026-09-08) |
| **1A** | Go skeleton + mocked Hetzner + types + tests | ✅ This commit |
| **1B** | Real Hetzner provisioning + cloud-init upload + hub-core deploy executor + health monitor | ⏳ Next |
| **2** | Sign-up flow + Google OAuth | ⏳ |
| **3** | Stripe billing + quotas | ⏳ |
| **4** | Shared vs per-user OAuth client decision | ⏳ |
| **5** | Federation interop tests (cloud ↔ self-hosted) | ⏳ |
| **6** | HTTPS via Tailscale Serve + monitoring + launch | ⏳ |

See design doc: `~/Документы/Obsidian/Работа/Personal Data Hub/Personal Data Hub — Cloud v3 Design.md`.

## CI

`.github/workflows/ci.yml` runs `go vet`, `go test -race`, and `go build` for this package on every PR. Phase 1A job is gated by `paths` filter so docs-only changes don't pay the Go install cost.

## What this commit does NOT do

- Does not provision real Hetzner VMs (mocked).
- Does not SSH anywhere (no executor yet).
- Does not serve HTTP (CLI-only dry-run).
- Does not store any state (everything is in-memory or generated on the fly).
- Does not depend on `github.com/hetznercloud/hcloud-go` (Phase 1B adds it).
- Does not touch any existing package (`hub-core`, `mcp-server`, etc.) — only the root README roadmap line + turbo.json comment + ci.yml job.

## License

MIT.