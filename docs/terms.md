# Terms of Service

> **Short version:** pdatahub is MIT-licensed open-source software. No warranty. You're responsible for what you do with it. We (the maintainers) don't run any service you could subscribe to.

Last updated: 2026-09-10

## Acceptance

By using pdatahub (the software), you agree to the MIT License terms in [LICENSE](../LICENSE). The short version:

> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
>
> **THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED**, including but not limited to the warranties of merchantability, fitness for a particular purpose and noninfringement. In no event shall the authors or copyright holders be liable for any claim, damages or other liability, whether in an action of contract, tort or otherwise, arising from, out of or in connection with the software or the use or other dealings in the software.

## No service, no SLA

We do not host or operate pdatahub. There is no hosted service you can sign up for. There is no SLA, no uptime guarantee, no support contract. You run the software on your own hardware.

This means:

- We have no obligation to maintain backwards compatibility
- We have no obligation to fix bugs within any time frame
- We have no obligation to keep any feature working in any specific way
- We have no obligation to provide support, documentation, or anything else

We try to do all of these things because we want to, not because we have to.

## Your responsibilities

When you run pdatahub, you are responsible for:

- **Keeping your master encryption key safe.** If you lose it, your OAuth tokens are unrecoverable. We cannot recover them for you because we never had them.
- **Reviewing tool calls before approving them.** Every AI agent call goes through an approval prompt on your phone (or whichever approver is connected). It is your job to read the prompt and decide whether to approve. We are not liable for tool calls you approve.
- **Configuring plugins correctly.** Each plugin you install talks to an upstream API. Make sure you trust the upstream. Don't install plugins you don't understand. The Hub stores tokens; if a malicious plugin exfiltrates them, that's on you for installing it.
- **Complying with laws in your jurisdiction.** Some uses of AI agent automation may be regulated (e.g. GDPR for personal data, HIPAA for health data, financial regulations for trading). You are responsible for knowing what applies to you.
- **Backups.** Your hub's database contains your tokens. If your disk dies and you don't have backups, you lose access to all your upstream APIs. Back up the master key + database file.

## What we don't do

- **No data collection.** See [PRIVACY.md](./privacy.md). We don't have access to your hub's data because it's all on your hardware, encrypted with your key.
- **No telemetry.** No anonymous usage stats, no error reports, no "pdatahub is checking for updates" calls.
- **No hosted cloud.** Cloud v3 is a future plan documented in `.omo/plans/cloud-v3-design.md`. When (and if) it ships, it will be a separately-hosted service with its own terms.

## Plugin authors

If you write and distribute a plugin:

- Your plugin's behavior is your responsibility
- Your plugin has access to OAuth tokens; if it's malicious, it can exfiltrate them
- The Hub does not currently sandbox plugins (no V8 isolate, no separate process isolation beyond the existing subprocess model) — see [threat-model.md](./threat-model.md) for details
- We may, at our discretion, refuse to ship your plugin in official registries or remove it from there

## Federation participants

If you use Federation v2 to share tools with another hub:

- You are responsible for verifying the peer's identity (verify their public key out-of-band before accepting a delegation)
- You are responsible for the scopes you delegate (a "calendar:read" scope does NOT prevent the peer from reading sensitive calendar data; only the upstream API's own scope enforcement does)
- Federation uses Ed25519 signatures, but you are responsible for verifying the peer's signing key matches what you expect

## Disclaimers

**No warranty.** The MIT License explicitly disclaims all warranties.

**No liability.** The MIT License explicitly excludes liability for damages.

**No data recovery.** We cannot recover your master key, your tokens, or your audit log. If you lose them, they're gone.

**No compliance certification.** pdatahub is not SOC 2 / ISO 27001 / HIPAA / PCI-DSS certified. We make no claims about regulatory compliance. If you need that, run pdatahub through a compliance review process yourself or wait for Cloud v3.

## Changes to these terms

If these terms change materially, the diff will be in this repo's git history. Check [CHANGELOG.md](../CHANGELOG.md) for material changes.

## Governing law

This is open-source software distributed under the MIT License. There is no commercial relationship between you and the maintainers. Disputes are governed by the laws of the jurisdiction where each party resides. (We are not lawyers; this is not legal advice.)

## Contact

- **GitHub:** [github.com/pdatahub/pdatahub/issues](https://github.com/pdatahub/pdatahub/issues)
- **Security issues:** [SECURITY.md](../SECURITY.md)
- **Email:** TBD (`security@pdatahub.io`)

## License

MIT — see [LICENSE](../LICENSE).
