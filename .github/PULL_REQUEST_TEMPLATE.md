## Type of change

- [ ] **Bugfix** — non-breaking change that fixes an issue
- [ ] **Feature** — non-breaking change that adds functionality
- [ ] **Refactor** — code change that neither fixes a bug nor adds a feature
- [ ] **Docs** — documentation only (no code change)
- [ ] **Test** — test-only change (no production code change)
- [ ] **Breaking change** — change that would require existing users to update their config / re-auth / migrate

## What

A clear and concise description of what this PR does. 1–3 sentences.

## Why

Why is this change needed? What problem does it solve? Link the issue: `Fixes #123`, `Closes #456`.

## Testing done

List the commands you ran and the results:

```bash
# Example
$ pnpm --filter hub-core test
✓ 152 tests passed
$ pnpm --filter mcp-server test
✓ 18 tests passed
$ pnpm build
✓ all packages built
```

- [ ] Unit tests added/updated for the change
- [ ] Integration / e2e tests added/updated (if applicable)
- [ ] Manual verification on real device (if applicable — describe)

## Momus review

Required if your change touches:

- Federation protocol (`packages/hub-core/src/federation/`)
- Token vault or crypto (`packages/hub-core/src/vault.ts`, AES/HKDF/Ed25519)
- OAuth or approval flow (`packages/hub-core/src/oauth.ts`, `approval-stream.ts`)
- Schema migrations (`packages/hub-core/src/migrations.ts`)
- A new persistent network listener

- [ ] This PR triggers Momus review (link design doc under `.omo/plans/`)
- [ ] This PR does NOT trigger Momus review

## Checklist

- [ ] My code follows the project style (see [CONTRIBUTING.md](../CONTRIBUTING.md)):
  - [ ] TypeScript: no `any`, no `as any`, no `@ts-ignore` without justification, strict mode passes
  - [ ] Kotlin: official Kotlin style, no `@Suppress` without justification
  - [ ] Go: `go vet` clean, `gofmt -s` clean, table-driven tests, `any` not `interface{}`
- [ ] Tests added/updated for the change (or marked N/A — explain below)
- [ ] Documentation updated where relevant (README, docs/, comments)
- [ ] Breaking changes noted in commit message and PR description
- [ ] No personal data, real tokens, or PII included in code, tests, or docs
- [ ] CI passes locally (`pnpm build`, `pnpm test`, `./gradlew test` if Android, `go test ./...` if Go)
- [ ] I have read [CONTRIBUTING.md](../CONTRIBUTING.md) and [SECURITY.md](../SECURITY.md)

## Related

- Issue: `Fixes #...`
- Design doc: `.omo/plans/...`
- Other PRs in this series: `#...`