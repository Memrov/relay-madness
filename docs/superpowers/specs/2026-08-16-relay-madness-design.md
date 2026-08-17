# Relay Madness Design

## Purpose

Relay Madness is a thin, open-source control plane for provider-hosted coding agents. It coordinates work performed by Claude Code on the web, OpenAI Codex cloud, and Google Jules without hosting model inference, build environments, project dependencies, or development virtual machines.

The product has one core used by both humans and agents:

```text
CLI / REPL ─┐
            ├── Relay Core ── Provider adapters ── Provider clouds
MCP STDIO ──┘       │
                    ├── SQLite coordination state
                    └── GitHub artifact verification
```

The defining contract is:

- Relay owns coordination state and decides who works next.
- Providers own execution, conversation state, and their cloud computers.
- GitHub owns durable artifact truth: refs, commits, pull requests, reviews, and checks.
- A provider saying “complete” is not proof that an artifact exists.

## Product boundaries

The first public release provides:

- automatic GitHub project detection;
- one logical WorkItem spanning multiple provider sessions;
- Claude, Codex, and Jules adapters with honest capability negotiation;
- session reuse where a provider supports it;
- SHA-pinned handoff packets between providers;
- GitHub branch, pull-request, and check reconciliation;
- a small direct-command CLI and lightweight REPL;
- a local STDIO MCP server backed by the same Relay Core;
- an interactive, SHA-bound merge command with human confirmation;
- fake provider and GitHub executables for deterministic tests.

The first public release does not provide:

- local or hosted coding compute;
- a public multi-user HTTP bridge;
- dynamically installed provider plugins;
- automatic recursive workflows;
- automatic merge through MCP;
- transcript synchronization between providers;
- a full-screen terminal UI;
- GitHub Enterprise Server support;
- Windows support.

macOS and Linux are supported. Node.js 22.12 or newer is required. The package is licensed under Apache-2.0.

## User experience

The binary is named `relay` and the package/repository is named `relay-madness`.

The direct-command path is authoritative and scriptable:

```text
relay doctor
relay init
relay delegate claude "Implement passwordless authentication"
relay send claude "Keep Google login working"
relay handoff jules "Add missing integration tests"
relay status
relay reconcile
relay merge --strategy squash
relay chat codex
relay mcp
```

Running `relay` without a subcommand opens a readline-based REPL. Plain text is sent to the selected provider for the current WorkItem. Slash commands provide `/use`, `/new`, `/handoff`, `/status`, `/reconcile`, `/chat`, `/merge`, and `/quit`.

Opaque provider session identifiers remain hidden during normal use but are available in `relay sessions --json` for diagnostics.

## Truth model

Relay treats truth as three separate layers:

1. Provider truth describes the remote session or task, its messages, and provider-reported status.
2. Relay truth describes projects, WorkItems, sessions, runs, lineage, leases, and the last observed artifacts.
3. GitHub truth describes published code and review state.

Relay never infers GitHub success solely from provider truth. When a provider finishes before publishing code, the run enters `awaiting_publish` rather than `verified`.

## Domain model

### Project

A Project binds a GitHub repository to its default branch, local locator checkout, and provider-specific non-secret settings such as a Codex environment ID.

### WorkItem

A WorkItem is one logical development objective. It owns the base branch, deterministic target branch, current full commit SHA, pull-request number, status, and provider sessions.

Only one mutating run may hold a WorkItem lease. Multiple read-only reviews may run concurrently when all are pinned to the same immutable SHA.

### ProviderSession

A ProviderSession records a provider’s logical session or task identity. It does not imply that the original virtual machine is still alive. At most one reusable session per provider is active for each WorkItem.

### ProviderRun

A ProviderRun records one message, delegation, handoff, inspection, or publication attempt. Every run receives a Relay-generated correlation ID, parent run ID, origin, delegation depth, deadline, and mutation mode.

Callers may not override Relay-generated lineage fields.

### ArtifactSnapshot

An ArtifactSnapshot records a full commit SHA, branch, pull request, draft state, mergeability, review decision, and normalized check summary observed from GitHub at a specific time.

## State machine

Provider runs use this normalized lifecycle:

```text
queued
  └─> running
        ├─> provider_complete
        │     ├─> awaiting_publish
        │     └─> published
        │             └─> verified
        ├─> failed
        ├─> cancelled
        └─> expired
```

`provider_complete` means only that the provider reports completion. `published` means Relay found the expected remote ref or pull request. `verified` means Relay resolved the exact full SHA and recorded current GitHub checks.

A lost or expired provider session can be replaced. Recovery starts a new ProviderSession using a handoff packet built from the last verified ArtifactSnapshot.

## Provider contract

Adapters are built in during the 0.x series and implement a narrow interface:

```ts
interface CloudProvider {
  readonly name: ProviderName;
  capabilities(): Promise<ProviderCapabilities>;
  authStatus(): Promise<AuthStatus>;
  start(input: StartRunInput): Promise<ProviderExecution>;
  send?(input: SendRunInput): Promise<ProviderExecution>;
  inspect?(input: InspectRunInput): Promise<ProviderInspection>;
  attach?(input: AttachInput): Promise<number>;
  cancel?(input: CancelInput): Promise<void>;
}
```

Capabilities are probed at runtime and cached briefly. The schema distinguishes `start`, `structuredStart`, `queueFollowup`, `interactiveAttach`, `structuredStatus`, `events`, `selectBranch`, `publishPullRequest`, `cancel`, and `subscriptionAuth`.

Higher-level code checks capabilities before selecting a path. An unsupported operation returns a typed `capability_unavailable` result; Relay does not emulate undocumented provider behavior.

### Claude adapter

The Claude adapter invokes the authenticated `claude` CLI. It starts a cloud session from the project locator checkout, sends queue-and-exit follow-ups by session ID, and attaches interactively when the installed CLI supports attachment. It parses structured JSON when available and accepts documented Claude session URLs as a fallback identifier source.

Because Claude can complete without an automatically discoverable branch or pull request, publication and reconciliation remain separate phases.

### Jules adapter

The Jules adapter uses the official REST API for session creation, follow-up messages, plan approval, inspection, activities, and automatic pull-request mode. It reads `JULES_API_KEY` at execution time and never persists the key. Jules API instability is isolated inside the adapter and tested against recorded schema-shaped fixtures.

### Codex adapter

The Codex adapter invokes the authenticated `codex` CLI. It supports cloud task submission, listing, status inspection, and diff retrieval using a stored project environment ID. Programmatic follow-up is reported unavailable until OpenAI publishes a stable command or API. `relay chat codex` launches the native cloud interface as the interactive escape hatch.

## Handoffs

A handoff never contains an entire provider transcript. Relay reconciles GitHub first and produces a packet containing:

```text
Repository: owner/name
Work item: Passwordless authentication
Base branch: main
Source branch: relay/passwordless-auth-work1234
Source commit: <full 40-character SHA>
Pull request: #143
Instruction: Review for correctness, security, and regressions.
Expected output: Report findings against the pinned commit. Do not merge.
```

Mutating handoffs allocate a new provider-specific target branch unless the previous writer has released the WorkItem lease. Read-only handoffs remain pinned to the source SHA and must report when the pull-request head moves during the review.

## GitHub behavior

Relay invokes the authenticated `gh` CLI and parses JSON output. It does not store GitHub tokens.

Project detection uses repository name, default branch, and remote URL from GitHub. Reconciliation checks an explicit expected branch and full SHA; it never selects a branch based on timestamps or naming resemblance.

The merge gate requires:

- a non-draft pull request;
- an unchanged full head SHA;
- successful required checks;
- a mergeable GitHub state;
- any review decision required by branch protection;
- interactive human confirmation.

The final operation uses `gh pr merge --match-head-commit <full-sha>` and the selected merge strategy. MCP exposes status and approval requirements but cannot execute a merge in the first release.

## Local locator checkouts

Some provider CLIs infer their repository and branch from the working directory. Relay may use the user’s current clean checkout or maintain a shallow locator checkout under its application-state directory.

A locator checkout contains tracked source files but Relay never installs dependencies, runs project setup, executes tests, or treats it as development compute. Relay does not switch branches in a user checkout with uncommitted changes.

## Persistence

SQLite is the only Relay-owned durable store. The database contains:

- `schema_migrations`;
- `projects`;
- `provider_configs`;
- `work_items`;
- `provider_sessions`;
- `provider_runs`;
- `artifact_snapshots`;
- `work_item_leases`.

Foreign keys are enabled. Mutating state transitions run in transactions. The database and containing directory are created with user-only permissions.

Prompts are stored only when the user has not enabled `privacy.storePrompts=false`. Provider credentials, environment variables containing credentials, raw process environments, and authentication output are never stored. Diagnostic output redacts values whose keys match token, secret, key, authorization, or credential patterns.

## Recursion and resource controls

Relay owns delegation lineage and enforces these defaults:

- maximum delegation depth: 2;
- maximum active mutating runs per WorkItem: 1;
- maximum active read-only runs per WorkItem: 3;
- maximum total runs per WorkItem: 20;
- default run deadline: 60 minutes;
- explicit repository and provider membership in the Project.

Provider cloud environments do not receive Relay bridge credentials. A delegated provider therefore cannot silently call back into Relay unless a future, explicitly configured deployment grants that capability.

## MCP surface

`relay mcp` runs a STDIO server using the official TypeScript MCP SDK. It exposes four tools:

- `relay_delegate` starts durable coding work;
- `relay_send` continues a reusable provider session;
- `relay_handoff` reconciles GitHub and transfers work to another provider;
- `relay_status` returns provider and GitHub state.

All inputs use strict schemas and reject unknown fields. WorkItem and provider access is resolved by Relay Core rather than reimplemented in the MCP layer. Tool responses use stable machine-readable error codes and concise human-readable text.

The first release does not expose `relay_merge` through MCP and does not expose an unauthenticated HTTP transport.

## Error handling

Errors cross boundaries as typed Relay errors with a stable code, actionable message, and optional redacted cause. The CLI maps them to nonzero exit codes and concise terminal output. MCP maps them to structured tool errors.

Provider subprocesses have explicit deadlines, preserve stdout and stderr separately, and include the executable plus argument names in diagnostics without printing prompts or credentials. Malformed provider output is retained only in redacted debug logs when debug logging is enabled.

Reconciliation failures do not discard provider results. They leave the run in `provider_complete`, `awaiting_publish`, or `published` with a recorded reason so the user can recover.

## Testing

Tests use Node’s test runner and temporary SQLite databases. The production process runner is exercised against fixture executables named `claude`, `codex`, `jules`, and `gh` placed first on a temporary `PATH`.

The suite covers:

- capability probing;
- provider session identifier parsing;
- same-session follow-up behavior;
- unsupported Codex follow-up;
- Jules request and response schemas;
- subprocess timeouts and redaction;
- state migrations and transactional transitions;
- WorkItem mutation leases;
- immutable handoff packets;
- missing and moved GitHub branches;
- pull-request and check normalization;
- SHA-bound merge refusal and confirmation;
- delegation-depth and run-budget enforcement;
- CLI JSON output;
- MCP tool behavior through Relay Core.

Real-account tests are opt-in, never run in public CI, and require explicit environment flags. Public CI runs formatting, static type checking, unit tests, fixture integration tests, package build, and a smoke invocation of the compiled CLI.

## Dependencies and source policy

Runtime dependencies are limited to the official MCP TypeScript packages, Zod, Commander, and `better-sqlite3`. Process execution, HTTP requests, identifiers, paths, and the REPL use Node standard-library APIs.

Existing open-source orchestrators may be studied for interoperability patterns. Code is copied only when its license is compatible with Apache-2.0, the copied portion materially reduces risk, and required attribution is preserved in `NOTICE`. GPL, AGPL, source-available, or unknown-license code is not incorporated into the core package.

## Repository and release shape

The repository is a single npm package with focused source files:

```text
src/
  core/
  state/
  providers/
  github/
  cli/
  mcp/
tests/
  fixtures/bin/
docs/
```

The public executable is `relay`. Releases are built from GitHub Actions after tests pass on macOS and Linux. The package remains pre-1.0 while provider command surfaces are unstable.

## Delivery sequence

Implementation is split into independently verifiable milestones inside the single package:

1. Foundation: package tooling, SQLite state, domain transitions, process execution, and fake executables.
2. GitHub and Claude vertical slice: project detection, deterministic WorkItems, Claude session reuse, reconciliation, direct CLI commands, and status.
3. Jules: REST authentication boundary, session lifecycle, activities, plan approval, and pull-request publication.
4. MCP: the four local STDIO tools routed through the already-tested Relay Core.
5. Codex: environment mapping, cloud task submission and inspection, native passthrough, and an explicit unsupported follow-up result.
6. Operator surface: readline REPL, recovery, safe merge, documentation, packaging, and GitHub Actions release checks.

Each milestone is committed only after its focused tests and the complete accumulated suite pass. No milestone depends on a real provider account in public CI.

## Acceptance criteria

The first public release is complete when a clean machine with authenticated provider CLIs can:

1. install the package and run `relay doctor`;
2. initialize Relay from a GitHub checkout;
3. delegate work to Claude and send a follow-up to the same logical session;
4. delegate or hand off work to Jules through its REST API;
5. submit and inspect a Codex cloud task while clearly rejecting scripted follow-up;
6. reconcile an explicit GitHub branch and full commit SHA;
7. hand another provider a SHA-pinned packet;
8. expose delegation, send, handoff, and status through STDIO MCP;
9. refuse unsafe merges and perform a confirmed merge only against the expected SHA;
10. pass all fixture-based tests without contacting a provider.

No acceptance criterion requires Relay to build user code, host a development environment, or synchronize provider transcripts.
