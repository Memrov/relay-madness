# Relay Madness

Relay Madness is a thin universal control plane for provider-hosted coding agents. It coordinates Claude Code cloud sessions, OpenAI Codex cloud tasks, and Google Jules sessions without hosting an LLM, a development VM, or project dependencies.

```text
CLI / REPL ─┐
            ├── Relay Core ── provider clouds
MCP STDIO ──┘       │
                    ├── SQLite coordination truth
                    └── GitHub artifact truth
```

The contract is deliberately small:

- Relay owns coordination: Projects, WorkItems, sessions, runs, lineage, and locks.
- Providers own execution: their cloud computers, agent harnesses, and conversations.
- GitHub owns durable artifacts: branches, commits, pull requests, reviews, and checks.
- A provider saying “complete” never proves that code was published.

This is an experimental, pre-1.0 project. Provider cloud CLIs and APIs can change underneath it.

## What works

- One logical WorkItem can span Claude, Codex, and Jules.
- Claude and Jules sessions support programmatic follow-up.
- Codex supports cloud task creation and structured inspection; scripted cloud follow-up is intentionally unavailable until OpenAI documents a stable surface.
- Handoffs contain a repository, branch, full commit SHA, PR, and instruction—not another model's transcript.
- GitHub reconciliation distinguishes `provider_complete`, `awaiting_publish`, `published`, and `verified`.
- A completed write is credited only when its expected remote branch appears or advances beyond the SHA observed before dispatch.
- Read-only work is pinned to the branch SHA observed at dispatch and fails visibly if that head moves.
- A one-writer lease prevents two mutating providers from racing on one WorkItem; up to three read-only reviews can run concurrently.
- Merge is CLI-only, interactive, and bound to the exact approved head SHA.
- The local MCP server exposes strict account inspection, delegation, handoff, status, and integration-only landing tools. It cannot merge.

Not included: hosted compute, a daemon, an HTTP bridge, a full-screen TUI, dynamic plugins, transcript synchronization, Windows support, or automatic recursive workflows.

## Requirements

- Node.js 22.12 or newer
- macOS or Linux
- GitHub CLI (`gh`) authenticated for the repository
- at least one supported provider account and tool

Install from GitHub while the package is pre-release:

```sh
npm install --global github:Memrov/relay-madness
relay --help
```

For development:

```sh
git clone https://github.com/Memrov/relay-madness.git
cd relay-madness
npm ci
npm run verify
npm link
```

Relay stores coordination state in `$XDG_STATE_HOME/relay-madness/relay.db`, or `~/.local/state/relay-madness/relay.db` when `XDG_STATE_HOME` is unset.

Git installs run the TypeScript build through the package's `prepare` lifecycle, so the `relay` binary is present even though generated `dist/` files are not committed.

## Set up a project

Run Relay from a checkout connected to GitHub:

```sh
gh auth login
relay doctor
relay init
```

Add provider-specific non-secret references when needed:

```sh
relay init \
  --codex-env YOUR_CODEX_ENVIRONMENT_ID \
  --jules-source sources/github/OWNER/REPO
```

Relay never copies provider or GitHub credentials into SQLite. `gh`, `claude`, and `codex` own their credentials. The Jules adapter reads `JULES_API_KEY` from the process environment at execution time.

### Claude

Install and authenticate Claude Code, then make sure the installed version exposes cloud sessions. Relay starts with `claude --cloud`, continues with the same opaque session ID, and uses the native cloud interface for attachment when supported.

```sh
claude
relay doctor
```

Cloud CLI behavior is capability-probed because Anthropic rolls features out independently.

### Codex

Authenticate the Codex CLI and create/connect a Codex cloud environment for the repository. Store only that environment ID:

```sh
codex login
relay init --codex-env YOUR_ENVIRONMENT_ID
```

Relay uses `codex cloud exec` and `codex cloud list --json`. Codex cloud is currently an experimental CLI surface. There is no invented follow-up command: `relay send codex ...` returns `capability_unavailable`, while `relay chat codex` opens the native cloud experience.

### Account profiles and weekly usage

Relay stores only local profile references, never credentials. Use one profile reference per provider account and select it explicitly when delegating:

```sh
relay account add codex codex-a --label Primary --profile /profiles/codex-a --default
relay accounts --json
relay usage set codex-a --model gpt-5.6-sol --remaining-percent 62 --resets-at 2026-08-20T00:00:00Z
relay usage --account codex-a --json
relay delegate codex "Implement it" --account codex-a --model gpt-5.6-sol
```

`CODEX_HOME` and `CLAUDE_CONFIG_DIR` are profile references passed only to the selected local provider CLI. Weekly usage entries are caller-supplied scheduling telemetry: Relay does not scrape provider UIs, infer quota, select an account, or select a model from them. For multiple Claude profiles, use separate Linux bridge environments; macOS profile separation relies on Keychain and is not a safe multi-profile bridge.

### Jules

Connect the repository in Jules, create an API key, and discover its source resource name through the Jules API. Export the key; do not pass it to `relay init`:

```sh
export JULES_API_KEY=YOUR_KEY
relay init --jules-source sources/github/OWNER/REPO
```

Relay uses the official Jules `v1alpha` REST API for sessions, follow-ups, status, activities, and plan approval. The alpha schema can change.

## Use it

Durable development work is explicit:

```sh
relay delegate claude "Implement passwordless login" --title "Passwordless login"
relay send claude "Add integration tests" --mode write
relay status
relay handoff codex "Review the current implementation for security issues"
relay handoff jules "Add tests for the review findings" --mode write
relay reconcile
relay land RUN_ID
```

Useful direct commands:

```sh
relay claude "Review the current PR"
relay codex "Look for security regressions"
relay jules "Add missing edge-case tests" --mode write
relay sessions --json
relay providers --json
relay chat claude
```

Running `relay` opens the plain REPL:

```text
relay
claude> /use jules
jules> /handoff codex Review the pinned commit.
jules> /status
jules> /quit
```

Slash commands are `/use`, `/new`, `/handoff`, `/status`, `/land`, `/reconcile`, `/chat`, `/merge`, `/help`, and `/quit`.

Write runs always publish isolated, append-only `relay/run/...` branches. A completed write becomes a candidate, then `relay land RUN_ID` performs a staged two-call lifecycle: the first call creates and checks an immutable staging commit; the second fast-forwards only that WorkItem's integration branch after exact-SHA checks pass. Relay maintains one integration PR per WorkItem. Landing never merges `main` or the base branch; the final base merge remains the separate, human-confirmed `relay merge` flow.

## Safe merge

Only the interactive CLI can merge:

```sh
relay merge --strategy squash
```

Relay refreshes GitHub first, prints the PR, exact 40-character head SHA, checks, and review state, and accepts only `y` or `yes`. It then rechecks that the PR is non-draft, mergeable, approved when required, passing required checks, and still at the approved SHA before invoking `gh pr merge --match-head-commit`.

No `relay_merge` MCP tool exists.

## MCP

`relay mcp` is a local STDIO server. It exposes:

- `relay_delegate`
- `relay_send`
- `relay_handoff`
- `relay_status`
- `relay_accounts` (read-only; profile paths are never returned)
- `relay_land` (destructive; mutates only the WorkItem integration branch and never merges `main`)

Each input schema rejects unknown fields. Responses expose Relay run lineage and compact GitHub state, but not provider session IDs or prompts. Relay failures are returned as typed, redacted MCP tool errors.

Generic JSON configuration for Claude Code, VS Code, Cursor, and other STDIO MCP hosts:

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

Codex uses TOML:

```toml
[mcp_servers.relay]
command = "relay"
args = ["mcp"]
```

Configure the MCP host to launch Relay from the target Git checkout, because “current” WorkItem resolution uses that working directory. Consult the current host documentation for the exact config location: [Codex MCP](https://developers.openai.com/codex/mcp/), [Claude Code MCP](https://docs.anthropic.com/en/docs/claude-code/mcp), [VS Code MCP](https://code.visualstudio.com/docs/copilot/chat/mcp-servers), or [Cursor MCP](https://docs.cursor.com/context/model-context-protocol).

## Privacy and security

- Credentials remain with provider CLIs, `gh`, or `JULES_API_KEY` in the process environment.
- Provider config rejects credential-shaped setting names.
- The SQLite database and containing state directory are created with user-only permissions.
- Prompts are stored by default for local run history. Set `RELAY_STORE_PROMPTS=false` before launching Relay to omit new prompts.
- External commands run without a shell; structured output is schema-validated.
- Diagnostic objects recursively redact credential-shaped keys.
- MCP is local STDIO only. There is no unauthenticated network listener.
- Follow provider terms. Do not share credentials or use Relay to bypass provider protective limits, quotas, or account controls.

See [SECURITY.md](SECURITY.md) for reporting and trust boundaries.

## Architecture

Both terminal and MCP clients call the same `RelayCore`. Adapters translate provider protocols and expose honest capabilities. `StateStore` persists coordination in SQLite through ordered migrations. `GitHubClient` verifies explicit refs, full SHAs, matching open PR heads, required checks, and safe merge preconditions. Historical snapshots remain available locally, while status, handoff, recovery, and merge always refresh current GitHub state and never act on a stale snapshot.

The core safety limits are:

- delegation depth: 2 when callers propagate `parentRunId`;
- active mutating runs per WorkItem: 1;
- active read-only runs per WorkItem: 3;
- total runs per WorkItem: 20;
- abandoned mutation lease reclamation: 60 minutes.

See the [architecture design](docs/superpowers/specs/2026-08-16-relay-madness-design.md) for the complete model.

## Why this is different

Projects such as [Agent Orchestrator](https://github.com/Untrivial-ai/agent-orchestrator) and [OpenHands](https://github.com/OpenHands/OpenHands) are broader agent workspaces or execution platforms. They are useful prior art, but Relay Madness chooses a narrower boundary: it does not run the coding computer. It coordinates provider-hosted agents and treats GitHub as their interoperability layer.

The implementation uses the official [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk). Relevant open-source projects were studied for interface and lifecycle patterns; no third-party source was copied into the first release. Any future copied MIT or Apache-2.0 source must retain its required attribution in [NOTICE](NOTICE); unattributed copying is not acceptable.

## Tests

Public CI never contacts a provider account. Fake `claude`, `codex`, and `gh` executables plus schema-complete Jules HTTP fixtures cover parsing, session reuse, recovery, reconciliation failures, branch advancement, pinned reads, handoffs, transactional locks, recursion limits, merge gates, the CLI, package installation, and a real in-memory MCP client/server exchange.

```sh
npm run check
npm test
npm run build
npm pack --dry-run
```

CI runs the release checks on macOS and Linux with Node 22.

## Contributing and license

Contributions are welcome; read [CONTRIBUTING.md](CONTRIBUTING.md). Relay Madness is licensed under [Apache-2.0](LICENSE).
