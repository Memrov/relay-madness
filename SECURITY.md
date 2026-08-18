# Security Policy

## Reporting a vulnerability

Please report vulnerabilities privately through [GitHub Security Advisories](https://github.com/Memrov/relay-cluster/security/advisories/new). Do not open a public issue for credential exposure, command execution, merge-gate bypasses, unsafe repository selection, or MCP trust-boundary flaws.

Include affected versions, operating system, reproduction steps, impact, and any proposed mitigation. Do not include live provider or GitHub credentials.

## Trust boundaries

Relay Cluster executes authenticated provider CLIs and calls GitHub from the user's machine. A Relay user is responsible for reviewing the permissions granted to those tools and for protecting the local account.

Provider prompts are not GitHub authorization. Relay instructs write-capable providers to use `relay/run/*` and verifies published artifacts, but a provider's native GitHub identity can write any ref that GitHub permits. Treat it as a trusted writer unless GitHub rulesets and least-privileged provider identities restrict it to `relay/run/*`; protect base and integration branches with GitHub's server-side controls.

Relay intentionally:

- invokes external commands with an argument array and `shell: false`;
- leaves Claude, Codex, and GitHub credentials in their native credential stores;
- stores only coordination metadata and optional prompts in a user-only SQLite database;
- stores only an opaque digest and verification time when binding a Codex or Claude native profile to its observed account identity;
- binds merge approval to a full GitHub head SHA and rechecks merge gates;
- exposes local STDIO MCP only, with no merge tool;
- rejects credential-shaped provider configuration keys.

Relay does not manage proxies, per-account egress, or IP rotation. It inherits the host network and must not be used to conceal credential sharing, evade provider enforcement, or bypass quotas or usage limits. Each registered provider account must refer to a distinct absolute native-CLI profile directory; subscription accounts remain single-user accounts subject to the provider's terms.

Profile-scoped Claude processes remove competing credential and provider-selection environment variables before invoking the native CLI. Relay then verifies the profile's opaque identity fingerprint before provider work, preventing a shell-level credential from silently routing a registered account through another identity.

Profile-scoped Codex processes set `CODEX_HOME`, `CODEX_SQLITE_HOME`, and the higher-precedence `sqlite_home` configuration to the selected profile, force ChatGPT login and the CLI's file-backed credential store, and remove `OPENAI_API_KEY` and `CODEX_ACCESS_TOKEN` before invoking Codex. The credential file remains owned by the Codex CLI inside the selected profile directory; Relay does not inspect it. A short-lived, plugins-disabled `codex app-server` probe reads the official non-secret ChatGPT email field and hashes its normalized value. Probe processes share one probe-only Codex SQLite directory beside Relay's database rather than allocating state per account; credentials remain under the selected `CODEX_HOME`. Relay stores only the digest and fails closed if the identity changes or cannot be observed.

Codex identity probes are serialized within each Relay process and leave no resident per-account process. Separate Relay processes are separate trust and capacity domains; operators must bound their aggregate process count.

Provider prompts, source code, branches, pull requests, and metadata still leave the local machine through the provider and GitHub products the user selected. Relay does not make those services private.

## Supported versions

Relay Cluster is pre-1.0. Security fixes target the latest release and the default branch.
