# Plugin Author Guide

A pdatahub plugin is a Node.js subprocess that exposes one external service (Google Calendar, Slack, Notion, GitHub, ...) as a set of typed tools. The Hub holds the OAuth tokens, approves each call, injects a decrypted access token into the plugin's HTTP client at call time, and writes an audit row.

This guide walks you through authoring, testing, packaging, and distributing a plugin. The canonical example is [`pdatahub-plugin-google-calendar`](https://github.com/pdatahub/pdatahub-plugin-google-calendar) — read it alongside this guide.

## What is a plugin?

A plugin is:

1. **A Node.js process** spawned by Hub on first tool call. Communication is JSON-RPC 2.0 over stdio. `stdout` is protocol-only; `stderr` is your logs.
2. **Scoped to one external service** — one plugin = one OAuth provider (or API token). If your integration spans two services, write two plugins.
3. **Stateless and side-effect-free at boot.** Hub may spawn and kill your plugin any number of times. Persistent state belongs in the Hub's storage, not your plugin.
4. **Trusted with one specific access token** per call. The Hub decrypts it from its vault, injects it via the SDK's `this.http` HTTP client. **Your plugin never sees the raw token as a string** — it makes authenticated requests via `this.http.get(...)`.

## Quickstart

### 1. Scaffold from the template

The fastest path:

```bash
gh repo create my-plugin --template pdatahub/pdatahub-plugin-template --public --clone
cd my-plugin
```

Or fork [`pdatahub-plugin-google-calendar`](https://github.com/pdatahub/pdatahub-plugin-google-calendar) and edit. The template ships with:

- `package.json` referencing `@pdatahub/plugin-sdk` from GitHub Releases
- `tsconfig.json` extending the SDK's recommended config
- `src/index.ts` with a minimal Hello-World tool
- `vitest.config.ts` and `tests/plugin.test.ts`
- `examples/hub-mock.ts` so you can run your plugin against a fake Hub during development

### 2. Install dependencies

```bash
pnpm install
```

The SDK is downloaded from GitHub Releases — `package.json` points at `https://github.com/pdatahub/pdatahub/releases/download/<version>/pdatahub-plugin-sdk-<version>.tgz`. If you're using a version we haven't published yet, point at the local path: `"@pdatahub/plugin-sdk": "file:../pdatahub/packages/plugin-sdk"`.

### 3. Run dev mode

```bash
pnpm dev
```

This starts the plugin in dev mode: it prints JSON-RPC to stdout as if Hub had spawned it. You can paste messages into a JSON-RPC debugger (or just `cat | nc`) to test individual tool calls.

### 4. Write your plugin

```typescript
// src/index.ts
import { Plugin, Tool, OAuth } from '@pdatahub/plugin-sdk';

@OAuth({
  authorizationUrl: 'https://myservice.example.com/oauth/authorize',
  tokenUrl:         'https://myservice.example.com/oauth/token',
  scopes:           ['things:read'],
})
export default class MyServicePlugin extends Plugin {
  name        = 'myservice';
  version     = '0.1.0';
  description = 'MyService integration for pdatahub';

  @Tool({
    scope:       'myservice:read',
    description: 'Read recent things from MyService',
  })
  async readThings(limit: number = 10) {
    const { data } = await this.http!.get('things', { params: { limit } });
    return data;
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

When Hub spawns your plugin, it sends an `initialize` request. The SDK auto-responds with the manifest derived from `@OAuth` and `@Tool` decorators. Hub then registers your tools and dispatches calls.

## Concepts

### Manifest & tool decorators

Two decorators do almost all of the work:

- **`@OAuth(config)`** — applied to the class. Tells Hub how to run the OAuth dance (`authorizationUrl`, `tokenUrl`, `scopes`). Hub handles the redirect, token exchange, and refresh.
- **`@Tool({ scope, description, inputSchema? })`** — applied to each method. Declares the tool's name (derived from method name, or override via `name:`), the OAuth scope required to call it, and the human-readable description shown to the AI agent and to the user in the approval prompt.

```typescript
@Tool({
  scope:       'myservice:read',
  description: 'Read recent things',
  // Optional: validate inputs with JSON Schema
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 10 },
    },
    required: [],
  },
})
async readThings(limit: number = 10) { /* ... */ }
```

The Hub uses `scope` to group approval prompts. If a user already approved `myservice:read` for a previous tool call, they get a 1-hour grant and won't be re-prompted for any other tool with the same scope. Choose scopes that meaningfully describe the action — `myservice:read` beats `read` because it namespaces your plugin.

### Plugin lifecycle

1. Hub spawns the plugin subprocess.
2. Hub sends `{"method": "initialize", ...}`. The SDK auto-responds with the manifest.
3. Hub calls `onStart()` (your override). Use this for cache warming, telemetry, etc.
4. For each tool call, Hub sends `{"method": "tools/call", "params": {...}, "context": {token, agent_id, request_id}}`. The SDK dispatches to your `@Tool`-decorated method.
5. After each tool call, Hub calls `onToolResult(name, result)`. Override for logging / metrics.
6. When Hub is done, it sends `{"method": "shutdown"}`. Your `onShutdown()` runs; the process exits.

You can override any lifecycle hook:

```typescript
class MyPlugin extends Plugin {
  async onStart() {
    this.logger?.info('plugin starting');
  }
  async onToolResult(name: string, result: unknown) {
    this.logger?.debug(`tool ${name} returned`, result);
  }
  async onShutdown() {
    this.logger?.info('plugin shutting down');
  }
}
```

### OAuth integration

You do **not** write the OAuth dance. Hub runs the redirect, captures the auth code, exchanges it for tokens, stores them encrypted in its vault, and passes you a decrypted access token at call time.

What you **do** declare:

- `authorizationUrl`, `tokenUrl`, `scopes` in `@OAuth`
- `client_id`, `client_secret` as environment variables on the Hub: `HUB_CLIENT_<PLUGIN>_ID` and `HUB_CLIENT_<PLUGIN>_SECRET` (e.g. `HUB_CLIENT_GOOGLE_CALENDAR_ID`, `HUB_CLIENT_GOOGLE_CALENDAR_SECRET`). The Hub operator sets these.

What you **don't** do:

- You don't see the raw token. You don't need `client_secret` in your plugin process.
- You don't write a callback handler. Hub handles `handleOAuthCallback` internally.

If your provider has quirks (e.g. requires PKCE, or non-standard refresh), override `handleOAuthCallback(code, redirectUri)`:

```typescript
async handleOAuthCallback(code: string, redirectUri?: string) {
  const res = await fetch(this.oauthConfig!.tokenUrl, {
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
```

If you find yourself overriding this for a standard OAuth provider, that's a smell — file an issue on the SDK.

### HTTP client (`this.http`)

Every tool call gets a per-call HTTP client at `this.http` (a thin wrapper over `undici.fetch`). It auto-injects `Authorization: Bearer <decrypted_access_token>`, follows standard semantics, and bubbles up non-2xx responses as errors with the response body attached.

```typescript
@Tool({ scope: 'myservice:read', description: 'List things' })
async listThings(limit: number = 10) {
  // GET https://api.myservice.com/things?limit=10
  // Authorization: Bearer <user's access token>
  const res = await this.http!.get('things', { params: { limit } });
  return res.data;  // already parsed JSON
}
```

Methods: `get(path, options?)`, `post(path, body?, options?)`, `put`, `patch`, `delete`. All return `{ status, headers, data }`.

**Never call `fetch()` directly.** Always use `this.http`. Reasons:

1. Direct `fetch` won't have the bearer token injected — your call will 401.
2. Hub can't observe or audit calls that bypass `this.http`.
3. Token refresh (handled by Hub) only fires when you go through `this.http`.

### Logging

The SDK writes to **stderr**. `stdout` is reserved for JSON-RPC. The Hub forwards stderr to its own log (and ultimately to the audit log on error).

```typescript
this.logger?.info('read 10 things');
this.logger?.warn(`rate limit hit, retrying in 60s`);
this.logger?.error('upstream 500', { endpoint: 'things' });
this.logger?.debug('raw response', response);  // only with PDHUB_DEBUG=1
```

The logger prefix is your plugin name, so logs are easy to grep. Set `PDHUB_DEBUG=1` on the Hub process to enable debug-level output.

**Never write to `stdout` from your code.** Doing so will corrupt the JSON-RPC stream and the Hub will disconnect.

### Testing

The template ships with `examples/hub-mock.ts` — a fake Hub that speaks JSON-RPC and lets you call your plugin's tools directly. Test pattern:

```typescript
// tests/plugin.test.ts
import { test, expect } from 'vitest';
import MyServicePlugin from '../src/index.js';

test('readThings returns parsed JSON', async () => {
  const plugin = new MyServicePlugin();
  // Stub the HTTP client to return a fixture instead of hitting the network
  plugin['http'] = {
    get: async () => ({ status: 200, headers: {}, data: [{ id: 1, name: 'thing' }] }),
    post: async () => { throw new Error('not used'); },
    /* ... */
  } as any;

  const result = await plugin.readThings(1);
  expect(result).toEqual([{ id: 1, name: 'thing' }]);
});
```

For end-to-end tests that exercise the Hub → plugin pipeline, see `tests/integration.test.ts` in [`pdatahub-plugin-google-calendar`](https://github.com/pdatahub/pdatahub-plugin-google-calendar) — it spawns both a real Hub and a real plugin subprocess and asserts the JSON-RPC round-trip.

**Mock-first.** Don't make tests that depend on the network. If you absolutely must, gate them with `describe.skipIf(!process.env.RUN_NETWORK_TESTS)` so CI doesn't flake.

### Distribution

Plugins are distributed via **GitHub Releases** as `.tgz` archives. Not npm — see [docs/architecture.md §Plugin SDK distribution](./architecture.md#plugin-sdk-distribution) for why.

#### Build the .tgz

```bash
pnpm pack
# → myservice-0.1.0.tgz
```

Make sure `package.json` `files` field lists exactly what should ship — usually just `dist/`, `package.json`, and a `README.md`. Don't include `src/`, `tests/`, `.env`, or anything sensitive.

#### Tag and release

```bash
git tag v0.1.0
git push --tags

gh release create v0.1.0 \
  myservice-0.1.0.tgz \
  --title "v0.1.0" \
  --notes "Initial release: readThings tool"
```

Attach the `.tgz` as a binary asset. Users install by URL (see below).

#### User installation

The Hub CLI (`pdatahub-hub`) accepts a release URL and downloads the asset:

```bash
pdatahub-hub plugin install \
  https://github.com/<your-org>/pdatahub-plugin-myservice/releases/latest/download/myservice-0.1.0.tgz
```

The Hub unpacks it into `--plugins-dir/<plugin-name>/`, validates the manifest, and starts using it on the next tool call.

### Versioning

- Bump **patch** (`0.1.0` → `0.1.1`) for backward-compatible changes (new tool, bug fix).
- Bump **minor** (`0.1.0` → `0.2.0`) for backward-incompatible changes (renamed tool, removed scope, changed argument signature).
- Don't bump major until we ship `v1.0.0` of Hub.

## Best practices

1. **Always validate input.** Use `inputSchema` (JSON Schema) on `@Tool` and early-validate in the method. AI agents are creative; the validation is your defense.
2. **Use semantic scope names.** `myservice:read`, `myservice:write` — not just `read`. The Hub groups grants by scope, and your users see scopes in the approval prompt.
3. **Return user-friendly error messages.** The Hub logs raw errors, but the user sees whatever string the AI agent surfaces. If MyService returned a 429 with `Retry-After: 60`, return `{ error: 'Rate limited; try again in 60 seconds', retry_after: 60 }` so the agent can adapt.
4. **Don't store tokens.** Hub handles all persistence. If you find yourself wanting to write to disk, you probably want to add the data to Hub's storage or skip it.
5. **Don't make network calls outside `this.http`.** No raw `fetch()`, no `http`/`https` module. Only `this.http` carries the bearer token, and Hub audits calls through it.
6. **Keep methods idempotent where possible.** The Hub may retry on transient errors.
7. **Respect scopes.** A tool declared with `scope: 'myservice:read'` should never write. If it must, declare `myservice:write` and let the Hub group them as separate grants.
8. **Log to `stderr`, debug to `PDHUB_DEBUG=1`.** Keep stdout pristine.
9. **Set reasonable timeouts.** The default HTTP client timeout is 30s. Override per-request if your endpoint is slower: `await this.http!.get('slow', { timeoutMs: 120_000 })`.
10. **Don't crash on transient errors.** Wrap upstream calls in try/catch, return a structured error, log it. The Hub retries on 5xx; if you throw, the call fails.

## Reference: canonical example

[`pdatahub-plugin-google-calendar`](https://github.com/pdatahub/pdatahub-plugin-google-calendar) is the reference implementation. Read its:

- `src/index.ts` — full `@OAuth` + `@Tool` pattern with input schema
- `tests/plugin.test.ts` — vitest mocking pattern
- `tests/integration.test.ts` — full Hub + plugin subprocess round-trip
- `package.json` — the GitHub-Releases dep, scripts, and `files` field
- `.github/workflows/release.yml` — automated `.tgz` upload on tag

## Reference: SDK API

The full SDK API lives at [`packages/plugin-sdk/README.md`](../packages/plugin-sdk/README.md). For decorator and HTTP client type signatures, see [§API reference](../packages/plugin-sdk/README.md#api-reference).

## Reference: scaffold template

[`pdatahub-plugin-template`](https://github.com/pdatahub/pdatahub-plugin-template) — use `gh repo create my-plugin --template pdatahub/pdatahub-plugin-template` to start. Includes CI workflow that builds the `.tgz` and uploads it to a GitHub Release on every tag.

## License

Plugins you author are your own work — publish them under whatever license you choose (MIT recommended for ecosystem consistency). The Hub and SDK are MIT; your plugin can be MIT, Apache-2.0, or proprietary. The `@pdatahub/plugin-sdk` dependency is MIT.

---

If something in this guide is wrong or unclear, [open an issue](https://github.com/pdatahub/pdatahub/issues/new). If you want to suggest a plugin we should build, see the [plugin idea issue template](../.github/ISSUE_TEMPLATE/plugin_idea.md).