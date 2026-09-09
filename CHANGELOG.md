# Changelog

All notable changes to pdatahub are documented here. Dates are in `YYYY-MM-DD` format. Versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]
## [0.2.2] — 2026-09-09

### Added

- **Default `health()` exposes v2.1 stats fields.** Operators get
  visibility into plugin runtime behavior (uptime, call_count,
  last_call_at) without writing any plugin code. Hub's 5-minute health
  monitor now surfaces these metrics for every installed plugin.
  Subclasses override to add richer metrics (errors, latency p99,
  per-tool breakdown).
- **Default `onToolResult()` increments call counters.** Previously
  a no-op; now tracks `callCount` and `lastCallAt` per plugin. Plugins
  overriding this hook should call `super.onToolResult(name, result)`
  to keep the base counters.
- **`startedAt` field on Plugin base class.** Captured at instance
  construction time. Used by `health()` uptime calculation.

### Compatibility

- v0.2.1 plugins work without code changes (subclasses that override
  `health()` or `onToolResult()` keep their overrides).
- TypeScript: `health()` return type widens with optional fields. No
  existing code breaks.

### Tests

- 149 → 152 passing (+3).
  - Default `health()` returns v2.1 stats fields with initial values
  - Default `onToolResult()` increments `call_count` + sets `last_call_at`
  - `startedAt` captured per-instance (verified via uptime ordering)

## [0.2.1] — 2026-09-09

### Changed

- **Plugin SDK**: `httpClient` field reverted from `protected` to `public`. v1 plugins accessed the HTTP client via `this.http` / `this.httpClient` directly; making it `protected` blocked plugin authors from writing helpers outside the subclass (e.g. utility methods in separate files). No behavior change for subclasses, which already had access.
- **`PluginLifecycle` interface**: now documents v1 hooks (`onStart`, `onShutdown`, `onToolResult`) alongside v2 hooks (`onInstall`, `onUninstall`, `onActivate`, `onDeactivate`, `health`). Subclass overrides remain optional for all hooks.

### Compatibility

- Wire format unchanged. All v0.2.0 plugins work without code changes.
- TypeScript: `httpClient` is now `public` instead of `protected`. Subclass access unchanged. External test mocks can now read `plugin.httpClient` without casting.

## [0.3.0] — 2026-09-09

### Added

- **T-PERSISTENT-001 mitigation #1**: master_key storage in OS keyring (Linux Secret Service via @napi-rs/keyring / macOS Keychain / Windows DPAPI). Removes the trivial `/proc/<pid>/cmdline` exfiltration vector — keyring entries are process-isolated.
  - New `src/keyring.ts` with cross-platform backend, 24 unit tests.
  - New CLI flags: `--keyring-service`, `--keyring-account`, `--store-keyring`, `--ack-insecure-master-key`.
  - Graceful fallback to legacy CLI/env paths if keyring unavailable.
  - New subcommand: `pdatahub-hub keyring show|clear`.
- **T-PERSISTENT-001 mitigation #2**: Audit log of every vault decryption (streamed live to Android via WebSocket).
  - Migration v7 adds `actor_type`, `actor_id`, `request_id` columns to `audit_log`.
  - New `AuditStore.recordVaultAccess()` method — non-blocking, fail-soft.
  - New `ApprovalStream.broadcastVaultAccess()` for Android live updates.
  - 14 new tests covering schema round-trip + WebSocket broadcast.
- **T-PERSISTENT-001 mitigation #3**: Audit log of refresh_token rotation events.
  - New `AuditDecision = 'token_rotation'` value.
  - New `AuditStore.recordTokenRotation()` method — sync write for incident-response visibility.
  - 3 new tests covering rotation=true/false and stats counter.

### Changed

- `TokenVault.getAccessToken` now writes audit row on every call (non-blocking, fail-soft).
- `TokenVault.refreshAccessToken` now writes audit row on every refresh.
- `AuditLog.stats()` return literal extended to include `token_rotation: 0`.
- Existing OAuth flow already uses `prompt=consent + access_type=offline`; no changes needed.

### Security

**T-PERSISTENT-001 (refresh token extraction after laptop compromise): FULLY MITIGATED.** See `docs/threat-model.md` § "Critical threat scenarios" for the full attack chain and attack-vector coverage matrix.

### Backwards Compatibility

- New `AuditDecision` value (`token_rotation`) is additive — old readers ignore unknown values.
- New audit_log columns (v7) added via `ALTER TABLE` — existing rows preserved.
- Existing CLI flags (`--master-key`, `--passphrase`, `HUB_MASTER_KEY`) still work but log a one-shot `T-PERSISTENT-001` warning to stderr.
- Existing OAuth flow unchanged — `prompt=consent` was already in place.

### Tests

- hub-core: 385 → 410 passing (+25 new tests for the 3 mitigations).
- Pre-existing 2 federation-adversarial flakes (TTL/revoke timing) unchanged.
- All 5 packages tested at head: hub-core 410/412, plugin-sdk 146/149, mcp-server 31/31, relay 32/32, runner 41/41.

### Residual Risk

Keyring entry exfiltration (TPM-less machines) — mitigated at v4 via TPM/SEV-SNP key sealing. Until then, full-disk encryption is the primary defense.

## [0.2.0] — 2026-09-08

### Added

- **Plugin SDK v2**: typed errors, JSON Schema validation, lifecycle hooks, protocol versioning, testing utilities.
- Typed error hierarchy (`PluginError`, `AuthError`, `AuthExpiredError`, `ScopeError`, `NetworkError`, `ValidationError`, `TimeoutError`, `NotFoundError`, `RateLimitError`) with `code`, `retryable`, `details`, `toJSON()`.
- JSON Schema validation via ajv — opt-in via `@Tool({ inputSchema })`.
- Lifecycle hooks: `onInstall()`, `onUninstall()`, `onActivate()`, `onDeactivate()`, `health()`.
- Protocol versioning: `protocolVersion: 1 | 2` field in manifest + `capabilities` detection.
- Testing utilities: `createMockHub()`, `MockHttpClient` (shares `mapUpstreamError` with real `HttpClient`).
- HTTP client typed error mapping: 401/403/404/429/5xx → typed `PluginError` subclasses.

### Changed

- Hub-core integrates SDK v2: routes `PluginError` → 401/403/400/404/502/500 with proper MCP error shape.
- Audit log migration v6: adds `error_class` + `error_code` columns.
- ApprovalStream: new `broadcastPluginReauth()` triggers phone notification on `AuthExpiredError`.
- Plugin process: handles `plugin.lifecycle` JSON-RPC with timeout (5s health, 30s others).

### Backward Compatibility

- v1 plugins (no `protocolVersion` set) default to 1, no behavior change.
- 51 pre-existing tests in plugin-sdk continue to pass.
- 334 pre-existing tests in hub-core continue to pass.


### Added

- Standard GitHub community files (LICENSE, CONTRIBUTING.md, CODE_OF_CONDUCT.md, SECURITY.md).
- Issue templates (bug report, feature request, plugin idea).
- PR template with Momus review trigger list.
- Comprehensive documentation: `docs/plugin-author-guide.md`, `docs/self-hosting.md`, `docs/threat-model.md`, `docs/advantages.md`.

## [0.1.0] — 2026-09-08

### Added

- Federation v2 protocol across all eight phases:
  - Migration framework + per-route auth + hard-fail on missing `HUB_API_TOKEN`.
  - Ed25519 keypair generation, signing/verification, canonical JSON.
  - Delegation data model (`delegations`, `peer_delegations`).
  - `user_id` semantics (kept `'local-user'` for data owner; federation context via `delegated_by` / `delegated_to`).
  - Inbound call handler `/v1/federation/call` with 13-step security.
  - CLI tooling (`delegate`, `accept-delegation`, `list`, `revoke`, `audit purge`).
  - Tool descriptors + mcp-server passthrough (`/v1/federation/invoke`).
  - Android UI (approval payload, HubIdentitySection, DelegationManagementScreen).
  - User documentation (`docs/federation.md`).
  - Audit retention CLI (`pdatahub-hub audit purge --older-than Nd`).
  - Multi-process integration tests + adversarial tests.
- pdatahub Cloud v3 control plane skeleton (`packages/runner/`, Phase 1A): mocked Hetzner, cloud-init generator, SSH key generator, hub-core deploy planner.
- Phone-mediated approval with biometric prompt.
- Tailscale mesh relay (`docs/relay-mode.md`).
- OAuth cross-device flow via `HUB_PUBLIC_HOSTNAME`.
- Plugin symlink + spawn fix (`realpathSync()`).

### Fixed

- Biometric prompt crash (`PromptInfo` flag correction).
- Heartbeat noise cleanup.
- Real Google Calendar data e2e via phone approval (4.6s end-to-end).

### Verified

- 2026-09-07 — full single-hub e2e with real Google Calendar data, 4.6s latency.
- 2026-09-08 — hub-core 310/310 tests pass; Android 39/39 pass; federation multi-process + adversarial tests pass.

[Unreleased]: https://github.com/pdatahub/pdatahub/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/pdatahub/pdatahub/releases/tag/v0.1.0