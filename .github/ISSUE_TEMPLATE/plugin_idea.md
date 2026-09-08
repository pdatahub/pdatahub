---
name: Plugin idea
about: Suggest a plugin we should build — Google Calendar, Slack, Notion, GitHub, etc.
title: "[plugin idea]: <service>"
labels: ["plugin", "needs-triage"]
assignees: []
---

## Which service?

Which external service should this plugin integrate with?

- [ ] Google Calendar
- [ ] Google Drive
- [ ] Gmail
- [ ] Slack
- [ ] Notion
- [ ] Linear
- [ ] GitHub
- [ ] Trello
- [ ] Discord
- [ ] Todoist
- [ ] Other: `<name>`

## Tools needed

List the actions (tools) you'd want the plugin to expose, with the OAuth scope required for each:

| Tool name | Description | OAuth scope(s) |
|-----------|-------------|----------------|
| `listEvents` | Read calendar events in a date range | `https://www.googleapis.com/auth/calendar.readonly` |
| `createEvent` | Create a new calendar event | `https://www.googleapis.com/auth/calendar.events` |
| `<name>` | `<description>` | `<scope>` |

If you're unsure of the exact scopes, leave them blank and we'll figure them out.

## OAuth flow complexity

- [ ] OAuth 2.0 Authorization Code with PKCE (recommended; Google, GitHub, Notion, Linear)
- [ ] OAuth 2.0 Authorization Code without PKCE (Slack, older services)
- [ ] API token (no OAuth dance — user pastes token into Hub UI)
- [ ] Service account / JWT (Google Workspace, AWS)
- [ ] Other / unsure

## Real-world use case

In one paragraph, describe a concrete scenario where this plugin would be useful. "I'm an X and I want my AI agent to Y because Z."

> Example: "I'm a freelancer and I want my AI agent to schedule client calls by reading my Google Calendar availability and creating events — but only after I approve each create. Today I have to copy events between apps manually."

## Reference plugin / docs

If you've seen a similar plugin (in pdatahub or elsewhere), link it:

- pdatahub reference: `<link>`
- Other (Composio, LangChain, Zapier, native): `<link>`
- API docs: `<link>`

## Willing to author?

- [ ] I'll write it (see [docs/plugin-author-guide.md](../../docs/plugin-author-guide.md))
- [ ] I'll help test once an initial PR lands
- [ ] I'm only requesting — someone else should write it

## Estimated complexity

Your gut feel:

- [ ] **Trivial** — single API endpoint, <100 LOC plugin code (e.g. read-only todo list)
- [ ] **Moderate** — multiple endpoints + scope management, 100-400 LOC
- [ ] **Complex** — pagination, webhooks, rich content, 400+ LOC

## Additional context

Anything else — design notes, screenshots, related issues, edge cases.