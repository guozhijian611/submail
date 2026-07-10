# Contributing to Submail

Thanks for helping improve Submail. Focused issues and pull requests are welcome.

## Before you start

- Search existing issues and the [feature review](docs/gap-review.md).
- Use GitHub Security Advisories for vulnerabilities; never disclose them in a public issue.
- Keep real email addresses, message bodies, attachments, passwords, tokens, and local databases out of reports and commits.
- Open an issue before starting a large architectural change so the scope can be agreed first.

## Local setup

Submail requires Node.js 22+.

```bash
npm ci
npm run secure:local
npm run dev
```

The Web UI runs at `http://localhost:5173` and the API at `http://localhost:8787`.

## Making a change

1. Create a focused branch.
2. Keep unrelated cleanup out of the same change.
3. Add or update tests for behavior changes.
4. Use only synthetic `.local` addresses and fabricated content in screenshots and fixtures.
5. Update the English and Chinese README when a user-facing capability changes.

Never commit `.env`, `apps/api/.env`, `data`, `storage`, SQLite databases, generated `dist` files, or `node_modules`.

## Validation

Run the same checks as CI:

```bash
npm run typecheck
npm test
npm run build
```

For Web changes, also verify the rendered flow at a desktop viewport and a relevant mobile breakpoint. Include a sanitized screenshot when it materially helps review.

## Pull requests

A useful pull request explains:

- what changed;
- why it changed;
- the user or developer impact;
- the checks used to validate it;
- remaining limitations or follow-up work.

By contributing, you confirm that you have the right to submit the work. A project-wide license is still being evaluated, so please review the current repository status before contributing substantial code.
