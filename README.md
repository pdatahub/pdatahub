# pdatahub — Personal Data Hub

[![CI](https://github.com/pdatahub/pdatahub/actions/workflows/ci.yml/badge.svg)](https://github.com/pdatahub/pdatahub/actions/workflows/ci.yml)

> Privacy-first personal data platform with MCP integration and verifiable grants.

**Status:** Private (PoC phase). Will become public after MVP.

## Architecture

pdatahub is a **plugin-based integration platform** for personal data:

- **Android app** (`packages/android-app/`) — Hub runtime. Owns OAuth tokens, policy engine, approval UI.
- **Plugin SDK** (`packages/plugin-sdk/`) — TypeScript SDK for 3rd-party plugin developers.
- **MCP server** (`packages/mcp-server/`) — Bridges Hub with AI-agents on laptop via MCP protocol.
- **Relay** (`packages/relay/`) — Cloudflare Worker for routing requests between laptop and phone.
- **Plugins** (separate repos) — Slack, Trello, Calendar, Notion, etc.

## Why this project?

AI-agents need access to personal data, but today:
- Composio / Apple Health / Google Takeout are closed systems
- No user control over scope, duration, or audit
- No way to selectively share specific data with specific agents

pdatahub solves this with **declarative scopes, time-bounded grants, and local-first audit**.

## Status

🚧 **Private, pre-MVP**. Don't use yet.

See `~/Документы/Obsidian/Работа/Personal Data Hub/` for design notes.

## License

TBD
