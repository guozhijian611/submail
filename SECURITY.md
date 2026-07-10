# Security policy

Submail processes email, credentials, attachments, API keys, and agent-triggered actions. Please handle reports carefully.

## Supported versions

Security fixes currently target the latest commit on `main` and the latest published `0.1.x` release. Older snapshots may not receive fixes.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability.

Use [GitHub Security Advisories](https://github.com/guozhijian611/submail/security/advisories/new) to send a private report. Include:

- affected version or commit;
- deployment mode;
- reproduction steps or a minimal proof of concept;
- realistic impact;
- suggested mitigation, if known.

Remove real mailbox addresses, message bodies, attachments, passwords, cookies, session tokens, MCP/API keys, and third-party credentials. We will acknowledge and triage reports on a best-effort basis.

## Operational guidance

- Terminate TLS in front of Submail and keep the default loopback binding unless the network perimeter is already protected.
- Use app-specific mailbox passwords or provider authorization codes instead of primary login passwords.
- Grant the smallest MCP/API scopes, restrict allowed mailboxes, set expirations, and keep daily send quotas low.
- Treat HTML email, remote resources, attachments, AI output, and translation output as untrusted content.
- Back up `SUBMAIL_SECRET` separately from the database. Losing it makes encrypted credentials unrecoverable; changing it without migration breaks existing data.
- Review dependency updates and container images before production rollout.

The broader product boundaries are documented in [README.md](README.md#current-boundaries) and [docs/gap-review.md](docs/gap-review.md).
