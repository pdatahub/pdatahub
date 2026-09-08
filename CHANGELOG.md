# Changelog

All notable changes to pdatahub are documented here. Dates are in `YYYY-MM-DD` format. Versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]
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