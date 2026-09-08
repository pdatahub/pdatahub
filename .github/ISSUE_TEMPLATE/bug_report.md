---
name: Bug report
about: Report a bug in hub-core, mcp-server, plugin-sdk, relay, android-app, or runner
title: "[bug]: "
labels: ["bug", "needs-triage"]
assignees: []
---

## Description

A clear and concise description of what the bug is.

## Reproduction steps

Minimal steps to reproduce the behavior:

1. Install / configure: `...`
2. Run: `...`
3. Observe: `...`

```bash
# Commands you ran (trim to the smallest reproducible case)
```

## Expected behavior

What you expected to happen.

## Actual behavior

What actually happened. Include the full error message, stack trace, or screenshot.

## Environment

| | |
|---|---|
| OS | (e.g. macOS 15.0, Ubuntu 24.04, Windows 11) |
| pdatahub version | (commit SHA or `v0.x.y` tag) |
| Node.js version | (output of `node --version`) |
| pnpm version | (output of `pnpm --version`) |

Affected package(s) (check all that apply):

- [ ] `hub-core` — version `...`
- [ ] `mcp-server` — version `...`
- [ ] `plugin-sdk` — version `...`
- [ ] `relay` — version `...`
- [ ] `android-app` — version `...` (Android: `...`, API level: `...`)
- [ ] `runner` — version `...` (Go: `...`)
- [ ] Plugin: `pdatahub-plugin-<name>` — version `...`

## Logs

Paste relevant logs here. Use ```code blocks```. For long logs, attach a file or link a gist.

```text
PASTE LOGS HERE
```

## Severity

- [ ] **Blocker** — pdatahub is unusable; data loss; security issue (use [SECURITY.md](../../SECURITY.md) for security, do NOT file publicly)
- [ ] **High** — core feature broken; no workaround
- [ ] **Medium** — feature broken but workaround exists
- [ ] **Low** — cosmetic, minor inconvenience, or edge case

## Additional context

Anything else you tried, related issues, screenshots, or links. Add a `### Checklist` if you'd like:

- [ ] Searched existing issues (open AND closed)
- [ ] Reproduced on `main` (latest commit)
- [ ] Read [CONTRIBUTING.md](../../CONTRIBUTING.md) and [docs/](../../docs/)