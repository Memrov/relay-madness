# Security Policy

## Reporting a vulnerability

Please report vulnerabilities privately through [GitHub Security Advisories](https://github.com/Memrov/relay-madness/security/advisories/new). Do not open a public issue for credential exposure, command execution, merge-gate bypasses, unsafe repository selection, or MCP trust-boundary flaws.

Include affected versions, operating system, reproduction steps, impact, and any proposed mitigation. Do not include live provider or GitHub credentials.

## Trust boundaries

Relay Madness executes authenticated provider CLIs and calls GitHub from the user's machine. A Relay user is responsible for reviewing the permissions granted to those tools and for protecting the local account.

Relay intentionally:

- invokes external commands with an argument array and `shell: false`;
- leaves Claude, Codex, and GitHub credentials in their native credential stores;
- reads the Jules key from `JULES_API_KEY` without persisting it;
- stores only coordination metadata and optional prompts in a user-only SQLite database;
- binds merge approval to a full GitHub head SHA and rechecks merge gates;
- exposes local STDIO MCP only, with no merge tool;
- rejects credential-shaped provider configuration keys.

Provider prompts, source code, branches, pull requests, and metadata still leave the local machine through the provider and GitHub products the user selected. Relay does not make those services private.

## Supported versions

Relay Madness is pre-1.0. Security fixes target the latest release and the default branch.
