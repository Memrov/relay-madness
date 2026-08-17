# Contributing to Relay Madness

Thanks for helping keep Relay small.

## Development

Relay Madness requires Node.js 22.12 or newer on macOS or Linux.

```sh
npm ci
npm run verify
```

Use a focused branch and include tests with every behavior change. TypeScript remains strict; avoid `any`, shell execution, global mutable state, or another runtime service when a small injected boundary is enough.

## Provider changes

- Use documented provider commands or APIs only.
- Model unsupported behavior as a capability; do not emulate an undocumented endpoint.
- Keep credentials with the provider tool or process environment.
- Add fake executable or HTTP fixtures. Public CI must never require a real provider account, subscription, API key, or GitHub write token.
- A provider completion must remain separate from GitHub publication and verification.

## Pull requests

Before opening a PR:

```sh
npm run verify
npm pack --dry-run
git diff --check
```

Explain the user-visible behavior, safety implications, and proof you ran. Keep unrelated cleanup out of the change.

Contributions must be compatible with Apache-2.0. If code is adapted from another project, identify the exact source, revision, license, and required attribution in the PR and update `NOTICE`. Do not contribute GPL, AGPL, source-available, or unknown-license code to the core package.

By submitting a contribution, you agree that it may be distributed under the repository's Apache-2.0 license.
