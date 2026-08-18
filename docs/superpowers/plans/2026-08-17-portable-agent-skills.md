# Portable Agent Skills Implementation Plan

> [!IMPORTANT]
> **Historical implementation plan.** Portable Agent Skills remain part of Relay Cluster, but any predecessor name or provider example below is superseded by the current Codex-and-Claude scope. See the [current design](../specs/2026-08-17-relay-cluster-rebrand-design.md).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task.

**Goal:** Let callers explicitly attach repository-standard Agent Skills to new Relay delegations and handoffs while Relay validates, pins, persists, and transports the exact skill coordinates safely across provider accounts.

**Architecture:** A provider-neutral `GitSkillResolver` reads `.agents/skills/<name>/SKILL.md` from an exact Git commit without checking it out, validates Agent Skills metadata, records immutable coordinates, and generates one deterministic prompt packet. `RelayCore` owns source pinning and instruction-surface quarantine; SQLite owns durable selections; CLI, REPL, and MCP only validate and forward names. Providers remain unaware of skills, and Relay never executes skill scripts.

**Tech Stack:** TypeScript, Node.js 22, `yaml`, SQLite (`better-sqlite3`), Commander, Zod, MCP TypeScript SDK, Node test runner, real temporary Git repositories.

## Global constraints

- Follow test-driven development for every behavior: write one focused failing test, run it and confirm the intended failure, add the smallest implementation, then rerun the focused test.
- Keep provider adapters unchanged. All providers receive the same final prompt string through the existing `start` contract.
- Accept skills only on operations that start a provider session: delegation, handoff, and recovery of a previously skill-bearing session. A normal follow-up inherits the stored session selection and cannot mutate it.
- Resolve only repository skills at `.agents/skills/<name>/SKILL.md`; do not inspect home-directory skills, provider-native skill directories, or infer selections.
- Never execute scripts or commands found in a skill.
- Fetch/read exact Git objects with hooks disabled and without changing the locator working tree.
- Persist full 40-character source and tree SHAs. Reject duplicates, invalid names, malformed metadata, missing skills, and a conflicting WorkItem source pin.
- Before a selected skill crosses a provider handoff or recovery boundary, compare the candidate SHA with the trusted source SHA and reject protected instruction-surface changes.
- After each task, run its focused suite and `npm run check`; after all tasks, run `npm run verify` and `git diff --check`.

---

### Task 1: Resolve and packetize exact repository skills

**Files:**

- Create: `src/skills.ts`
- Create: `tests/skills.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src/errors.ts`

**Step 1: Write failing resolver tests**

Build a real temporary bare remote plus locator clone. Commit a valid `.agents/skills/review-security/SKILL.md` and companion file, push it, and assert:

- `GitSkillResolver.resolve()` fetches the exact full commit SHA without moving `HEAD` or the working tree.
- the result is `{ name, path, sourceSha, treeSha }` and `treeSha` is the committed skill-directory tree.
- names are returned in caller order.
- duplicate names, path-like/uppercase names, missing `SKILL.md`, frontmatter without matching `name`, and missing/blank `description` reject with stable typed errors.
- `changedInstructionPaths()` detects only the protected paths from the approved design and returns an empty list for ordinary source changes.
- `appendSkillPacket()` is deterministic and includes exact commit/path/tree coordinates plus the no-substitution/no-merge instructions.

Run: `npm test -- tests/skills.test.ts`

Expected: FAIL because `src/skills.ts` does not exist.

**Step 2: Add the YAML dependency**

Run: `npm install yaml`

Use `yaml` only to parse the delimited frontmatter mapping. Reject aliases/custom tags and require string `name` and `description` fields.

**Step 3: Implement the narrow resolver API**

Create:

```ts
export interface ResolvedSkill {
  name: string;
  path: string;
  sourceSha: string;
  treeSha: string;
}

export interface ResolveSkillsInput {
  repositoryPath: string;
  sourceSha: string;
  names: readonly string[];
}

export interface InstructionSurfaceInput {
  repositoryPath: string;
  trustedSha: string;
  candidateSha: string;
}

export interface SkillResolver {
  resolve(input: ResolveSkillsInput): Promise<readonly ResolvedSkill[]>;
  changedInstructionPaths(
    input: InstructionSurfaceInput,
  ): Promise<readonly string[]>;
}

export class GitSkillResolver implements SkillResolver { /* exact Git reads */ }

export function appendSkillPacket(
  prompt: string,
  skills: readonly ResolvedSkill[],
): string;

export function parseResolvedSkills(value: string): readonly ResolvedSkill[];
```

Use a private empty hooks directory and run Git as `git -c core.hooksPath=<absolute-empty-directory> ...`. Fetch exact SHAs from `origin`, use `git show <sha>:<path>` for metadata, `git rev-parse <sha>:<directory>` for the tree, and `git diff --name-only -z` for protected paths. Validate SHAs and names before interpolating revision/path arguments.

Add `state_conflict` and `instruction_surface_changed` to `RelayErrorCode`; use existing `invalid_argument`, `not_found`, and `provider_output_invalid` where appropriate.

**Step 4: Verify and commit**

Run:

```bash
npm test -- tests/skills.test.ts
npm run check
git diff --check
git add package.json package-lock.json src/errors.ts src/skills.ts tests/skills.test.ts
git commit -m "feat: resolve exact repository agent skills"
```

---

### Task 2: Persist immutable skill coordinates

**Files:**

- Modify: `src/state-store.ts`
- Modify: `tests/state-store.test.ts`

**Step 1: Write failing migration and persistence tests**

Assert migration 9 adds:

```text
work_items.skill_source_sha
provider_sessions.skills_json NOT NULL DEFAULT '[]'
provider_runs.skills_json NOT NULL DEFAULT '[]'
```

Then assert:

- `pinWorkItemSkillSource(id, sha)` stores the first full SHA, is idempotent for the same SHA, and rejects a different SHA with `state_conflict`.
- a new session stores resolved coordinates; an update that omits skills preserves them; an update that supplies a different list is rejected.
- every new run inherits the owning session's skills and exposes them from `getRun`, `listRuns`, and status.
- corrupt serialized coordinates fail closed rather than silently producing an empty selection.

Run: `npm test -- tests/state-store.test.ts`

Expected: FAIL because the schema and record APIs do not expose skill state.

**Step 2: Implement migration 9 and mappings**

Extend `WorkItemRecord` with optional `skillSourceSha`; extend `SessionInput`/`SessionRecord` and `RunRecord` with `skills`. Keep `SessionInput.skills` optional so existing callers preserve current state. Parse stored values with `parseResolvedSkills`.

Implement the pin as an immediate transaction. In `upsertSession`, insert `[]` by default; on update, preserve when omitted and require exact JSON equality when supplied. In `createRun`, read the session's `skills_json` and write that exact value into the run row so callers cannot diverge from the session.

**Step 3: Verify and commit**

Run:

```bash
npm test -- tests/state-store.test.ts
npm run check
git diff --check
git add src/state-store.ts tests/state-store.test.ts
git commit -m "feat: persist immutable session skills"
```

---

### Task 3: Wire skills through Relay Core and enforce quarantine

**Files:**

- Modify: `src/relay-core.ts`
- Modify: `src/app.ts`
- Modify: `tests/relay-core.test.ts`

**Step 1: Write failing core tests**

Extend the Core harness with a fake `SkillResolver`. Assert:

- `delegate({ skills: ['review-security'] })` obtains the WorkItem base-branch SHA from GitHub, pins it once, resolves the requested name, stores the coordinates on session/run, and sends exactly one appended packet to the provider.
- two accounts receive identical coordinates for the same WorkItem pin.
- a later delegation cannot repin after the base branch moves.
- `handoff` uses only explicitly requested skills and rejects when `changedInstructionPaths()` reports a protected path.
- an expired/failed skill-bearing session recovers with its original stored coordinates and performs the same candidate-vs-trusted quarantine.
- a normal `send` follows up with the session's immutable selection recorded on the run but does not append another packet or call the resolver.
- sessions with no requested skills retain existing behavior.

Run: `npm test -- tests/relay-core.test.ts`

Expected: FAIL because public inputs and dependencies do not support skills.

**Step 2: Implement provider-neutral Core wiring**

Add `skills?: readonly string[]` to `DelegateInput` and `HandoffInput`, and add `skillResolver: SkillResolver` to `RelayCoreDependencies`.

Implement private helpers that:

1. return `[]` without touching Git when no names were supplied;
2. read or set the WorkItem's source pin from the exact remote base-branch head;
3. resolve names through `SkillResolver`;
4. quarantine protected candidate changes before handoff/recovery;
5. append the packet once immediately before `provider.start`;
6. persist the resolved list on the pending session, with runs inheriting it from StateStore.

Recovery passes the old session's resolved list directly; it never re-resolves against a newer base. Handoff never inherits a previous provider's selection when its caller omits `skills`.

Instantiate `GitSkillResolver` with the existing `ProcessRunner` in `createApplication()` and inject it into `RelayCore`.

**Step 3: Verify and commit**

Run:

```bash
npm test -- tests/relay-core.test.ts
npm run check
git diff --check
git add src/app.ts src/relay-core.ts tests/relay-core.test.ts
git commit -m "feat: transport pinned skills across cloud sessions"
```

---

### Task 4: Expose thin CLI, REPL, and MCP inputs

**Files:**

- Modify: `src/app.ts`
- Modify: `src/repl.ts`
- Modify: `src/mcp.ts`
- Modify: `tests/cli.test.ts`
- Modify: `tests/repl.test.ts`
- Modify: `tests/mcp.test.ts`
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-08-17-portable-agent-skills-design.md`

**Step 1: Write failing surface tests**

Assert:

- `relay delegate ... --skill review-security --skill write-tests` forwards the ordered list.
- `relay handoff ... --skill review-security` forwards it.
- provider shortcut commands accept `--skill` only with `--new`, preventing a skill mutation on an existing session.
- REPL `/new [provider] --skill <name> -- <instruction>` and `/handoff <provider> --skill <name> -- <instruction>` forward names, while old syntax still works.
- MCP `relay_delegate` and `relay_handoff` accept an optional strict `skills` string array, reject unknown fields/invalid names/duplicates, and forward the ordered list.
- public run output includes resolved skill coordinates so an orchestrator can audit what was actually used.

Run:

```bash
npm test -- tests/cli.test.ts tests/repl.test.ts tests/mcp.test.ts
```

Expected: FAIL because no surface accepts or returns skills.

**Step 2: Add minimal surface wiring**

Use one repeatable Commander collector for `--skill`. Add a small REPL parser for the explicit `--skill ... -- instruction` form. Define and reuse an MCP skill-name schema, cap selections at 32, and reject duplicates with a schema refinement. Forward only; do not duplicate resolution logic.

Document examples, exact repository layout, immutable source pinning, recovery semantics, protected-path quarantine, provider limitation, and the explicit rule that users/orchestrating agents choose skills.

**Step 3: Verify and commit**

Run:

```bash
npm test -- tests/cli.test.ts tests/repl.test.ts tests/mcp.test.ts
npm run check
git diff --check
git add src/app.ts src/repl.ts src/mcp.ts tests/cli.test.ts tests/repl.test.ts tests/mcp.test.ts README.md docs/superpowers/specs/2026-08-17-portable-agent-skills-design.md
git commit -m "feat: expose explicit skills to Relay clients"
```

---

### Task 5: Full verification, review, publish, and merge

**Files:**

- Review every file changed since `origin/main`.

**Step 1: Run complete local verification**

Run:

```bash
npm run verify
git diff --check origin/main...HEAD
git status --short
```

Expected: typecheck, build, and every test pass; no whitespace errors; only intended changes exist.

**Step 2: Perform a focused security and architecture self-review**

Audit for:

- revision/path injection;
- Git hooks or working-tree mutation;
- YAML alias/tag abuse;
- source-SHA drift or silent repinning;
- session/run skill divergence;
- accidental skill inheritance on handoff;
- quarantine bypass on recovery;
- raw provider/MCP error leakage;
- orchestration logic leaking into CLI/MCP/provider adapters.

Fix any finding test-first and rerun `npm run verify`.

**Step 3: Push, open the pull request, and wait for CI**

Run:

```bash
git push -u origin agent/portable-agent-skills-impl
gh pr create --base main --head agent/portable-agent-skills-impl --title "Add portable agent skill transport" --body-file <prepared-body>
gh pr checks --watch <pr-number>
```

Do not merge until all required checks pass and the PR head still equals the reviewed local SHA.

**Step 4: Merge and verify authoritative main**

Run:

```bash
gh pr merge <pr-number> --squash --match-head-commit <reviewed-sha> --delete-branch
git -C ../.. pull --ff-only origin main
npm --prefix ../.. run verify
git -C ../.. status --short --branch
git -C ../.. rev-parse HEAD
git -C ../.. rev-parse origin/main
```

Expected: the PR is merged, `main` equals `origin/main`, the full suite passes on merged `main`, and the authoritative worktree is clean.
