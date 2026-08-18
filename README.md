# Relay Cluster

Turn your Codex and Claude Code subscriptions into a personal coding compute cluster. Relay Cluster gives your orchestrating agent one MCP server and CLI to dispatch cloud work, manage account capacity, and verify every result through GitHub.

> **One orchestrator. Many cloud agents. GitHub is truth.**

Relay Cluster is experimental, open-source, and pre-1.0. Provider cloud CLIs can change underneath it.

## Why it exists

Codex Cloud and Claude Code on the web already provide remote coding computers, agent harnesses, authentication, and subscription-backed usage. Those computers are isolated by provider, account, session, and interface. An orchestrating agent still needs a small way to address them, track capacity, transfer repository state, and prove that claimed work reached GitHub.

Relay Cluster is that control plane. It does not decide how to split a goal or which model should do a task. A human or orchestrating agent makes those choices and calls Relay's primitives.

The design applies the [blackboard model of problem solving](https://ojs.aaai.org/aimagazine/index.php/aimagazine/article/view/537): independent workers operate against shared durable state while a controller decides what happens next.

```text
                       human or orchestrating agent
                                  │
                           CLI or MCP STDIO
                                  │
                                  ▼
                           Relay Cluster core
                         coordination + leases
                            ┌─────┴─────┐
                            ▼           ▼
                       Codex Cloud  Claude Cloud
                            └─────┬─────┘
                                  ▼
                                GitHub
                    branches · commits · PRs · checks
```

- Codex and Claude are execution workers.
- GitHub is the shared blackboard.
- The caller is the controller.
- Relay Cluster persists coordination, enforces lineage and capacity, and verifies GitHub state.

A provider message is evidence about execution. A GitHub branch and commit are evidence about code.

## What Relay Cluster does

- Reuses logical provider sessions instead of creating one for every message.
- Keeps WorkItems, sessions, runs, lineage, launch checkpoints, and provider-account leases in local SQLite.
- Lets the caller select a provider, account, model, and repository Agent Skills explicitly.
- Records caller-supplied weekly usage so an orchestrator can make its own scheduling decision.
- Pins read-only work to an exact commit.
- Gives every concurrent writer a separate `relay/run/...` result branch.
- Reconciles provider results against remote branches, full commit SHAs, pull requests, and checks.
- Stages candidates before advancing a WorkItem integration branch.
- Requires human confirmation and an unchanged approved SHA for the final merge.
- Exposes the same core through the `relay` CLI/REPL and a local STDIO MCP server.

## What it deliberately does not do

- Host model inference, development VMs, builds, dependencies, or a queue service.
- Proxy subscription tokens or turn subscriptions into an unofficial model API.
- Copy provider or GitHub credentials into its database.
- Scrape quotas, rotate accounts, select models, or choose Agent Skills automatically.
- Assign or rotate proxies, network egress, or IP addresses by account.
- Synchronize provider transcripts or context windows.
- Treat “done” from a provider as proof of a published result.
- Let MCP clients merge the base branch.
- Bypass provider terms, quotas, protective limits, or account controls.

Use only accounts you are authorized to control and follow each provider's terms.

## Quick start

Requirements:

- Node.js 22.12 or newer
- macOS or Linux
- authenticated GitHub CLI (`gh`)
- authenticated `codex` and/or `claude` CLI with the relevant cloud feature enabled

Install from GitHub while the npm package is pre-release:

```sh
npm install --global github:Memrov/relay-cluster
relay --help
```

From a Git checkout connected to GitHub:

```sh
gh auth login
relay doctor
relay init --codex-env YOUR_CODEX_ENVIRONMENT_ID

relay delegate codex "Implement the change" --title "Example change"
relay status
# After the Codex result is verified through GitHub:
relay handoff claude "Review the current implementation" --mode read
```

Relay stores new coordination state in `$XDG_STATE_HOME/relay-cluster/relay.db`, or `~/.local/state/relay-cluster/relay.db` when `XDG_STATE_HOME` is unset. The old unpublished `relay-madness` state directory is neither read nor migrated.

## Provider setup and honest capabilities

Relay probes installed CLI capabilities and fails closed when a provider cannot satisfy an operation.

| Capability | Codex Cloud | Claude Code cloud |
| --- | --- | --- |
| Subscription authentication | Yes | Yes |
| Start cloud work | Yes, when `codex cloud` is available | Yes, when `claude --cloud` is available |
| Structured status | Yes | No |
| Programmatic follow-up | Not documented; unavailable | Queue-and-exit when the CLI exposes it |
| Native chat escape hatch | `relay chat codex` | Not advertised by Relay |
| Exact Relay result branch | Supported by the adapter | Unavailable; write mode fails closed |
| Current safe Relay mode | Read or write | Read-only |

### Codex Cloud

Authenticate the Codex CLI, connect a cloud environment to the repository, and store only its non-secret environment identifier:

```sh
codex login
relay init --codex-env YOUR_CODEX_ENVIRONMENT_ID
relay providers --json
```

Relay uses `codex cloud exec` and `codex cloud list --json`. It never invents an undocumented continuation command: `relay send codex ...` returns `capability_unavailable`, while `relay chat codex` opens the provider-native cloud UI.

The adapter requests Relay's exact result branch for write work. A real Codex write, candidate, landing, pull-request, and merge lifecycle is still the release gate before npm publication.

### Claude Code cloud

Install and authenticate Claude Code, then verify that the installed CLI exposes cloud sessions:

```sh
claude
relay doctor
relay providers --json
```

Relay starts cloud work through a captured pseudo-terminal because current Claude releases reject that submission path over ordinary pipes. When capability probing finds the documented queue-and-exit flags, Relay can continue the same web session with `claude -p ... --cloud SESSION_ID --output-format json`.

Claude is read-only in Relay Cluster today. The current provider surface cannot prove publication to an exact Relay-owned result branch, so a Claude write request fails with `capability_unavailable` rather than pretending that an arbitrary provider branch is safe.

## Multiple accounts and weekly usage

Each account record contains a label, a non-secret local profile reference, capacity, and optional usage snapshots. The native CLI continues to own credentials.

```sh
relay account add codex codex-a \
  --label Primary \
  --profile /profiles/codex-a \
  --default

relay account add claude claude-a \
  --label "Claude Primary" \
  --profile /absolute/path/to/claude-a \
  --default
relay account login claude-a

relay usage set codex-a \
  --model gpt-5.6-sol \
  --remaining-percent 62 \
  --resets-at 2026-08-20T00:00:00Z

relay accounts --json
relay accounts --provider codex --status ready --limit 100 --json
relay delegate codex "Implement it" --account codex-a --model gpt-5.6-sol
```

`CODEX_HOME` and `CLAUDE_CONFIG_DIR` are passed only to the selected provider process. Usage is informational and caller-supplied: Relay does not scrape a provider UI, decide that an account is exhausted, or choose the next account or model.

For Claude, `relay account login` runs the native `claude auth login` flow with that account's `CLAUDE_CONFIG_DIR`. Claude owns the OAuth credential and its platform credential-store entry; Relay stores only an opaque identity fingerprint and verification time. A profile that is already authenticated is bound without opening another browser flow.

Before a selected Claude profile starts, continues, or attaches to work, Relay checks `claude auth status` under that exact directory. Missing authentication, a changed identity, or a profile path changed after binding fails closed before Relay creates provider work. Shell-level API keys, OAuth tokens, Anthropic profiles, and Bedrock, Vertex, Foundry, or Mantle selectors are removed from profile-scoped Claude processes so they cannot silently override the selected subscription login.

Each Claude profile is a complete native identity boundary with its own settings, credentials, session history, and plugins. Relay does not copy or swap credentials between profiles and does not put tokens in SQLite.

### Fleet size, concurrency, and provider rules

Relay's state layer has an automated regression that round-trips 1,000 distinct Codex account records and their account-scoped session records after reopening SQLite. That proves metadata durability and account-scoped session routing; it does not prove that a laptop, bridge host, provider, subscription, or GitHub repository supports 1,000 simultaneous jobs.

Every provider profile must use a distinct absolute directory, and one remote provider session cannot be assigned to multiple WorkItems. Per-account leases enforce configured account capacity. Relay deliberately has no durable global queue, so the caller must bound aggregate submissions instead of launching an unbounded number of provider CLI processes at once.

Relay inherits the host's ordinary network connection. It does not configure proxies or per-account IP addresses, and it must not be used to conceal account sharing, evade enforcement, or bypass provider limits.

[OpenAI's account-sharing policy](https://help.openai.com/en/articles/10471989-openai-account-sharing-policy) says an account is for the individual who created it. [OpenAI's service terms](https://openai.com/policies/services-agreement/) also prohibit bypassing restrictions or configuring services to avoid usage limits. [Anthropic's Claude Code legal guidance](https://code.claude.com/docs/en/legal-and-compliance) says subscription OAuth is for ordinary use by subscription purchasers and directs developers building products or services to supported API-key authentication rather than routing Free, Pro, or Max credentials for users.

Relay Cluster is therefore designed as local, owner-operated software. Do not expose subscription-authenticated Relay instances as a shared or managed service. Multi-user or commercial deployments should use provider-supported organizational or API authentication and obtain provider confirmation for the intended workflow.

## CLI and REPL

Durable work is a delegation. Conversation continuation is a send. A handoff starts another provider from verified GitHub state rather than copying a transcript.

```sh
relay delegate codex "Implement passwordless login" --title "Passwordless login"
relay handoff claude "Review the current implementation for security issues" --mode read
relay send claude "Also review the integration tests" --mode read
relay sessions --json
relay status
```

Shortcuts use the current WorkItem or start one with `--new`:

```sh
relay claude "Review the current implementation" --mode read
relay codex "Start a separate approach" --new --mode write
```

Running `relay` opens the plain REPL:

```text
relay
claude> /use codex
codex> /handoff claude Review the pinned commit.
codex> /status
codex> /quit
```

Slash commands are `/use`, `/new`, `/handoff`, `/status`, `/land`, `/reconcile`, `/chat`, `/merge`, `/help`, and `/quit`.

## Portable Agent Skills

Relay accepts explicit repository skills in the [Agent Skills](https://github.com/agentskills/agentskills) layout:

```text
.agents/skills/
  review-security/
    SKILL.md
    references/
    scripts/
    assets/
```

```sh
relay delegate codex "Review authentication" --skill review-security
relay handoff claude "Review the published implementation" --skill review-security
```

The caller chooses skills. Relay resolves them from a trusted full Git commit, stores immutable coordinates, and sends a small coordinate packet. It never executes skill scripts or loads home-directory skills. Changes to protected instruction surfaces such as `AGENTS.md`, `CLAUDE.md`, `.agents/skills/**`, or `.mcp.json` stop a later handoff or recovery from silently accepting candidate-authored control instructions.

## MCP

`relay mcp` starts a local STDIO server named `relay-cluster`. It exposes:

- `relay_delegate`
- `relay_send`
- `relay_handoff`
- `relay_status`
- `relay_accounts` (read-only; profile paths are omitted)
- `relay_land` (destructive; integration branch only)

There is intentionally no `relay_merge` MCP tool.

`relay_accounts` returns at most 100 records by default and accepts optional `provider`, `status`, `limit`, and `cursor` fields. When more matching accounts exist, pass the returned `nextCursor` into the next call.

Generic STDIO configuration:

```json
{
  "mcpServers": {
    "relay": {
      "command": "relay",
      "args": ["mcp"]
    }
  }
}
```

Codex TOML:

```toml
[mcp_servers.relay]
command = "relay"
args = ["mcp"]
```

Launch the MCP server from the target Git checkout because the `current` WorkItem is resolved from that working directory. Inputs use strict schemas; outputs contain compact run and GitHub state, not prompts or provider session IDs.

## GitHub truth and safe landing

Concurrent writers never share a result branch. Every write run receives a unique `relay/run/...` branch and an immutable base SHA. GitHub reconciliation records a result only when the expected remote branch exists at a full commit SHA.

A verified write becomes a candidate. `relay land RUN_ID` uses a staged lifecycle:

1. Prepare an immutable `relay/stage/...` commit on top of the WorkItem integration branch.
2. Wait for checks on that exact staging SHA.
3. On a later call, fast-forward only the `relay/work/...` integration branch if it has not moved.
4. Maintain one integration pull request for the WorkItem.

Landing never merges `main` or another base branch. The final merge remains interactive:

```sh
relay merge --strategy squash
```

Relay prints the pull request, full head SHA, checks, and review state. It accepts only `y` or `yes`, then rechecks that the open PR is non-draft, mergeable, appropriately reviewed, passing required checks, and still at the approved SHA before invoking GitHub's SHA-bound merge.

If Relay cannot prove whether a provider accepted a launch, it records `launch_uncertain` and quarantines capacity instead of retrying a possibly duplicated side effect. After manually inspecting the provider, use `relay resolve-launch RUN_ID` to resolve the local attempt explicitly.

## Security and privacy

- `gh`, `codex`, and `claude` own their credentials.
- Provider configuration rejects credential-shaped keys.
- SQLite and its new parent directory are created with user-only permissions.
- Set `RELAY_STORE_PROMPTS=false` to omit prompts from new local run records.
- External commands use argument arrays with `shell: false`.
- Candidate-controlled Git hooks are disabled during skill reads and staged landing.
- MCP is local STDIO only; there is no unauthenticated listener.
- Diagnostic objects redact credential-shaped values.

Provider prompts are not GitHub authorization. A provider's GitHub identity can write any ref GitHub permits, regardless of the requested `relay/run/...` branch. Protect base and integration branches with GitHub rulesets and use least-privileged provider identities.

See [SECURITY.md](SECURITY.md) for private reporting and the complete trust boundary.

## Development

```sh
git clone https://github.com/Memrov/relay-cluster.git
cd relay-cluster
npm ci
npm run verify
npm pack --dry-run
```

Public tests use fake `claude`, `codex`, and `gh` executables. CI requires no paid provider task and runs on macOS and Ubuntu with Node 22.

The architecture remains intentionally small:

```text
src/app.ts + src/mcp.ts
          │
      RelayCore
       ├── StateStore (SQLite coordination truth)
       ├── GitHubClient (artifact truth)
       └── ClaudeProvider / CodexProvider (execution translation)
```

Read the [current design](docs/superpowers/specs/2026-08-17-relay-cluster-rebrand-design.md), [CONTRIBUTING.md](CONTRIBUTING.md), and [NOTICE](NOTICE). Relay Cluster is licensed under [Apache-2.0](LICENSE).
