# @pdatahub/mcp-server

MCP server that bridges AI agents (OpenCode, Claude Code, Cursor, ...) to **pdatahub Hub** running on the user's phone.

The Hub owns the data and the OAuth tokens. This server is a thin proxy that:

1. Fetches the user's installed tool list from the Hub on startup
2. Registers each tool with the MCP server (so the AI agent sees them)
3. On `tools/call` from the AI agent → forwards to Hub → returns result

Hub is the source of truth for tool contracts. This server does not validate args (Hub does that).

## Install

```bash
pnpm add -g @pdatahub/mcp-server
```

## Run

```bash
pdatahub-mcp \
  --hub-url http://192.168.1.10:8080 \
  --token <session-token>
```

Or via environment variables:

```bash
PDAHUB_HUB_URL=http://192.168.1.10:8080 \
PDAHUB_SESSION_TOKEN=<token> \
pdatahub-mcp
```

## Wire to Claude Code / OpenCode

In your AI agent's MCP config, point at this server:

```json
{
  "mcpServers": {
    "pdatahub": {
      "command": "pdatahub-mcp",
      "args": ["--hub-url", "http://192.168.1.10:8080"],
      "env": {
        "PDAHUB_SESSION_TOKEN": "<token>"
      }
    }
  }
}
```

## Hub API contract

The Hub must expose two endpoints:

```
GET  /v1/tools
POST /v1/tools/{name}/call
```

Both require `Authorization: Bearer <session-token>`.

### `GET /v1/tools`

Response:

```json
{
  "tools": [
    {
      "name": "calendar.read.events",
      "description": "Read calendar events in a date range",
      "inputSchema": {
        "type": "object",
        "properties": {
          "from": { "type": "string", "format": "date-time" },
          "to":   { "type": "string", "format": "date-time" }
        }
      },
      "scope": "calendar:read",
      "plugin": "google-calendar"
    }
  ]
}
```

### `POST /v1/tools/{name}/call`

Request:

```json
{
  "name": "calendar.read.events",
  "arguments": {
    "from": "2026-01-01T00:00:00Z",
    "to":   "2026-01-08T00:00:00Z"
  }
}
```

Response (success):

```json
{
  "content": [
    { "type": "text", "text": "Jan 1: standup..." }
  ]
}
```

Response (tool error — propagated to MCP `isError`):

```json
{
  "content": [
    { "type": "text", "text": "Rate limited, retry in 60s" }
  ],
  "isError": true
}
```

## Local development

```bash
pnpm install
pnpm build
pnpm test

# Manual smoke test with mock Hub:
node examples/hub-mock.js &              # mock Hub on :7777
pdatahub-mcp --hub-url http://localhost:7777 --token dev
```

## Architecture

```
┌──────────────┐   MCP/stdio   ┌──────────────┐   HTTP    ┌──────────┐
│  AI Agent    │ ────────────► │ pdatahub-mcp │ ────────► │   Hub    │
│ (OpenCode)   │               │  (laptop)    │           │ (phone)  │
└──────────────┘               └──────────────┘           └──────────┘
                                                                │
                                                                ▼
                                                         ┌──────────────┐
                                                         │   Plugins    │
                                                         │ (subprocess) │
                                                         └──────────────┘
```

For real deployments the AI agent is typically not on the same network as the phone. Add a relay between them (Cloudflare Worker or similar):

```
AI Agent → MCP server → relay (e.g. wss://relay.example.com) → Hub
```

The MCP server only knows about a `hubUrl`. Whether that URL is direct or via relay is transparent.

## Logging

All logs go to **stderr**. `stdout` is reserved for the MCP protocol — never write logs there.

```
2026-09-03T15:00:00.000Z [INFO] Starting pdatahub-mcp hubUrl=http://192.168.1.10:8080
2026-09-03T15:00:00.123Z [INFO] Loaded 3 tools from Hub
2026-09-03T15:00:00.200Z [INFO] MCP server connected
```

Set log level via `--log-level debug` or `PDAHUB_LOG_LEVEL=debug`.

## License

MIT
