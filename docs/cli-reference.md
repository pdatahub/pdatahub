# pdatahub-hub CLI Reference

`pdatahub-hub` is the command-line entry point for hub-core. It supports two
operational modes:

- **Direct DB mode** (default) — opens SQLite directly. Requires `--master-key`,
  `HUB_MASTER_KEY`, `--passphrase`, or a keyring entry to unlock the vault.
- **HTTP mode** — talks to a running hub via the same endpoints the mcp-server
  uses. Requires `--hub-url` and `--api-token` (or env vars). master_key never
  enters the CLI process.

## Global flags

```
pdatahub-hub [SUBCOMMAND] [FLAGS]
```

| Flag | Description |
|------|-------------|
| `--master-key <hex>` | 32-byte hex master key (64 chars). INSECURE — visible to other local users via `/proc/<pid>/cmdline`. |
| `--passphrase <text>` | Derive master key via scrypt. Same security warning. |
| `--db-path <path>` | SQLite database path (default `./pdatahub-hub.db`). |
| `--hub-url <url>` | HTTP mode — talk to running hub at this URL (also `PDHUB_URL` env). |
| `--api-token <token>` | HTTP mode bearer token (also `PDHUB_API_TOKEN` / `HUB_API_TOKEN` env). |
| `--format <fmt>` | Output format for list commands: `table` (default) \| `json`. |
| `--filter <kind>` | For list commands: `all` (default) \| `granted` \| `received`. |
| `--ack-insecure-master-key` | Suppress the T-PERSISTENT-001 insecure-path warning. |

## Subcommands

### `init` — Create hub identity

```bash
pdatahub-hub init [--words 12|15|18|21|24] [--hub-name <name>] [--db-path <path>]
```

Generates a BIP-39 mnemonic + master key. Prints mnemonic to stdout (write it
on paper; losing it = losing the vault). With `--hub-name`, also initializes
the federation identity used for signing outbound delegation blobs.

### `identity` — Show / rotate hub identity

```bash
pdatahub-hub identity show          # Print verify_key + magic_dns + fingerprint
pdatahub-hub identity regen [--yes] # DESTRUCTIVE: rotate keypair (y/N prompt)
```

Rotating the keypair invalidates ALL existing delegations — peers must
re-issue after rotation.

### `delegate` — Issue a delegation (A side)

```bash
pdatahub-hub delegate \
  --peer-verify-key <key> \
  --plugin <name> \
  --tool <name> \
  --scope <scope> \
  --expires <duration> \
  [--hub-url <url>] [--api-token <token>]
```

Prints the delegation blob (base64url). Share this blob with the peer hub's
operator — they import it via `accept-delegation`.

**Examples:**

```bash
# Local DB mode
pdatahub-hub delegate \
  --peer-verify-key "ed25519:Q57eg1Nre..." \
  --plugin google-calendar \
  --tool listEvents \
  --scope calendar:read \
  --expires 24h

# HTTP mode (remote hub, e.g. Cloud v3)
PDHUB_URL=https://hub.example.com \
PDHUB_API_TOKEN=$(pass show pdatahub/api) \
pdatahub-hub delegate --peer-verify-key ... --plugin ... --tool ... --scope ... --expires 24h
```

### `delegate list` — List granted delegations

```bash
pdatahub-hub delegate list \
  [--hub-url <url>] [--format table|json] [--filter all|granted|received]
```

Lists all delegations this hub has ISSUED to peers. Without `--filter`, also
shows received. JSON output is useful for scripting:

```bash
pdatahub-hub delegate list --format json | jq '.granted[] | select(.revoked == 0)'
```

### `accept-delegation` — Import a delegation blob (B side)

```bash
pdatahub-hub accept-delegation <blob> [--yes] [--db-path <path>]
```

Verifies the blob's signature, shows what you're about to import (peer name,
plugin/tool/scope), prompts `yes/no` (unless `--yes`), then persists.

**Always DB-direct.** Requires the peer hub's verify_key to match what the
issuer claims (signature check). DNS resolution to `magic_dns` happens
locally; falls back to hostname if DNS fails.

### `delegation list` — List received delegations

```bash
pdatahub-hub delegation list \
  [--hub-url <url>] [--format table|json] [--filter all|granted|received]
```

Lists delegations peer hubs have issued to THIS hub. These are what make
federated tool calls work — when mcp-server invokes a tool, the Hub looks
up the matching received delegation.

### `delegation revoke` — Revoke a granted delegation

```bash
pdatahub-hub delegation revoke <delegation_id> [--hub-url <url>]
```

Idempotent: revoking an already-revoked or unknown ID returns a non-zero
exit code but doesn't throw.

### `backup` — Encrypted vault backup

```bash
pdatahub-hub backup <vault_db_path> <out_file>
```

Encrypts the SQLite vault with a passphrase (AES-256-GCM + scrypt KDF).
Output is a self-describing JSON envelope (version + KDF params + ciphertext).

### `restore` — Decrypt + restore vault

```bash
pdatahub-hub restore <in_file> <vault_db>
```

Inverse of `backup`. Prints the new master_key hex after restore — store it
in the OS keyring immediately.

### `inspect` — Show backup metadata (no decrypt)

```bash
pdatahub-hub inspect <backup_file>
```

Shows version, KDF params, cipher, creation timestamp. Useful for verifying
a backup is well-formed before committing to a restore.

### `audit purge` — Delete old audit rows

```bash
pdatahub-hub audit purge --older-than <duration> [--yes]
```

`<duration>` is `Nd`/`Nh`/`Nw` (days/hours/weeks). Without `--yes`, prints a
preview count; with `--yes`, actually deletes.

### `keyring` — Manage master_key in OS keyring

```bash
pdatahub-hub keyring show    # Status of keyring entry (available, has master_key, etc.)
pdatahub-hub keyring clear   # Remove master_key from keyring
pdatahub-hub --store-keyring <hex>   # One-shot: write master_key to keyring, exit
```

## HTTP mode vs DB-direct mode

| Operation | DB-direct | HTTP mode |
|-----------|-----------|-----------|
| `init` / `identity` | ✅ required (no hub running) | ❌ |
| `backup` / `restore` / `inspect` | ✅ required (hub should be stopped) | ❌ |
| `delegate` (create) | ✅ | ✅ |
| `delegate list` | ✅ | ✅ |
| `accept-delegation` | ✅ required | ❌ not exposed |
| `delegation list` | ✅ | ✅ |
| `delegation revoke` | ✅ | ✅ |
| `audit purge` | ✅ required (writes DB) | ❌ (read-only HTTP API) |
| `keyring` ops | ✅ required | ❌ |

**When to use HTTP mode:**

- **Cloud v3 / remote hub** — `pdatahub-hub` runs on your laptop, hub runs
  on Hetzner. Set `PDHUB_URL=https://hub.example.com` and manage remotely.
- **Multi-tenant setups** — single shared hub, multiple operators managing
  their own delegations via individual API tokens.
- **Scripting** — `pdatahub-hub delegation list --format json | jq ...` in
  shell pipelines without exposing master_key to subprocesses.

**When to use DB-direct:**

- **Hub is not running** — initial setup, backup/restore, audit purge.
- **Local dev** — single machine, single user, keyring-backed master_key.
- **`accept-delegation`** — always local (DNS resolution + interactive prompt).

## Security

**T-PERSISTENT-001** ([threat-model.md](./threat-model.md)): passing
`master_key` via CLI flag or env var exposes it to any local user via
`/proc/<pid>/cmdline` or `/proc/<pid>/environ`. To avoid this:

1. Run `pdatahub-hub init --hub-name <name>` once → prints mnemonic + hex
2. Run `pdatahub-hub --store-keyring <hex>` once → writes to OS keyring
3. Run `pdatahub-hub` without flags → reads from keyring (silent, secure)

In HTTP mode, master_key stays in the hub's process — the CLI only holds
the API token (revocable independently).

## See also

- [plugin-author-guide.md](./plugin-author-guide.md) — for plugin authors
- [architecture.md §Security model](./architecture.md#security-model) — token vault, plugin isolation
- [federation.md](./federation.md) — user-facing federation guide
- [threat-model.md](./threat-model.md) — security threat analysis
