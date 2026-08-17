# Account Fleet and Safe Landing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Relay coordinate many independently authenticated provider accounts and concurrent isolated worker runs, expose weekly model-usage telemetry to an external orchestrator, and serialize candidate integration through a GitHub-verified landing queue.

**Architecture:** A provider account owns only a non-secret local profile reference, capacity state, and usage snapshots. Every write run is bound to one account, one immutable base SHA, and one unique remote result branch; finished commits become immutable candidates. A single WorkItem lander stages one candidate at a time on top of the integration branch, waits for GitHub checks, then advances the integration branch with a fast-forward-only push and maintains one final pull request.

**Tech Stack:** Node.js 22.12+, TypeScript 7, SQLite through `better-sqlite3`, native `git` and `gh` subprocesses, Commander 15, Zod 4, MCP TypeScript SDK 2, Node test runner through `tsx`.

## Global Constraints

- Relay never hosts model inference, provider development VMs, project dependencies, or repository test runtimes.
- Provider and GitHub credentials remain owned by their native clients; Relay persists profile-directory references but never token contents.
- Usage snapshots are informational. Relay never rotates accounts merely because a weekly allowance or rate limit was exhausted; the caller chooses `accountId` and `model`.
- A provider session remains bound to the account that created it.
- Concurrent write runs are permitted only when each owns a unique result branch derived from its Relay run ID.
- Every write run records a full 40-character immutable `baseSha`; a GitHub-observed full `resultSha` is the only successful candidate result.
- Provider agents may push only run branches. They never update the WorkItem integration branch or `main`.
- Only one landing transaction may hold a WorkItem landing lease.
- Landing never guesses through conflicts, force-pushes, or chooses ours/theirs. It returns structured conflict, stale-head, or check failure state.
- The integration branch advances only by fast-forward from the exact SHA used to prepare the staged candidate.
- Main-branch merge remains human-approved and bound to an expected full SHA.
- Runtime dependencies do not grow; public CI never contacts provider accounts.
- All behavior follows red-green-refactor and each task receives focused review before the next task begins.

---

### Task 1: Provider accounts, leases, and weekly usage snapshots

**Files:**
- Modify: `src/state-store.ts`
- Modify: `src/errors.ts`
- Modify: `tests/state-store.test.ts`

**Interfaces:**
- Consumes: existing `ProviderName`, `StateStore.open()`, schema migrations, and credential-shaped settings rejection.
- Produces: `ProviderAccountRecord`, `UsageSnapshotRecord`, `AccountLeaseRecord`, `upsertProviderAccount()`, `getProviderAccount()`, `getDefaultProviderAccount()`, `listProviderAccounts()`, `setProviderAccountConfig()`, `getProviderAccountConfig()`, `recordUsageSnapshot()`, `listLatestUsage()`, `acquireAccountLease()`, and `releaseAccountLease()`.

- [ ] **Step 1: Write failing state tests**

Add behavior tests proving:

```ts
test('stores only a provider profile reference and selects one explicit default', () => {
  const store = seededStore();
  store.upsertProviderAccount({
    id: 'codex-a', provider: 'codex', label: 'Primary', profilePath: '/profiles/codex-a',
    status: 'ready', maxConcurrency: 1, isDefault: true,
  });
  store.upsertProviderAccount({
    id: 'codex-b', provider: 'codex', label: 'Spare', profilePath: '/profiles/codex-b',
    status: 'ready', maxConcurrency: 2, isDefault: true,
  });
  assert.equal(store.getDefaultProviderAccount('codex')?.id, 'codex-b');
  assert.equal(store.listProviderAccounts('codex').filter((account) => account.isDefault).length, 1);
});

test('returns the latest weekly usage independently for each model bucket', () => {
  const store = storeWithAccount('claude-a', 'claude');
  store.recordUsageSnapshot({ accountId: 'claude-a', period: 'weekly', model: 'opus', remainingPercent: 35,
    resetsAt: '2026-08-20T00:00:00.000Z', source: 'manual', observedAt: '2026-08-16T10:00:00.000Z' });
  store.recordUsageSnapshot({ accountId: 'claude-a', period: 'weekly', model: 'opus', remainingPercent: 28,
    resetsAt: '2026-08-20T00:00:00.000Z', source: 'manual', observedAt: '2026-08-16T11:00:00.000Z' });
  assert.equal(store.listLatestUsage('claude-a')[0]?.remainingPercent, 28);
});

test('enforces account capacity transactionally', () => {
  const store = storeWithAccount('codex-a', 'codex', { maxConcurrency: 1 });
  store.acquireAccountLease('codex-a', 'run-a', new Date('2026-08-16T10:00:00Z'));
  assert.throws(() => store.acquireAccountLease('codex-a', 'run-b', new Date('2026-08-16T10:00:01Z')),
    (error: unknown) => error instanceof RelayError && error.code === 'account_at_capacity');
});
```

Also test `remainingPercent` boundaries `0` and `100`, rejection outside that range, ISO reset validation, stale lease reclamation, provider mismatch, disabled/auth-required accounts, per-account project configuration, and rejection of credential-shaped fields.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `npm test -- tests/state-store.test.ts`

Expected: FAIL because provider-account and usage APIs do not exist.

- [ ] **Step 3: Add migration 3 and minimal typed APIs**

Create normalized tables:

```sql
CREATE TABLE provider_accounts (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  label TEXT NOT NULL,
  profile_path TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('ready','disabled','auth_required','cooldown')),
  max_concurrency INTEGER NOT NULL CHECK(max_concurrency > 0),
  is_default INTEGER NOT NULL CHECK(is_default IN (0,1)),
  last_used_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX provider_accounts_one_default
  ON provider_accounts(provider) WHERE is_default = 1;
CREATE TABLE provider_account_configs (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES provider_accounts(id) ON DELETE CASCADE,
  settings_json TEXT NOT NULL,
  PRIMARY KEY(project_id, account_id)
);
CREATE TABLE account_leases (
  account_id TEXT NOT NULL REFERENCES provider_accounts(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY(account_id, run_id)
);
CREATE TABLE usage_snapshots (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES provider_accounts(id) ON DELETE CASCADE,
  period TEXT NOT NULL CHECK(period = 'weekly'),
  model TEXT NOT NULL,
  remaining_percent REAL NOT NULL CHECK(remaining_percent >= 0 AND remaining_percent <= 100),
  resets_at TEXT,
  source TEXT NOT NULL CHECK(source IN ('manual','provider')),
  observed_at TEXT NOT NULL
);
```

Use an immediate SQLite transaction when changing the default account or acquiring capacity. Account leases expire after sixty minutes unless refreshed by a later run inspection. Do not persist environment variables, tokens, cookies, or keychain values.

- [ ] **Step 4: Verify GREEN and refactor while green**

Run: `npm run check && npm test -- tests/state-store.test.ts`

Expected: state tests pass with no TypeScript diagnostics.

- [ ] **Step 5: Run accumulated verification and commit**

Run: `npm test`

Commit: `feat: add provider account and usage state`

---

### Task 2: Account-bound execution and isolated result branches

**Files:**
- Modify: `src/provider.ts`
- Modify: `src/state-store.ts`
- Modify: `src/relay-core.ts`
- Modify: `src/providers/claude.ts`
- Modify: `src/providers/codex.ts`
- Modify: `src/providers/jules.ts`
- Modify: `tests/claude-provider.test.ts`
- Modify: `tests/codex-provider.test.ts`
- Modify: `tests/relay-core.test.ts`

**Interfaces:**
- Consumes: Task 1 account lookup, per-account config, and account leasing.
- Produces: optional `accountId` and `model` on delegate/handoff inputs; account-bound sessions and runs; `profilePath` and `model` provider execution inputs; deterministic `relay/run/<work-prefix>/<run-prefix>` result branches.

- [ ] **Step 1: Write failing provider and core tests**

Add tests proving:

```ts
test('runs Codex with the selected account home and requested cloud model', async () => {
  const provider = codexWithFixture();
  await provider.start({ prompt: 'Build it', cwd: '/tmp/repo', mode: 'write', branch: 'main',
    environmentId: 'env-1', profilePath: '/profiles/codex-a', model: 'gpt-5.6-sol' });
  assert.deepEqual(lastCommand(), ['cloud','exec','--env','env-1','-c','model="gpt-5.6-sol"','--branch','main','Build it']);
  assert.equal(lastEnvironment().CODEX_HOME, '/profiles/codex-a');
});

test('runs Claude with the selected config directory and model', async () => {
  const provider = claudeWithFixture();
  await provider.start({ prompt: 'Build it', cwd: '/tmp/repo', mode: 'write',
    profilePath: '/profiles/claude-a', model: 'opus' });
  assert.equal(lastEnvironment().CLAUDE_CONFIG_DIR, '/profiles/claude-a');
  assert.ok(lastCommand().includes('--model'));
});

test('allows parallel writers only on distinct run branches', async () => {
  const relay = seededRelayWithTwoAccounts();
  const [a, b] = await Promise.all([
    relay.delegate({ provider: 'codex', accountId: 'codex-a', task: 'A', workItemId: 'work-1', mode: 'write' }),
    relay.delegate({ provider: 'codex', accountId: 'codex-b', task: 'B', workItemId: 'work-1', mode: 'write' }),
  ]);
  assert.notEqual(a.run.expectedBranch, b.run.expectedBranch);
  assert.equal(a.run.baseSha, b.run.baseSha);
});
```

Also prove that an explicit account must match the provider, an omitted account uses only the configured default, sessions are scoped by account, follow-ups cannot switch accounts, selected model is persisted with the run, account capacity is released only after a terminal provider state, and the old WorkItem mutation lease no longer blocks distinct run branches.

Retain the existing pinned-read invariant: if a read run's exact remote branch disappears or no longer resolves to the expected SHA, classify it as `head_moved`, never `awaiting_publish`.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npm test -- tests/codex-provider.test.ts tests/claude-provider.test.ts tests/relay-core.test.ts`

Expected: FAIL because account/model execution context and isolated run branches are missing.

- [ ] **Step 3: Extend provider and state contracts minimally**

Add optional `profilePath` and `model` to provider start/send/inspect/attach inputs. Add `selectModel` and `profileIsolation` to provider capabilities. Codex maps `profilePath` to `CODEX_HOME` and passes a validated model as `-c model="<model>"`; Claude maps it to `CLAUDE_CONFIG_DIR` and passes `--model <model>`; Jules reports both capabilities unavailable.

Migration 4 adds nullable `account_id` to sessions and runs plus nullable `model`, full `base_sha`, and `result_sha` to runs. Existing rows remain valid as legacy/default-account executions.

- [ ] **Step 4: Replace shared writer leasing with isolated run creation**

For every new write run:

```ts
const runId = randomUUID();
const integrationBranch = workItem.currentBranch ?? `relay/work/${slug(workItem.title)}-${workItem.id.slice(0, 8)}`;
const baseSha = await github.getBranchSha(project.repo, integrationBranch)
  ?? await github.getBranchSha(project.repo, workItem.baseBranch);
const resultBranch = `relay/run/${workItem.id.slice(0, 8)}/${runId.slice(0, 8)}`;
```

Require `baseSha`, bind the account lease to `runId`, record the run before provider submission, tell the provider to push only `resultBranch`, and reconcile only that branch. Read runs remain pinned to an immutable SHA and never receive a push instruction.

- [ ] **Step 5: Verify GREEN and accumulated behavior**

Run: `npm run check && npm test`

Expected: all provider, core, state, CLI, and MCP tests pass.

- [ ] **Step 6: Commit**

Commit: `feat: isolate runs across provider accounts`

---

### Task 3: Immutable candidates and serialized staged landing

**Files:**
- Create: `src/landing.ts`
- Create: `tests/landing.test.ts`
- Modify: `src/state-store.ts`
- Modify: `src/github-client.ts`
- Modify: `src/relay-core.ts`
- Modify: `tests/state-store.test.ts`
- Modify: `tests/github-client.test.ts`
- Modify: `tests/fixtures/bin/gh`

**Interfaces:**
- Consumes: Task 2 full `baseSha`, unique result branch, and GitHub-observed `resultSha`.
- Produces: `CandidateRecord`, `LandingCoordinator.land(runId)`, GitHub commit-check inspection, one WorkItem landing lease, staging branches, fast-forward-only integration updates, and one integration PR.

- [ ] **Step 1: Write failing candidate and real-Git landing tests**

Use temporary local bare repositories and real `git` processes for merge behavior. Mock only GitHub’s external check/PR boundary. Prove:

```ts
test('prepares one candidate on a staging branch without moving integration', async () => {
  const fixture = await createLandingRepository();
  const result = await fixture.lander.land(fixture.runId);
  assert.equal(result.status, 'staged');
  assert.equal(await fixture.remoteSha(fixture.integrationBranch), fixture.integrationBefore);
  assert.equal(await fixture.remoteSha(result.stagingBranch!), result.stagingSha);
});

test('fast-forwards integration only after the exact staging SHA passes checks', async () => {
  const fixture = await createLandingRepository({ checks: 'passing' });
  const staged = await fixture.lander.land(fixture.runId);
  const landed = await fixture.lander.land(fixture.runId);
  assert.equal(landed.status, 'landed');
  assert.equal(await fixture.remoteSha(fixture.integrationBranch), staged.stagingSha);
});

test('leaves integration unchanged on textual conflict', async () => {
  const fixture = await createConflictingLandingRepository();
  const result = await fixture.lander.land(fixture.runId);
  assert.equal(result.status, 'conflict');
  assert.deepEqual(result.conflictFiles, ['src/shared.ts']);
  assert.equal(await fixture.remoteSha(fixture.integrationBranch), fixture.integrationBefore);
});
```

Also prove pending/unknown checks remain staged, failing checks become `checks_failed`, a moved integration head becomes `stale`, two landing attempts serialize, only committed candidate SHAs are accepted, stage cleanup does not discard source branches, and no code path uses `--force`.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npm test -- tests/landing.test.ts tests/state-store.test.ts tests/github-client.test.ts`

Expected: FAIL because candidate and landing APIs do not exist.

- [ ] **Step 3: Add migration 5 and candidate state**

Create `candidates` with one row per write run and statuses `ready`, `staged`, `landed`, `conflict`, `checks_failed`, `stale`, and `discarded`. Persist source branch/SHA, base SHA, optional staging branch/SHA, the integration base SHA used for preparation, optional landed SHA, conflict paths as JSON, and timestamps. Create `landing_leases` keyed by WorkItem and expiring after sixty minutes.

When run reconciliation observes a new full SHA on its unique result branch, persist one `ready` candidate. Never create a candidate from a provider message, pull-request number, missing branch, unchanged base SHA, or uncommitted local state.

- [ ] **Step 4: Implement the idempotent two-phase lander**

On a `ready`, `conflict`, `checks_failed`, or `stale` candidate, acquire the WorkItem landing lease, fetch exact refs, verify source and integration SHAs, run `git merge-tree --write-tree`, create a temporary detached integration worktree, apply `git merge --squash <resultSha>`, commit with Relay provenance trailers, and push only `HEAD:refs/heads/relay/stage/<candidate-prefix>`. Record `staged` and clean the temporary worktree in `finally`.

On a `staged` candidate, query checks for the exact staging SHA. Return without mutation for `pending` or `unknown`; mark `checks_failed` for failures. For passing checks, verify the integration ref still equals `integrationBaseSha`, push the staged commit to the integration ref without force, re-read GitHub, record `landed`, and ensure one PR from the integration branch to the WorkItem base branch.

PR reconciliation and final human-approved merge must also verify that the PR base branch equals the WorkItem's recorded base branch; a PR targeting a different base is not a valid Relay artifact.

- [ ] **Step 5: Verify GREEN and accumulated behavior**

Run: `npm run check && npm test`

Expected: landing tests and the accumulated suite pass without network access.

- [ ] **Step 6: Commit**

Commit: `feat: add serialized candidate landing`

---

### Task 4: Orchestrator-facing CLI, MCP, status, and documentation

**Files:**
- Modify: `src/app.ts`
- Modify: `src/mcp.ts`
- Modify: `src/repl.ts`
- Modify: `tests/cli.test.ts`
- Modify: `tests/mcp.test.ts`
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-08-16-relay-madness-design.md`

**Interfaces:**
- Consumes: Tasks 1–3 account, usage, isolated-run, candidate, and landing APIs.
- Produces: account/usage CLI commands; account/model selection on delegation; `relay_accounts` and `relay_land` MCP tools; candidate-aware status; documented warning and safety model.

- [ ] **Step 1: Write failing CLI and MCP behavior tests**

Add tests for these exact workflows:

```text
relay account add codex codex-a --label Primary --profile /profiles/codex-a --default
relay accounts --json
relay usage set codex-a --model gpt-5.6-sol --remaining-percent 62 --resets-at 2026-08-20T00:00:00Z
relay usage --account codex-a --json
relay delegate codex "Implement it" --account codex-a --model gpt-5.6-sol
relay land <run-id> --json
```

Verify `relay_accounts` is read-only and returns account ID, label, provider, status, capacity, active lease count, and latest model usage without profile paths. Verify `relay_land` accepts only a run ID, is marked destructive because it mutates the integration branch, never merges `main`, and returns candidate status plus exact SHAs. Verify delegate and handoff accept optional `account` and `model` fields and reject unknown fields.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npm test -- tests/cli.test.ts tests/mcp.test.ts`

Expected: FAIL because the new commands, fields, and tools are missing.

- [ ] **Step 3: Implement the thin public surface**

Add only forwarding and validation in CLI/MCP; all decisions remain in Relay Core. `relay status --json` includes candidates and the integration branch. Human-facing account output must not print profile paths unless the user explicitly requests the single account through the local CLI; MCP never returns them.

The usage setter validates finite `0..100` percentages and normalized ISO timestamps. It does not infer usage, scrape provider UIs, or select an account/model.

- [ ] **Step 4: Update product documentation**

Document:

- isolated append-only run branches;
- the staged two-call landing lifecycle;
- one integration PR per WorkItem;
- Linux bridge recommendation for multiple Claude profiles because macOS uses Keychain;
- `CODEX_HOME` and `CLAUDE_CONFIG_DIR` profile references;
- the warning that users must follow provider terms and must not share credentials or use Relay to bypass protective limits;
- weekly usage snapshots as caller-supplied scheduling telemetry;
- attribution for any copied MIT or Apache-2.0 source rather than unattributed copying.

- [ ] **Step 5: Run full verification and package smoke test**

Run: `npm run verify`

Expected: typecheck, complete test suite, package smoke test, and production build all succeed.

- [ ] **Step 6: Commit**

Commit: `feat: expose account fleet and safe landing`
