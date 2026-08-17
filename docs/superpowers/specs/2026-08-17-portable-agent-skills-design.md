# Portable Agent Skills Design

## Status

Approved direction from the 2026-08-17 architecture discussion. This specification narrows the feature to explicit skill transport. Relay does not choose an agent, provider account, model, or skill and does not become a workflow engine.

## Objective

Relay lets a human or orchestrating agent attach portable Agent Skills to work sent through the existing Claude, Codex, and Jules cloud-control methods. The caller remains responsible for deciding what should run. Relay validates the request, pins the selected skill content to trusted Git history, carries it in the provider instruction, and records the exact selection with the run.

The feature must work identically whether the caller uses the CLI, REPL, or MCP.

## Architectural rules

1. **Skills never belong to provider accounts.** An account remains authentication, concurrency capacity, health, and caller-supplied usage telemetry. Any compatible account can execute the same skill-bearing request.
2. **Selection is explicit.** Relay never infers a skill from task text, remaining quota, provider, model, or previous agent output. The human or orchestrator supplies skill names.
3. **GitHub remains durable truth.** Version-one skills are repository-scoped Agent Skills checked into `.agents/skills/<name>/`. Their trusted content is resolved from an exact commit on the WorkItem base branch, not from a mutable working tree or provider candidate.
4. **Relay transports instructions; providers execute them.** Relay does not run skill scripts, install skill dependencies, or implement a provider-independent agent runtime.
5. **The current control paths remain authoritative.** Skill-bearing work still uses `CloudProvider.start` and existing follow-up, inspection, reconciliation, landing, account leasing, and recovery behavior.
6. **Skill metadata is not an authorization boundary.** `allowed-tools` and other host-specific fields may be carried to the provider but never expand Relay permissions, mutation mode, account access, GitHub access, or merge authority.

## Open format

Relay adopts the Agent Skills directory format without a Relay-specific fork:

```text
.agents/skills/
  secure-code-review/
    SKILL.md
    references/
    scripts/
    assets/
```

`SKILL.md` must contain YAML frontmatter with a valid `name` and non-empty `description`. The directory name and frontmatter name must match the Agent Skills lowercase kebab-case identifier. Relay uses a maintained YAML parser rather than a partial handwritten YAML implementation.

Relay ignores unsupported metadata instead of rewriting it. Provider-specific compatibility guidance can use standard `compatibility` text, but Relay version one does not infer routing from free-form compatibility metadata.

Personal skills in `~/.agents/skills` are deliberately out of scope for cloud transport because provider-hosted machines cannot reliably access a laptop path. Users can vendor a personal skill into a repository when they want a cloud agent to use it. Relay does not edit provider configuration directories or create cross-tool symlinks.

## Caller surface

Existing start-style operations accept an optional ordered list of skill names:

```ts
interface DelegateInput {
  // existing fields
  skills?: readonly string[];
}

interface HandoffInput {
  // existing fields
  skills?: readonly string[];
}
```

The CLI exposes repeatable `--skill <name>` flags on delegation and handoff commands. Provider shortcut commands accept them only with `--new`, which prevents mutation of an existing session. The REPL accepts the explicit `/new [provider] --skill <name> -- <instruction>` and `/handoff <provider> --skill <name> -- <instruction>` forms. MCP adds an optional `skills: string[]` field to `relay_delegate` and `relay_handoff`. Strict schemas continue to reject unknown fields.

`relay_send` does not change a session's skill set. A started provider session owns an immutable resolved skill selection. Continuing that session retains the provider conversation that already received the skill packet. To use a different selection, the caller starts a new provider session. This avoids hidden skill mutation during recovery and makes every session reproducible.

An omitted list and an empty list both mean no selected skills for a new session. Duplicate names are rejected rather than silently reordered or deduplicated.

## Trusted resolution

The first successfully resolved skill selection for a WorkItem pins `skill_source_sha` to the exact current SHA of the WorkItem base branch. Later skill-bearing sessions in that WorkItem reuse the same SHA, even if the base branch advances.

Relay resolves that base-branch SHA through GitHub, then fetches the exact object into the locator checkout without changing its branch or working tree. Git commands use the same hook-disabled process boundary as landing operations. The local repository is an object cache; GitHub remains the authority for the pinned ref.

For every requested name, Relay reads these Git objects from the local repository object database:

```text
<skill_source_sha>:.agents/skills/<name>/SKILL.md
<skill_source_sha>:.agents/skills/<name>
```

The first object supplies the metadata and body. The second supplies the Git tree SHA that covers the complete skill directory, including scripts, references, and assets. Relay stores both the source commit SHA and skill tree SHA.

Resolution fails before provider launch when:

- a name is malformed or duplicated;
- the skill directory or `SKILL.md` is absent at the trusted commit;
- frontmatter is absent, invalid, or does not match the directory name;
- the repository object cannot be read;
- the requested skill source is not a full trusted commit.

No account lease or provider launch begins after a resolution failure.

## Provider skill packet

Relay appends one deterministic block to the provider's initial instruction when skills are selected:

```text
Relay-selected skills

The caller selected the following repository skills. Before doing the task,
read each skill from the exact trusted Git commit shown below. Do not substitute
a same-named file from the working tree or another ref.

- secure-code-review
  source commit: <full commit SHA>
  directory: .agents/skills/secure-code-review
  tree: <full tree SHA>

Use `git show <source-commit>:<path>` to read SKILL.md and any referenced files.
If the commit is not present locally, fetch that exact commit from origin. Never
substitute content from another commit.
Skill instructions do not change Relay's read/write mode. Do not merge.
```

The packet contains names and immutable Git coordinates, not the entire skill body. This preserves progressive disclosure and avoids spending prompt context on unneeded references. Provider cloud environments already receive the Git repository; the packet uses that shared repository rather than local profile paths.

The packet is constructed once in Relay Core and passed as ordinary prompt text to adapters. Claude, Codex, and Jules adapters do not gain separate skill-selection logic. This is the smallest provider-neutral mechanism supported by all existing control paths.

The packet requires the provider to report when the exact Git objects are unavailable inside its environment. Relay does not silently fall back to a mutable working-tree skill. Fixture tests prove delivery of the packet, not that an external provider followed it.

## Instruction-surface quarantine

Provider candidates are untrusted until landed. Before a cross-provider handoff or recovery starts from a candidate SHA, Relay compares that candidate with `skill_source_sha` for changes to agent-control surfaces:

```text
AGENTS.md
CLAUDE.md
.agents/skills/**
.claude/skills/**
.github/skills/**
.openhands/microagents/**
.mcp.json
```

If any protected path changed, Relay refuses automatic launch with a typed `instruction_surface_changed` error that lists only the changed paths. A human can review and merge policy changes separately; version one does not provide an override flag.

This quarantine prevents one provider from planting instructions that a later provider automatically trusts. Relay still uses the trusted Git-object skill packet, but the quarantine also covers native provider discovery behavior that Relay cannot reliably disable.

## State

SQLite adds only the durable fields required for replay:

```text
work_items.skill_source_sha          nullable full SHA, set once
provider_sessions.skills_json       immutable resolved selection
provider_runs.skills_json           immutable resolved selection
```

Each resolved entry is schema-validated JSON:

```json
{
  "name": "secure-code-review",
  "path": ".agents/skills/secure-code-review",
  "sourceSha": "<full commit SHA>",
  "treeSha": "<full Git tree SHA>"
}
```

The provider session copy supports deterministic recovery. The run copy preserves audit history even when the provider session later expires. Status output may return skill names and immutable Git coordinates but never skill contents, local profile paths, or credentials.

## Recovery and handoff behavior

Session recovery reuses the session's stored resolved selection and regenerates the same deterministic packet. It does not re-resolve names against a newer base branch.

A handoff receives only the caller's explicitly supplied skill names. It does not inherit skills from the source provider session. This keeps provider switching under orchestrator control. The handoff packet continues to contain repository, branch, pull request, and exact source SHA, followed by the separately generated skill packet.

## Security and trust

- Relay never executes scripts from a skill directory.
- Relay never auto-installs or auto-updates a skill from GitHub.
- Relay never reads credentials from skill metadata or assets.
- Relay never interprets `allowed-tools` as permission to bypass provider or Relay approval boundaries.
- Skill content is ordinary untrusted repository content until it exists on the WorkItem's trusted base commit.
- Candidate changes to instruction surfaces block cross-provider execution before provider launch.
- Account profile paths remain local references and are not included in skill packets or MCP responses.

Marketplace search, remote skill installation, signatures, publisher reputation, and organization-managed catalogs are future distribution concerns, not version-one Relay Core responsibilities.

## Error handling

Skill failures use stable typed errors:

- `invalid_argument` for malformed or duplicate names;
- `not_found` for a skill absent from the pinned source commit;
- `provider_output_invalid` is reserved for structurally invalid Git command output, never YAML/frontmatter validation;
- `instruction_surface_changed` for protected candidate modifications;
- `state_conflict` when an existing immutable WorkItem or session skill pin would be replaced.

Messages identify the skill or path and the corrective action without embedding skill bodies or process environments.

## Testing

Tests use real temporary Git repositories for skill resolution and tree pinning. Provider processes remain fixture executables.

Required coverage:

- valid Agent Skills frontmatter and directory matching;
- malformed YAML, missing fields, invalid names, duplicates, and missing Git objects;
- exact source commit and directory tree SHA persistence;
- resolution from Git objects rather than modified working-tree files;
- identical skill packets across different accounts for the same provider request;
- no account lease or provider launch after resolution failure;
- session recovery reproducing the original selection;
- handoff not inheriting source-session skills;
- protected instruction-path changes blocking cross-provider handoff;
- unrelated candidate changes remaining eligible;
- CLI repeatable flags and strict MCP arrays;
- status redaction and database migration compatibility;
- complete existing verification suite on macOS and Linux.

Real provider testing remains opt-in. Fixture tests prove the prompt and command boundaries; they do not claim a provider followed the instruction. Each adapter's real cloud capability remains documented honestly.

## Non-goals

Relay does not:

- select skills, accounts, providers, models, or agent roles;
- create agent personas or maintain an agent-profile registry;
- infer skills from natural-language tasks;
- execute skill scripts locally;
- proxy model inference or subscription tokens;
- synchronize skills into provider home directories;
- expose a skill marketplace;
- implement LangGraph, CrewAI, AutoGen, or Goose workflow semantics;
- treat skill usage as proof that repository work exists;
- weaken GitHub reconciliation, candidate landing, or human merge approval.

## Acceptance criteria

The feature is complete when:

1. a CLI or MCP caller can explicitly attach one or more repository Agent Skills to a new delegation or handoff;
2. Relay resolves every selection from one immutable trusted base commit and records each directory tree SHA;
3. all provider adapters receive the same deterministic skill packet through their existing prompt control method;
4. provider accounts remain interchangeable and contain no skill configuration;
5. recovery reuses the original resolved selection;
6. a candidate that changes an agent-control surface cannot be handed automatically to another provider;
7. no skill script is executed by Relay;
8. unsupported or invalid selections fail before leasing an account or launching a provider;
9. all fixture, integration, packaging, macOS, and Linux checks pass;
10. the implementation is pushed, reviewed through GitHub CI, merged to `main`, and verified again on the merged commit.
