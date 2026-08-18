# Relay Cluster Rebrand and Provider Scope Design

**Status:** Approved in conversation on 2026-08-17

## Summary

Relay Madness becomes **Relay Cluster**, an open-source control plane focused exclusively on OpenAI Codex Cloud and Anthropic Claude Code Cloud. Google Jules is removed rather than hidden behind an experimental flag. The public story becomes simpler, more searchable, and limited to provider behavior that has been exercised against real accounts.

The opening copy is:

> **Turn your Codex and Claude Code subscriptions into a personal coding compute cluster. Relay Cluster gives your orchestrating agent one MCP server and CLI to dispatch cloud work, manage account capacity, and verify every result through GitHub.**

The supporting thesis is:

> **One orchestrator. Many cloud agents. GitHub is truth.**

## Problem

Codex Cloud and Claude Code Cloud already provide remote coding computers, agent harnesses, authentication, and subscription-backed usage. Those computers remain isolated by provider, account, session, and user interface. An orchestrating agent cannot address them through one small interface, reason about their available capacity, carry durable repository state between them, or prove that a claimed result reached GitHub.

Relay Cluster supplies that missing coordination substrate. It does not decide how to decompose a goal or which provider should perform a task. The human or orchestrating agent owns those decisions.

## Coordination Theory

Relay Cluster applies the blackboard architecture to cloud coding agents:

- Codex and Claude are independent execution workers.
- GitHub is the shared blackboard containing branches, commits, pull requests, reviews, and checks.
- The caller is the controller that chooses the next action and provider.
- Relay Cluster is the deterministic control plane that exposes workers, persists coordination state, enforces leases and lineage, and verifies blackboard state.

Agents coordinate through durable artifacts rather than by synchronizing transcripts or context windows. A provider message is evidence about execution; GitHub is evidence about code.

## Product Boundary

Relay Cluster owns:

- Projects, WorkItems, provider sessions, runs, lineage, and launch checkpoints.
- Explicit provider-account selection and caller-supplied weekly usage telemetry.
- Capacity and landing leases.
- Pinned read-only delegations and isolated write branches.
- Handoff packets derived from verified GitHub state.
- GitHub reconciliation, candidate staging, and human-confirmed final merge gates.
- One CLI and one local STDIO MCP server backed by the same core.

Providers own:

- Authentication and subscription enforcement.
- Remote computers, agent harnesses, model execution, and session lifetime.
- Provider-specific conversations and native interfaces.

The caller owns:

- Task decomposition.
- Provider, account, model, and Agent Skill selection.
- Retry and workflow policy above Relay's primitives.
- Human approval for final merge.

Relay Cluster never proxies model tokens, copies provider credentials, scrapes quotas, chooses accounts automatically, hosts development VMs, or presents multiple subscriptions as an unofficial API. Users must follow provider terms and may use only accounts they are authorized to control.

## Supported Providers

The public provider type contains exactly:

- `codex`
- `claude`

Jules is removed from production source, provider construction, authentication checks, capability reporting, CLI arguments and shortcuts, REPL routing, MCP schemas, configuration flags, package metadata, security documentation, current README examples, fixtures, and tests.

No compatibility flag or plugin shell remains. A future provider must justify its exact session and GitHub publication contract before re-entering the core.

## Naming and Compatibility Boundary

The public identity changes as follows:

- Product: `Relay Cluster`
- GitHub repository: `Memrov/relay-cluster`
- npm package: `relay-cluster`
- MCP implementation identity: `relay-cluster`
- default state directory: `$XDG_STATE_HOME/relay-cluster/relay.db`, falling back to `~/.local/state/relay-cluster/relay.db`

The concise command vocabulary remains stable:

- executable: `relay`
- MCP tools: `relay_delegate`, `relay_send`, `relay_handoff`, `relay_status`, `relay_accounts`, and `relay_land`
- environment variables: existing `RELAY_*` names
- Git branch namespaces: `relay/run/*`, `relay/work/*`, and `relay/stage/*`
- internal coordination type names such as `RelayCore`

The old unpublished state directory is left untouched and is not migrated automatically. Relay Cluster starts with its own state database. The Git remote is updated to the renamed repository; GitHub's repository redirect remains a convenience rather than a runtime dependency. The local checkout directory does not need to be renamed.

## User Experience

The shortest discovery path is:

```text
Turn your Codex and Claude Code subscriptions into a personal coding compute cluster.
One orchestrator. Many cloud agents. GitHub is truth.
```

The first README example demonstrates an orchestrating agent or human using the same primitives:

```sh
relay init --codex-env OWNER/REPO
relay delegate codex "Implement the change" --account codex-a
relay handoff claude "Review the current implementation" --mode read
relay status
```

The README explains immediately that Claude is currently read-only in Relay Cluster and that Codex scripted follow-up remains unavailable. Capability negotiation continues to fail closed rather than simulate unsupported parity.

## Documentation Structure

The README is rewritten around this order:

1. Approved two-sentence opening and thesis.
2. The problem: isolated provider-hosted coding computers.
3. The blackboard/control-plane theory.
4. What Relay Cluster does and does not do.
5. A minimal Codex and Claude setup.
6. Human and MCP examples.
7. Account capacity and caller-supplied usage.
8. GitHub truth, landing, merge, and security boundaries.
9. Honest provider capability matrix.
10. Installation, development, and contribution instructions.

Predecessor architecture documents remain in Git history and receive a visible historical-status banner where they describe Relay Madness or Jules as current scope. Current package, README, CONTRIBUTING, SECURITY, NOTICE, and repository metadata use Relay Cluster exclusively.

## Error Handling

- Passing `jules` through the CLI or MCP produces the existing typed invalid-provider or schema-validation error.
- A database created in the new state directory cannot contain newly created Jules configuration, accounts, sessions, or runs because provider validation accepts only Claude and Codex.
- Existing capability failures remain explicit: Claude write requests fail when exact result-branch publication cannot be proven, and Codex programmatic follow-up fails while the CLI lacks a documented noninteractive continuation command.
- Repository rename failures stop the release workflow without changing the local Git remote to an unverified target.

## Testing

Implementation follows test-driven development. Regression coverage proves:

- provider validation accepts exactly `claude` and `codex`;
- CLI help, doctor output, initialization, shortcuts, and provider errors expose no Jules surface;
- MCP schemas reject Jules and advertise the Relay Cluster identity;
- the application constructs exactly the two supported adapters;
- the new state path is used;
- package metadata and the packed binary use `relay-cluster` while the executable remains `relay`;
- the package contains no Jules production module or Jules test fixture;
- a clean external npm install launches `relay --help` and opens the SQLite-backed provider surface;
- the complete TypeScript build and test suite remains green on macOS and Ubuntu.

The rename itself does not require another paid provider task. The already completed live Claude and Codex read-path tests remain evidence for those adapters. A real Codex write branch, candidate, landing, pull request, and merge lifecycle remains the final release gate before npm publication.

## Release Outcome

This change ends when:

- all rename and removal changes are merged into `main`;
- the GitHub repository is named `Memrov/relay-cluster` and the local remote points to it;
- macOS and Ubuntu CI pass on the merged tree;
- the npm package dry run and clean external install pass;
- `main` is clean and matches `origin/main`.

It does not publish the npm package. Publication follows the separate live Codex write-path release gate and npm authentication handoff.
