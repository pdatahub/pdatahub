# Plugin Author Guide — SDK v2

A pdatahub plugin is a Node.js subprocess that exposes one external service (Google Calendar, Slack, Notion, GitHub, …) as a set of typed tools. The Hub holds the OAuth tokens, approves each call, injects a decrypted access token into the plugin's HTTP client at call time, and writes an audit row.

This guide is for **SDK v2** (`@pdatahub/plugin-sdk >= 0.2.0`). v1 plugins continue to work unchanged — see [§Migration from v1](#migration-from-v1) at the end if you're upgrading.

The canonical reference implementation is [`pdatahub-plugin-google-calendar`](https://github.com/pdatahub/pdatahub-plugin-google-calendar) — read it alongside this guide.

---

## What's new in v2

| Area | v1 | v2 |
|------|----|----|
| Protocol version | implicit | opt-in `protocolVersion = 2 as const` |
| Manifest | `{name, version, tools, oauth?}` | adds `capabilities[]` (typed feature flags) |
| HTTP client field | `this.http` | `this.httpClient` |
| Tool errors | thrown `Error` | typed `PluginError({code, message, retryable?, details?})` mapped to HTTP statuses |
| Input validation | optional `inputSchema` (manual) | mandatory JSON Schema validation by Hub before dispatch |
| Lifecycle hooks | `onStart`, `onShutdown`, `onToolResult` | + `onInstall`, `onUninstall`, `onActivate`, `onDeactivate`, `health()` |
| Health | not exposed | default `health()` reports `uptime_ms`, `call_count`, `last_call_at` |
| Federation | none | scope namespacing + Hub validates cross-hub scope at call time |
| OAuth refresh | manual | Hub auto-refreshes on `AUTH_EXPIRED` and retries once |

If you're starting fresh, ignore this table — just use v2 patterns. If you're upgrading, see [§Migration from v1](#migration-from-v1).

---

## What is a plugin?

A plugin is:

1. **A Node.js process** spawned by Hub on first tool call. Communication is JSON-RPC 2.0 over stdio. `stdout` is protocol-only; `stderr` is your logs.
2. **Scoped to one external service** — one plugin = one OAuth provider (or API token). If your integration spans two services, write two plugins.
3. **Stateless and side-effect-free at boot.** Hub may spawn and kill your plugin any number of times. Persistent state belongs in the Hub's storage, not your plugin.
4. **Trusted with one specific access token** per call. Hub decrypts it from its vault, injects it via the SDK's `httpClient`. **Your plugin never sees the raw token as a string** — it makes authenticated requests via `await this.httpClient.get(...)`.

---

## Quickstart

### 1. Scaffold from the template

```bash
gh repo create my-plugin --template pdatahub/pdatahub-plugin-template --public --clone
cd my-plugin
```

The template ships with:

- `package.json` referencing `@pdatahub/plugin-sdk` from GitHub Releases
- `tsconfig.json` extending the SDK's recommended config
- `src/index.ts` with a minimal Hello-World tool (already on v2)
- `vitest.config.ts` and `tests/plugin.test.ts`
- `examples/hub-mock.ts` so you can run your plugin against a fake Hub during development

### 2. Install dependencies

```bash
pnpm install
```

The SDK is downloaded from GitHub Releases — `package.json` points at `https://github.com/pdatahub/pdatahub/releases/download/sdk-v<X.Y.Z>/pdatahub-plugin-sdk-<X.Y.Z>.tgz`. If you're using a version we haven't published yet, point at the local path: `"@pdatahub/plugin-sdk": "file:../pdatahub/packages/plugin-sdk"`.

### 3. Run dev mode

```bash
pnpm dev
```

This starts the plugin in dev mode: it prints JSON-RPC to stdout as if Hub had spawned it. You can paste messages into a JSON-RPC debugger (or just `cat | nc`) to test individual tool calls.

### 4. Write your plugin (v2)

```typescript
// src/index.ts
import { Plugin, Tool, OAuth, NetworkError, NotFoundError, RateLimitError } from '@pdatahub/plugin-sdk';

@OAuth({
  authorizationUrl: 'https://myservice.example.com/oauth/authorize',
  tokenUrl:         'https://myservice.example.com/oauth/token',
  scopes:           ['things:read'],
})
export default class MyServicePlugin extends Plugin {
  name             = 'myservice';
  version          = '0.1.0';
  description      = 'MyService integration for pdatahub';
  protocolVersion  = 2 as const;
  capabilities     = ['http'];   // v2: declare what features you use

  @Tool({
    scope:       'myservice:read',
    description: 'Read recent things from MyService',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 10 },
      },
      required: [],
    },
  })
  async readThings(limit: number = 10) {
    try {
      const { data } = await this.httpClient!.get('things', { params: { limit } });
      return data;
    } catch (err) {
      // Translate upstream errors to typed PluginError subclasses so the
      // Hub can decide whether to retry or surface to the user.
      const status = (err as { status?: number }).status;
      if (status === 429) {
        throw new RateLimitError(60_000);  // retry after 60s
      }
      if (status === 404) {
        throw new NotFoundError(`things not found`);
      }
      // Unwrap network errors so the Hub knows it's transient.
      throw new NetworkError(`upstream failed: ${(err as Error).message}`, err as Error);
    }
  }
}

if (require.main === module) {
  new MyServicePlugin().start();
}
```

Build and ship:

```bash
pnpm build       # tsc → dist/index.js
node dist/index.js
```

When Hub spawns your plugin, it sends an `initialize` request. The SDK auto-responds with the manifest derived from `@OAuth`, `@Tool`, and `capabilities`. Hub validates the manifest, registers your tools, and dispatches calls.

---

## Concepts

### Manifest & protocol version

The manifest is what your plugin tells the Hub about itself. v2 plugins opt in to the new shape:

```typescript
class MyPlugin extends Plugin {
  name            = 'myservice';
  version         = '0.1.0';
  description     = 'MyService integration';
  protocolVersion = 2 as const;        // ← opt in
  capabilities    = ['http', 'oauth']; // ← v2 field: what features you use
}
```

**`protocolVersion`** — must be `2 as const` for new plugins. Defaults to `1` so v1 plugins keep working.

**`capabilities`** — array of feature flags. Hub uses this for capability negotiation. Common values:
- `http` — uses `this.httpClient` for outbound requests
- `oauth` — uses `@OAuth` for token flow
- `federation-ready` — explicitly designed for cross-hub invocation (see §Federation)
- `streaming` — supports `tools/call` with streamable responses (planned, not yet implemented in Hub)
- `persistent-state` — needs on-disk state across restarts (Hub will provide a per-plugin SQLite namespace)

If a capability isn't declared, Hub may refuse to call your plugin in contexts where that feature is required. **Always declare what you use.**

### Tool decorators

`@Tool({ scope, description, inputSchema })` — applied to each method. Declares:

- **Name** — derived from method name, or override via `name:`. Must match `[a-z][a-zA-Z0-9_]*`.
- **`scope`** — OAuth scope required to call. Hub groups approval prompts by scope: if a user already approved `myservice:read`, they get a 1-hour grant and won't be re-prompted for any other tool with the same scope. Choose namespaced scopes: `myservice:read` beats `read`.
- **`description`** — human-readable, shown to both the AI agent when choosing a tool AND to the user in the approval prompt. Be specific: "List upcoming calendar events for the next 7 days" → better than "Get events".
- **`inputSchema`** — **v2 makes this mandatory for non-trivial inputs.** JSON Schema (subset supported: `type`, `properties`, `required`, `enum`, `minimum/maximum`, `minLength/maxLength`, `pattern`). Hub validates BEFORE invoking your method; bad input never reaches you. Defaults from `default:` are applied.

```typescript
@Tool({
  scope:       'myservice:read',
  description: 'List upcoming events for the next N days',
  inputSchema: {
    type: 'object',
    properties: {
      days: { type: 'integer', minimum: 1, maximum: 90, default: 7 },
    },
    required: [],
  },
})
async listUpcomingEvents(days: number = 7) {
  const { data } = await this.httpClient!.get('events/upcoming', {
    params: { days },
  });
  return data;
}
```

### HTTP client (`this.httpClient`)

Every tool call gets a per-call HTTP client at `this.httpClient` (a thin wrapper over `undici.fetch`). It:

- Auto-injects `Authorization: Bearer <decrypted_access_token>` from the Hub's vault
- Times out at 30s by default (override via `timeoutMs`)
- Bubbles non-2xx as typed errors with the response body attached

```typescript
const res = await this.httpClient!.get('things', { params: { limit } });
return res.data;  // already parsed JSON
```

Methods: `get(path, options?)`, `post(path, body?, options?)`, `put`, `patch`, `delete`. All return `{ status, headers, data }`.

**Never call `fetch()` directly.** Reasons:

1. Direct `fetch` won't have the bearer token — your call will 401.
2. Hub can't observe or audit calls that bypass `this.httpClient`.
3. Token refresh (handled by Hub) only fires when you go through `this.httpClient`.
4. Rate limiting (Hub-side per-IP) only counts `httpClient` calls.

### Errors (typed `PluginError` subclasses)

v1 plugins threw `Error` and got back opaque 500s. **v2 plugins throw typed `PluginError` subclasses** and Hub maps them to the appropriate HTTP status. Use the subclass constructors — they're ergonomic and self-documenting:

| Subclass | HTTP | When |
|----------|------|------|
| `new AuthError(message, details?)` | 403 | Refresh token revoked / user denied |
| `new AuthExpiredError(expiresAt?)` | 401 | Hub's stored access token expired; Hub auto-refreshes and retries |
| `new ScopeError(requiredScope, grantedScopes)` | 403 | Upstream rejected our scope claim |
| `new ValidationError(field, value, constraint)` | 400 | Input failed upstream validation (rare; Hub already validates against `inputSchema`) |
| `new NotFoundError(message)` | 404 | Upstream resource doesn't exist |
| `new RateLimitError(retryAfterMs?)` | 502 | Upstream rate-limited the plugin |
| `new TimeoutError(message, cause?)` | 502 | Upstream too slow |
| `new NetworkError(message, cause?)` | 502 | DNS / TCP / TLS failure |
| raw `PluginError(code, message, retryable?, details?)` | varies | Escape hatch when no subclass fits |

All subclasses are non-retryable **except** `AuthExpiredError`, `RateLimitError`, `TimeoutError`, `NetworkError`. For raw `PluginError`, set `retryable=true` explicitly when transient.

When you throw a retryable error, the **AI agent** decides whether to retry with backoff. Don't retry inside your plugin — Hub's approval flow already adds latency, so retry storms hurt UX.

```typescript
import { AuthError, NotFoundError, RateLimitError, NetworkError } from '@pdatahub/plugin-sdk';

if (response.status === 429) {
  throw new RateLimitError(60_000);  // retry after 60s
}
if (response.status === 404) {
  throw new NotFoundError(`Calendar ${calendarId} not found`);
}
if (response.status === 401) {
  throw new AuthError('refresh token revoked by upstream');
}
```

**Special case — `AuthExpiredError`**: when you throw this, Hub auto-refreshes the access token via your `handleOAuthCallback` and re-invokes your tool with the fresh token. **Don't try to refresh tokens yourself.**

### Plugin lifecycle

v2 has 7 lifecycle hooks. The default implementations are all no-ops except `health()` (which reports stats) and `onToolResult` (which tracks call counts):

```typescript
class MyPlugin extends Plugin {
  // Initialization
  async onStart() { /* after initialize, before any tools/call */ }
  async onInstall() { /* once, after OAuth setup */ }
  async onActivate() { /* every subprocess start, after manifest */ }

  // Per-call
  async onToolResult(name: string, result: unknown) {
    // default: increments callCount, sets lastCallAt
  }

  // Shutdown
  async onDeactivate() { /* before subprocess exit */ }
  async onUninstall() { /* once, before plugin removed from disk */ }
  async onShutdown() { /* Hub sent shutdown notification */ }

  // Health probe (Hub calls every 5 min)
  async health() {
    return { status: 'healthy' };   // or 'degraded' / 'unhealthy'
  }
}
```

**Default `health()`** (v2.1+) reports stats without you writing any code:

```json
{
  "status": "healthy",
  "uptime_ms": 346000,
  "call_count": 47,
  "last_call_at": "2026-09-09T21:30:12.456Z"
}
```

Override `health()` if you need richer signals (e.g. token expiry, upstream health). The Hub surfaces `degraded` and `unhealthy` to the user; `healthy` is silent.

**Don't override `onToolResult` just to log** — use `this.logger?.info(...)`. Override `onToolResult` only when you need to maintain custom metrics.

### OAuth integration

You do **not** write the OAuth dance. Hub runs the redirect, captures the auth code, exchanges it for tokens via your `handleOAuthCallback`, stores them encrypted in its vault, and passes you a decrypted access token at call time.

What you **do** declare:

- `authorizationUrl`, `tokenUrl`, `scopes` in `@OAuth`
- The OAuth flow implementation in `handleOAuthCallback` (only if your provider has quirks — see below)
- `client_id`, `client_secret` as environment variables on the Hub: `HUB_CLIENT_<PLUGIN>_ID` and `HUB_CLIENT_<PLUGIN>_SECRET` (e.g. `HUB_CLIENT_GOOGLE_CALENDAR_ID`, `HUB_CLIENT_GOOGLE_CALENDAR_SECRET`). The Hub operator sets these.

What you **don't** do:

- You don't see the raw token. You don't need `client_secret` in your plugin process.
- You don't write a callback handler at the HTTP level — Hub handles the redirect internally.
- You don't refresh tokens — Hub does it on `AUTH_EXPIRED`.

#### Standard providers

If your provider follows OAuth 2.0 RFC 6749 + standard refresh (Google, GitHub, Slack, Notion, Linear, etc.), you don't need to override anything. Just declare `@OAuth(...)` and Hub handles everything.

#### Custom providers (PKCE, non-standard refresh, etc.)

Override `handleOAuthCallback(code, redirectUri)`:

```typescript
import { Plugin, Tool, OAuth, AuthError } from '@pdatahub/plugin-sdk';

const TOKEN_URL = 'https://myservice.example.com/oauth/token';  // hardcoded — @OAuth config is on the class, not the instance

@OAuth({
  authorizationUrl: 'https://myservice.example.com/oauth/authorize',
  tokenUrl:         TOKEN_URL,
  scopes:           ['things:read', 'things:write'],
})
export default class MyPlugin extends Plugin {
  name             = 'myservice';
  version          = '0.1.0';
  protocolVersion  = 2 as const;
  capabilities     = ['http', 'oauth'];

  async handleOAuthCallback(code: string, redirectUri?: string) {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: process.env.MYSERVICE_CLIENT_ID!,
        client_secret: process.env.MYSERVICE_CLIENT_SECRET!,
        redirect_uri: redirectUri ?? '',
        grant_type: 'authorization_code',
      }),
    });
    if (!res.ok) {
      throw new AuthError(`token exchange returned ${res.status}`);
    }
    const data = await res.json() as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };
    return {
      accessToken:  data.access_token,
      refreshToken: data.refresh_token,
      expiresIn:    data.expires_in,
    };
  }
}
```

If you find yourself overriding this for a standard OAuth provider, that's a smell — file an issue on the SDK so we can add a flag (`@OAuth({ provider: 'google' | 'github' | ... })`).

### Federation considerations

Federation lets a tool on Hub A be called from Hub B (your laptop) after the A owner issues a signed delegation. Your plugin doesn't need to know who's calling — the Hub handles auth, signing, and audit on both sides.

**What your plugin needs to do:**

1. **Use namespaced scopes.** `myservice:read` is fine. Bare `read` is not — Hub B would have to delegate to a plugin named "read" which is ambiguous. Namespacing makes delegations unambiguous across the federation graph.

2. **Return standard `PluginError` codes.** The Hub uses `NOT_FOUND` to distinguish "delegation revoked" (Hub B sees 404) from "token expired" (Hub B sees 403). Don't return stringly-typed errors.

3. **Don't trust the `context.agent_id` blindly.** It's an opaque identifier from Hub B. Log it for audit but don't make authorization decisions based on its format. Hub B is responsible for authenticating its own users.

4. **Declare `federation-ready` capability if your plugin makes sense cross-hub.** Most do. Don't declare it if your plugin reads locally-stored data that isn't accessible from Hub A (e.g. a "list my local files" plugin).

```typescript
class MyPlugin extends Plugin {
  name             = 'myservice';
  version          = '0.1.0';
  protocolVersion  = 2 as const;
  capabilities     = ['http', 'oauth', 'federation-ready'];
}
```

**What your plugin does NOT need to do:**

- Sign anything — Hub B signs the outbound call to Hub A
- Verify anything — Hub A verifies Hub B's signature before invoking you
- Know about Hub B's identity — Hub A passes only the agent_id and request_id

---

## Testing

The template ships with `examples/hub-mock.ts` — a fake Hub that speaks JSON-RPC and lets you call your plugin's tools directly. Test pattern:

```typescript
// tests/plugin.test.ts
import { describe, it, expect } from 'vitest';
import MyServicePlugin from '../src/index.js';

describe('MyServicePlugin', () => {
  it('readThings returns parsed JSON', async () => {
    const plugin = new MyServicePlugin();
    // Stub the HTTP client to return a fixture instead of hitting the network
    plugin.httpClient = {
      get: async () => ({
        status: 200, headers: {},
        data: [{ id: 1, name: 'thing' }],
      }),
      post: async () => { throw new Error('not used'); },
      put:   async () => { throw new Error('not used'); },
      patch: async () => { throw new Error('not used'); },
      delete: async() => { throw new Error('not used'); },
    } as any;

    const result = await plugin.readThings(1);
    expect(result).toEqual([{ id: 1, name: 'thing' }]);
  });

  it('translates upstream 429 to RateLimitError', async () => {
    const { RateLimitError } = await import('@pdatahub/plugin-sdk');
    const plugin = new MyServicePlugin();
    plugin.httpClient = {
      get: async () => {
        const err = new Error('rate limit') as Error & { status?: number };
        err.status = 429;
        throw err;
      },
      post: async () => { throw new Error('not used'); },
      put:   async () => { throw new Error('not used'); },
      patch: async () => { throw new Error('not used'); },
      delete: async() => { throw new Error('not used'); },
    } as any;

    await expect(plugin.readThings(10)).rejects.toBeInstanceOf(RateLimitError);
  });
});
```

For end-to-end tests that exercise the Hub → plugin pipeline, see `tests/integration.test.ts` in [`pdatahub-plugin-google-calendar`](https://github.com/pdatahub/pdatahub-plugin-google-calendar) — it spawns both a real Hub and a real plugin subprocess and asserts the JSON-RPC round-trip.

**Mock-first.** Don't make tests that depend on the network. If you absolutely must, gate them with `describe.skipIf(!process.env.RUN_NETWORK_TESTS)` so CI doesn't flake.

### Testing input validation

`inputSchema` validation happens **before** dispatch (in Hub, not your plugin), but you can unit-test the schema itself:

```typescript
import Ajv from 'ajv';
const ajv = new Ajv();
const validate = ajv.compile({
  type: 'object',
  properties: { limit: { type: 'integer', minimum: 1, maximum: 100 } },
  required: ['limit'],
});

it('rejects limit > 100', () => {
  expect(validate({ limit: 1000 })).toBe(false);
});
```

---

## Debugging

### Verbose logging

The SDK writes to **stderr**. `stdout` is reserved for JSON-RPC. The Hub forwards stderr to its own log (and ultimately to the audit log on error).

```typescript
this.logger?.info('read 10 things');
this.logger?.warn(`rate limit hit, retrying in 60s`);
this.logger?.error('upstream 500', { endpoint: 'things' });
this.logger?.debug('raw response', response);  // only with PDHUB_DEBUG=1
```

The logger prefix is your plugin name, so logs are easy to grep. Set `PDHUB_DEBUG=1` on the Hub process to enable debug-level output.

**Never write to `stdout` from your code.** Doing so will corrupt the JSON-RPC stream and the Hub will disconnect.

### Common errors

| Symptom | Likely cause |
|---------|--------------|
| Hub logs "plugin disconnected" | You wrote to stdout, or process crashed |
| Hub logs "manifest validation failed" | `protocolVersion` missing, or `capabilities` references unknown feature |
| Hub logs "AUTH_EXPIRED repeatedly" | Your `handleOAuthCallback` returns wrong shape, or refresh token revoked upstream |
| Tool call returns 502 UPSTREAM_ERROR | Your upstream API is failing — check Hub logs for the response body |
| Tool call returns 400 VALIDATION_FAILED | Your `inputSchema` is rejecting valid input — check `required` and `type` |
| Health probe reports `unhealthy` | Lifecycle hook threw — check stderr for stack trace |

### Local dev loop

```bash
# Terminal 1: run plugin in dev mode (reads JSON-RPC from stdin)
pnpm dev

# Terminal 2: feed it an initialize request
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | nc -U /tmp/plugin.sock
```

Or use the bundled `examples/hub-mock.ts`:

```bash
pnpm tsx examples/hub-mock.ts
```

This spawns your plugin subprocess, sends `initialize`, then exposes a REPL for typing `tools/call` invocations. Type `.exit` to quit.

---

## Distribution

Plugins are distributed via **GitHub Releases** as `.tgz` archives. Not npm — see [docs/architecture.md §Plugin SDK distribution](./architecture.md#plugin-sdk-distribution) for why.

### Build the .tgz

```bash
pnpm pack
# → myservice-0.1.0.tgz
```

Make sure `package.json` `files` field lists exactly what should ship — usually just `dist/`, `package.json`, and a `README.md`. Don't include `src/`, `tests/`, `.env`, or anything sensitive.

### Tag and release

```bash
git tag v0.1.0
git push --tags

gh release create v0.1.0 \
  myservice-0.1.0.tgz \
  --title "v0.1.0" \
  --notes "Initial release: readThings tool"
```

Attach the `.tgz` as a binary asset. Users install by URL (see below).

### User installation

The Hub CLI (`pdatahub-hub`) accepts a release URL and downloads the asset:

```bash
pdatahub-hub plugin install \
  https://github.com/<your-org>/pdatahub-plugin-myservice/releases/latest/download/myservice-0.1.0.tgz
```

The Hub unpacks it into `--plugins-dir/<plugin-name>/`, validates the manifest (manifest schema is fixed in Hub, so a v1 manifest throws), and starts using it on the next tool call.

### Uninstall

```bash
pdatahub-hub plugin uninstall myservice
```

This stops the subprocess (if running), revokes any grants for `myservice:*` scopes, and removes the directory from `--plugins-dir`.

### Versioning

- Bump **patch** (`0.1.0` → `0.1.1`) for backward-compatible changes (new tool, bug fix).
- Bump **minor** (`0.1.0` → `0.2.0`) for backward-incompatible changes (renamed tool, removed scope, changed argument signature, raised `protocolVersion` requirement).
- Don't bump major until we ship `v1.0.0` of Hub.

---

## Best practices

1. **Always declare `inputSchema`.** Even for "trivial" tools. AI agents are creative; validation is your defense. Required fields, types, bounds, enums — be strict.

2. **Use namespaced scopes.** `myservice:read`, `myservice:write` — not just `read`. Hub groups grants by scope, and your users see scopes in the approval prompt. Federation requires namespacing.

3. **Translate upstream errors to `PluginError` codes.** Don't return `Error('upstream returned 500')`. Use `PluginError({code: 'UPSTREAM_ERROR', retryable: true})` so the AI agent can decide whether to back off.

4. **Set `retryable: true` only for transient errors.** 5xx and rate limits yes; 4xx no. Setting `retryable: true` on a `NOT_FOUND` causes the AI agent to spam the user.

5. **Return user-friendly error messages.** The Hub logs raw errors, but the user sees whatever string the AI agent surfaces. If MyService returned a 429 with `Retry-After: 60`, return `'Rate limited; try again in 60 seconds'` so the agent can adapt.

6. **Don't store tokens.** Hub handles all persistence. If you find yourself wanting to write to disk, you probably want to add the data to Hub's storage via `onInstall`/`onUninstall` or skip it.

7. **Don't make network calls outside `this.httpClient`.** No raw `fetch()`, no `http`/`https` module. Only `httpClient` carries the bearer token, audits calls, and respects rate limits.

8. **Keep methods idempotent where possible.** Hub may retry on transient errors. `createThing` followed by `createThing` (after a retry) should not produce duplicates — use idempotency keys or upsert semantics.

9. **Respect scopes.** A tool declared with `scope: 'myservice:read'` should never write. If it must, declare `myservice:write` and let the Hub group them as separate grants.

10. **Log to `stderr`, debug to `PDHUB_DEBUG=1`.** Keep stdout pristine.

11. **Set reasonable timeouts.** Default HTTP client timeout is 30s. Override per-request if your endpoint is slower: `await this.httpClient!.get('slow', { timeoutMs: 120_000 })`.

12. **Don't crash on transient errors.** Wrap upstream calls in try/catch, return a structured `PluginError`, log it. The Hub retries on 5xx; if you throw, the call fails and the user sees a 500.

13. **Override `health()` when you have non-trivial state.** If you cache an upstream API token, report `degraded` when it's within 5 min of expiry. The Hub surfaces this to the user BEFORE the first failed call.

14. **Document tool descriptions for the AI.** "Send an email to a recipient" is worse than "Send an email to one recipient with optional CC. Returns the message ID of the sent email." The agent uses these descriptions to pick the right tool.

---

## Security checklist

Before publishing a plugin:

- [ ] `inputSchema` declared on every tool with non-trivial input
- [ ] All upstream errors translated to `PluginError` codes (no raw `Error` thrown)
- [ ] Scopes are namespaced (`myservice:read`, not `read`)
- [ ] No tokens, no client secrets in source (Hub provides them via env)
- [ ] No raw `fetch()` / `http` calls — only `this.httpClient`
- [ ] No file system writes outside plugin's own `--plugins-dir/<plugin-name>/`
- [ ] No network calls to unexpected hosts (verify all hosts are upstream API endpoints)
- [ ] Manifest capabilities accurately describe what the plugin does
- [ ] `package.json` `files` field excludes `src/`, `tests/`, `.env`
- [ ] Plugin tested with mock OAuth tokens (don't ship with real ones)

---

## Migration from v1

If you have an existing v1 plugin:

1. **Bump SDK dep** to `>= 0.2.0`:
   ```json
   "@pdatahub/plugin-sdk": "https://github.com/pdatahub/pdatahub/releases/download/sdk-v0.2.2/pdatahub-plugin-sdk-0.2.2.tgz"
   ```

2. **Add `protocolVersion = 2 as const`** to your class.

3. **Rename `this.http` → `this.httpClient`.** (No deprecated alias — v1 plugins on protocolVersion=1 still work because their templates don't reference `this.httpClient`, but once you opt in to v2 you must use the new name.)

4. **Replace raw `Error` throws with typed `PluginError` subclasses** — `AuthError`, `AuthExpiredError`, `NotFoundError`, `RateLimitError`, `TimeoutError`, `NetworkError`, `ValidationError`, `ScopeError`. See §Errors above.

5. **Declare `capabilities[]`** — usually `['http', 'oauth']` plus `'federation-ready'` if appropriate.

6. **Add `inputSchema` to every `@Tool` declaration.** Mandatory in v2.

7. **Optionally override `health()`** to surface plugin-specific state.

That's it. v1 plugins without these changes keep working unchanged because `protocolVersion` defaults to `1`.

---

## Reference: canonical example

[`pdatahub-plugin-google-calendar`](https://github.com/pdatahub/pdatahub-plugin-google-calendar) is the reference implementation. Read its:

- `src/index.ts` — full `@OAuth` + `@Tool` + `PluginError` + `inputSchema` pattern
- `tests/plugin.test.ts` — vitest mocking pattern, including error translation
- `tests/integration.test.ts` — full Hub + plugin subprocess round-trip
- `package.json` — the GitHub-Releases dep, scripts, and `files` field
- `.github/workflows/release.yml` — automated `.tgz` upload on tag

## Reference: SDK API

The full SDK API lives at [`packages/plugin-sdk/README.md`](../packages/plugin-sdk/README.md). For decorator and HTTP client type signatures, see [§API reference](../packages/plugin-sdk/README.md#api-reference).

## Reference: scaffold template

[`pdatahub-plugin-template`](https://github.com/pdatahub/pdatahub-plugin-template) — use `gh repo create my-plugin --template pdatahub/pdatahub-plugin-template` to start. Includes CI workflow that builds the `.tgz` and uploads it to a GitHub Release on every tag.

## License

Plugins you author are your own work — publish them under whatever license you choose (MIT recommended for ecosystem consistency). The Hub and SDK are MIT; your plugin can be MIT, Apache-2.0, or proprietary. The `@pdatahub/plugin-sdk` dependency is MIT.
