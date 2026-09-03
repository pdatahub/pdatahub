# @pdatahub/plugin-sdk

The SDK for writing [pdatahub](https://github.com/yourorg/pdatahub) plugins in TypeScript.

A pdatahub plugin is an external service connector (Google Calendar, Slack, Trello, GitHub, ...) that runs as a subprocess and communicates with the Hub via [JSON-RPC 2.0](https://www.jsonrpc.org/specification) over stdio.

This SDK hides all of that behind a tiny, decorator-driven API. A basic plugin is **~30 lines**:

```typescript
import { Plugin, Tool, OAuth } from '@pdatahub/plugin-sdk';

@OAuth({
  authorizationUrl: 'https://slack.com/oauth/authorize',
  tokenUrl: 'https://slack.com/api/oauth.token',
  scopes: ['channels:history', 'chat:write'],
})
export default class SlackPlugin extends Plugin {
  name = 'slack';
  version = '0.1.0';

  @Tool({ scope: 'messages.read', description: 'Read recent Slack messages' })
  async readMessages(channel: string, days = 7) {
    const response = await this.httpClient!.get('conversations.history', {
      params: { channel, days },
    });
    return response.data;
  }

  @Tool({ scope: 'messages.send', description: 'Send a message' })
  async sendMessage(channel: string, text: string) {
    return await this.httpClient!.post('chat.postMessage', { channel, text });
  }
}

// Launch:
new SlackPlugin().start();
```

## Contents

- [Installation](#installation)
- [Quick start](#quick-start)
- [Concepts](#concepts)
  - [Plugin lifecycle](#plugin-lifecycle)
  - [Tool methods](#tool-methods)
  - [OAuth flows](#oauth-flows)
  - [HTTP client](#http-client)
  - [Lifecycle hooks](#lifecycle-hooks)
- [How it works (protocol)](#how-it-works-protocol)
- [Best practices](#best-practices)
- [Debugging](#debugging)
- [API reference](#api-reference)

## Installation

```bash
pnpm add @pdatahub/plugin-sdk
```

Requires Node.js 20+.

## Quick start

### 1. Scaffold a plugin package

```
my-plugin/
├── package.json
├── tsconfig.json
└── src/
    └── index.ts
```

`package.json`:
```json
{
  "name": "pdatahub-plugin-slack",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "@pdatahub/plugin-sdk": "*"
  },
  "devDependencies": {
    "typescript": "^5.4.0",
    "@types/node": "^20.0.0"
  }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "strict": true,
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*"]
}
```

### 2. Write your plugin

```typescript
// src/index.ts
import { Plugin, Tool, OAuth } from '@pdatahub/plugin-sdk';

@OAuth({
  authorizationUrl: 'https://slack.com/oauth/authorize',
  tokenUrl: 'https://slack.com/api/oauth.token',
  scopes: ['channels:history', 'chat:write'],
})
export default class SlackPlugin extends Plugin {
  name = 'slack';
  version = '0.1.0';
  description = 'Slack integration for pdatahub';

  @Tool({ scope: 'messages.read', description: 'Read recent Slack messages from a channel' })
  async readMessages(channel: string, days = 7) {
    const response = await this.httpClient!.get('conversations.history', {
      params: { channel, days },
    });
    return response.data;
  }

  @Tool({ scope: 'messages.send', description: 'Send a message to a channel' })
  async sendMessage(channel: string, text: string) {
    return await this.httpClient!.post('chat.postMessage', { channel, text });
  }
}

if (require.main === module) {
  new SlackPlugin().start();
}
```

### 3. Build and run

```bash
pnpm install
pnpm build
node dist/index.js
```

The plugin listens on stdin and writes to stdout. The Hub launches it as a subprocess and pipes the JSON-RPC stream.

## Concepts

### Plugin lifecycle

1. Hub starts the plugin subprocess.
2. Hub sends an `initialize` request. Plugin responds with the manifest (name, version, tools, OAuth config).
3. Plugin's `onStart()` hook runs.
4. Hub sends `tools/call` requests as needed. Plugin dispatches to the appropriate `@Tool`-decorated method.
5. Hub sends a `shutdown` notification when done. Plugin's `onShutdown()` hook runs. Process exits with code 0.

### Tool methods

A tool is a method on your plugin class, decorated with `@Tool`.

```typescript
@Tool({ scope: 'messages.read', description: 'Read Slack messages' })
async readMessages(channel: string, days = 7) {
  // ...
}
```

- **`scope`** — A human-readable permission identifier (e.g. `messages.read`). The Hub uses this to prompt the user for consent before calling the tool.
- **`description`** — Shown to the AI agent so it knows when to invoke the tool.

Arguments passed by the Hub are forwarded **positionally** to the method. Return values are serialized back to the Hub.

### OAuth flows

If your plugin requires authentication, decorate the class with `@OAuth`:

```typescript
@OAuth({
  authorizationUrl: 'https://slack.com/oauth/authorize',
  tokenUrl: 'https://slack.com/api/oauth.token',
  scopes: ['channels:history', 'chat:write'],
})
class SlackPlugin extends Plugin { ... }
```

Override `handleOAuthCallback()` to exchange the auth code for a token:

```typescript
async handleOAuthCallback(code: string, redirectUri?: string) {
  const response = await fetch(this.oauthConfig!.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: process.env.SLACK_CLIENT_ID!,
      client_secret: process.env.SLACK_CLIENT_SECRET!,
      redirect_uri: redirectUri ?? '',
    }),
  });
  const data = await response.json() as { access_token: string; refresh_token?: string };
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: 3600,
  };
}
```

### HTTP client

Every tool invocation gets an authenticated HTTP client at `this.httpClient`. It automatically attaches the user's OAuth bearer token.

```typescript
@Tool({ scope: 'things.read', description: '...' })
async listThings(limit: number) {
  // GET https://api.example.com/things?_limit=10
  // Authorization: Bearer <user's token>
  const response = await this.httpClient!.get('/things', { params: { _limit: limit } });
  return response.data;
}
```

Methods available: `get`, `post`, `put`, `patch`, `delete`.

### Lifecycle hooks

Override these methods on your plugin class to hook into the lifecycle:

| Hook | When | Use for |
|------|------|---------|
| `onStart()` | After `initialize`, before any tool calls | Setup, cache warming |
| `onToolResult(name, result)` | After each successful tool call | Logging, metrics |
| `onShutdown()` | After `shutdown` notification | Cleanup |

## How it works (protocol)

The plugin process and the Hub communicate over stdin/stdout using newline-delimited JSON-RPC 2.0 messages.

### Critical invariant

**stdout is protocol only. stderr is logs only.**

If you write anything other than valid JSON-RPC to stdout, the Hub will fail to parse messages and the plugin will hang or crash.

The SDK handles this for you: the `Logger` writes only to stderr, and `StdioTransport` writes only valid JSON-RPC to stdout. Don't bypass them.

### Message flow

```
Hub → plugin (stdin):     {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"hubVersion":"1.0"}}
Plugin → Hub (stdout):    {"jsonrpc":"2.0","id":1,"result":{"name":"slack","version":"0.1.0","tools":[...]}}

Hub → plugin (stdin):     {"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"readMessages","arguments":["#general",7],"context":{"token":"xoxb-..."}}}
Plugin → Hub (stdout):    {"jsonrpc":"2.0","id":2,"result":{"data":{"messages":[...]}}}

Hub → plugin (stdin):     {"jsonrpc":"2.0","method":"shutdown"}
                          (notification, no response expected)
```

Notifications (no `id`) get no reply. Requests (with `id`) always get a reply — either `result` or `error`.

## Best practices

1. **Make tool methods idempotent where possible.** The Hub may retry failed calls.
2. **Use specific scopes.** `messages.read` is better than `data.read`. Users see these in consent prompts.
3. **Validate inputs.** Tool args come from the AI agent, which may produce nonsense. Validate or coerce early.
4. **Don't write to stdout from your code.** The protocol is the only thing that should go there.
5. **Set reasonable timeouts.** The HTTP client defaults to 30s. Override per-request if you have a slow endpoint.
6. **Use `this.logger` for diagnostics.** It goes to stderr and respects `PDHUB_DEBUG=1`.

## Debugging

Set `PDHUB_DEBUG=1` to enable debug logs:

```bash
PDHUB_DEBUG=1 node dist/index.js
```

The plugin's stderr will show:
- Each incoming JSON-RPC request (info level)
- Tool invocations and their results
- Network errors with full stack traces

## API reference

### `Plugin` (abstract class)

```typescript
abstract class Plugin {
  abstract name: string;
  abstract version: string;
  description?: string;

  protected httpClient: HttpClient | undefined;
  protected logger: Logger | undefined;

  async start(): Promise<void>;
  async dispatch(req: JsonRpcRequest): Promise<JsonRpcResponse | null>;

  async handleOAuthCallback(code: string, redirectUri?: string): Promise<{
    accessToken: string;
    refreshToken?: string;
    expiresIn?: number;
  }>;

  async onStart(): Promise<void>;
  async onShutdown(): Promise<void>;
  async onToolResult(name: string, result: unknown): Promise<void>;
}
```

### `@Tool(options)`

```typescript
function Tool(options: ToolOptions): ClassMemberDecorator;

interface ToolOptions {
  scope: string;
  description: string;
}
```

### `@OAuth(config)`

```typescript
function OAuth(config: OAuthConfig): ClassDecorator;

interface OAuthConfig {
  authorizationUrl: string;
  tokenUrl: string;
  scopes: string[];
  tokenMethod?: 'GET' | 'POST';
  extraTokenParams?: Record<string, string>;
}
```

### `HttpClient`

```typescript
class HttpClient {
  constructor(context: HttpContext, options?: HttpClientOptions);

  get<T>(path: string, options?: { params?: Record<string, unknown> }): Promise<HttpResponse<T>>;
  post<T>(path: string, body?: unknown, options?: { params?: Record<string, unknown> }): Promise<HttpResponse<T>>;
  put<T>(path: string, body?: unknown, options?: { params?: Record<string, unknown> }): Promise<HttpResponse<T>>;
  patch<T>(path: string, body?: unknown, options?: { params?: Record<string, unknown> }): Promise<HttpResponse<T>>;
  delete<T>(path: string, options?: { params?: Record<string, unknown> }): Promise<HttpResponse<T>>;
}
```

### `Logger`

```typescript
class Logger {
  constructor(prefix: string);
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
}
```

Debug logs are emitted only when `PDHUB_DEBUG=1`.

## License

MIT