# Relay Madness Full Build Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and publish the complete first Relay Madness release: a thin TypeScript CLI and STDIO MCP server that coordinates Claude, Codex, and Jules cloud work while verifying durable results through GitHub.

**Architecture:** A single `RelayCore` owns orchestration and is called by both the CLI and MCP surfaces. Provider adapters own only provider protocol translation, `StateStore` owns SQLite coordination truth, and `GitHubClient` owns explicit branch, pull-request, check, and SHA-bound merge inspection. External commands and HTTP are injected at their boundaries so tests use real fixture processes and schema-complete fake responses without contacting providers.

**Tech Stack:** Node.js 22.12+, TypeScript 7, ESM, Commander 15, Zod 4, `better-sqlite3` 13, MCP TypeScript SDK 2, Node test runner through `tsx`, GitHub Actions.

## Global Constraints

- Relay never hosts model inference, build environments, project dependencies, or development virtual machines.
- Relay owns coordination state; providers own execution and conversation state; GitHub owns durable artifact truth.
- A provider completion never implies a published or verified GitHub artifact.
- WorkItem identifiers and full 40-character commit SHAs are the cross-provider coordination keys.
- Provider-account capacity gates execution; concurrent writes use distinct `relay/run/...` result branches, read-only runs are SHA-pinned, and each WorkItem landing is serialized.
- Provider tokens and GitHub credentials are never stored.
- MCP exposes delegate, send, handoff, and status only; merge remains interactive CLI-only.
- Runtime dependencies are limited to `@modelcontextprotocol/server`, Zod, Commander, and `better-sqlite3`.
- Public CI never contacts provider accounts.
- All new behavior follows red-green-refactor and commits only after focused and accumulated verification pass.
- macOS and Linux are supported; Windows and public HTTP bridge mode are outside this release.

---

### Task 1: Package, error model, redaction, and process runner

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `tsconfig.build.json`
- Create: `src/errors.ts`
- Create: `src/process-runner.ts`
- Create: `src/provider.ts`
- Create: `tests/process-runner.test.ts`

**Interfaces:**
- Produces: `RelayError`, `redact`, `ProcessRunner.run()`, `ProcessRunner.spawnInteractive()`, provider capability and execution contracts.
- Consumes: Node `child_process`, `crypto`, and standard path/process APIs only.

- [ ] **Step 1: Add package configuration with exact scripts and dependencies**

```json
{
  "name": "relay-madness",
  "version": "0.1.0",
  "type": "module",
  "bin": { "relay": "dist/cli.js" },
  "engines": { "node": ">=22.12.0" },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "check": "tsc -p tsconfig.json --noEmit",
    "test": "node --import tsx --test tests/*.test.ts",
    "verify": "npm run check && npm test && npm run build"
  },
  "dependencies": {
    "@modelcontextprotocol/server": "^2.0.0",
    "better-sqlite3": "^13.0.3",
    "commander": "^15.0.0",
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "@modelcontextprotocol/client": "^2.0.0",
    "@types/better-sqlite3": "^9.6.0",
    "@types/node": "^26.2.0",
    "tsx": "^4.23.12",
    "typescript": "^7.0.2"
  }
}
```

Use `module: NodeNext`, `moduleResolution: NodeNext`, `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`, `rootDir: .`, and include `src/**/*.ts` plus `tests/**/*.ts`. The build config extends it, sets `rootDir: src`, `outDir: dist`, emits declarations and source maps, and excludes tests.

- [ ] **Step 2: Install dependencies and write failing boundary tests**

```ts
test('runs a command without a shell and preserves separate streams', async () => {
  const result = await new ProcessRunner().run(process.execPath, [
    '-e',
    "process.stdout.write('out'); process.stderr.write('err')"
  ]);
  assert.deepEqual(result, { command: process.execPath, exitCode: 0, stdout: 'out', stderr: 'err' });
});

test('kills a command after its deadline', async () => {
  await assert.rejects(
    new ProcessRunner().run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 25 }),
    (error: unknown) => error instanceof RelayError && error.code === 'process_timeout'
  );
});

test('redacts nested credential-shaped values', () => {
  assert.deepEqual(redact({ token: 'abc', nested: { apiKey: 'def', safe: 'yes' } }), {
    token: '[REDACTED]', nested: { apiKey: '[REDACTED]', safe: 'yes' }
  });
});
```

- [ ] **Step 3: Run the focused tests and observe module-resolution failures**

Run: `npm test -- tests/process-runner.test.ts`

Expected: FAIL because `src/process-runner.ts` and `src/errors.ts` do not exist.

- [ ] **Step 4: Implement the minimal typed boundary**

```ts
export class RelayError extends Error {
  constructor(
    readonly code: RelayErrorCode,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
    options?: ErrorOptions
  ) { super(message, options); this.name = 'RelayError'; }
}

export interface ProcessResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export class ProcessRunner {
  run(command: string, args: readonly string[], options?: RunOptions): Promise<ProcessResult>;
  spawnInteractive(command: string, args: readonly string[], options?: InteractiveOptions): Promise<number>;
}
```

Use `spawn(command, args, { shell: false })`, merge only explicitly supplied environment overrides with `process.env`, collect streams independently, reject nonzero exits as `process_failed`, and kill timed-out children before rejecting as `process_timeout`. `redact` recursively masks case-insensitive keys containing token, secret, key, authorization, credential, or password.

Define provider contracts for `ProviderName`, `ProviderCapabilities`, `AuthStatus`, `StartRunInput`, `SendRunInput`, `InspectRunInput`, `ProviderExecution`, `ProviderInspection`, and `CloudProvider` exactly as the design requires.

- [ ] **Step 5: Verify, refactor names only while green, and commit**

Run: `npm run check && npm test`

Expected: all focused tests pass with no TypeScript diagnostics.

Commit: `feat: add process and provider foundations`

---

### Task 2: SQLite coordination state and capacity leases

**Files:**
- Create: `src/state-store.ts`
- Create: `tests/state-store.test.ts`

**Interfaces:**
- Consumes: `RelayError`, `better-sqlite3`, `crypto.randomUUID`.
- Produces: domain records and `StateStore` methods used by Relay Core.

- [ ] **Step 1: Write failing state behavior tests**

```ts
test('persists a project, WorkItem, session, run, and artifact snapshot', () => {
  const store = openTemporaryStore();
  const project = store.upsertProject({ repo: 'acme/web', defaultBranch: 'main', locatorPath: '/tmp/web' });
  const workItem = store.createWorkItem({ projectId: project.id, title: 'Passwordless auth', baseBranch: 'main' });
  const session = store.upsertSession({ workItemId: workItem.id, provider: 'claude', providerSessionId: 'session_1', status: 'active' });
  const run = store.createRun({ sessionId: session.id, provider: 'claude', type: 'delegation', prompt: 'Build it', mutationMode: 'write' });
  store.transitionRun(run.id, 'provider_complete');
  store.saveArtifact({ workItemId: workItem.id, branch: 'relay/auth', sha: 'a'.repeat(40), pullRequest: 12, checks: 'passing' });
  assert.equal(store.getStatus(workItem.id).artifact?.sha, 'a'.repeat(40));
});

test('enforces provider-account capacity transactionally', () => {
  const store = seededStore();
  store.acquireAccountLease('account_1', 'run_1', new Date('2026-08-16T12:00:00Z'));
  assert.throws(
    () => store.acquireAccountLease('account_1', 'run_2', new Date('2026-08-16T12:00:01Z')),
    (error: unknown) => error instanceof RelayError && error.code === 'account_at_capacity'
  );
});

test('creates the database and parent directory with user-only permissions', () => {
  const path = temporaryDatabasePath();
  StateStore.open(path).close();
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(dirname(path)).mode & 0o777, 0o700);
});
```

- [ ] **Step 2: Run the focused tests and observe the missing store failure**

Run: `npm test -- tests/state-store.test.ts`

Expected: FAIL because `StateStore` is missing.

- [ ] **Step 3: Implement schema migration and transactional methods**

Create tables `schema_migrations`, `projects`, `provider_configs`, `work_items`, `provider_sessions`, `provider_runs`, `provider_accounts`, `account_leases`, `artifact_snapshots`, `candidates`, and `landing_leases` with foreign keys enabled. Store timestamps as ISO-8601 text and JSON objects as validated JSON text.

```ts
export class StateStore {
  static open(databasePath: string): StateStore;
  close(): void;
  upsertProject(input: ProjectInput): ProjectRecord;
  setProviderConfig(projectId: string, provider: ProviderName, settings: Record<string, unknown>): void;
  getProviderConfig(projectId: string, provider: ProviderName): Record<string, unknown> | undefined;
  createWorkItem(input: WorkItemInput): WorkItemRecord;
  getWorkItem(id: string): WorkItemRecord;
  getCurrentWorkItem(projectId: string): WorkItemRecord | undefined;
  upsertSession(input: SessionInput): SessionRecord;
  getSession(workItemId: string, provider: ProviderName): SessionRecord | undefined;
  listSessions(workItemId: string): readonly SessionRecord[];
  createRun(input: RunInput): RunRecord;
  transitionRun(id: string, status: RunStatus): RunRecord;
  countRuns(workItemId: string): number;
  acquireAccountLease(accountId: string, runId: string, now?: Date): AccountLeaseRecord;
  releaseAccountLease(accountId: string, runId: string): void;
  acquireLandingLease(workItemId: string, runId: string, now?: Date): LandingLeaseRecord;
  releaseLandingLease(workItemId: string, runId: string): void;
  saveArtifact(input: ArtifactInput): ArtifactRecord;
  getLatestArtifact(workItemId: string): ArtifactRecord | undefined;
  getStatus(workItemId: string): WorkItemStatus;
}
```

Enforce the normalized run transitions in code. Reject invalid transitions as `invalid_run_transition`; reject a 21st run as `run_budget_exceeded`; set directory mode `0700` and database mode `0600`.

- [ ] **Step 4: Verify focused and accumulated tests, then commit**

Run: `npm run check && npm test`

Expected: process and state suites pass.

Commit: `feat: add durable relay state`

---

### Task 3: GitHub detection, reconciliation, and safe merge

**Files:**
- Create: `src/github-client.ts`
- Create: `tests/fixtures/bin/gh`
- Create: `tests/github-client.test.ts`
- Create: `tests/test-environment.ts`

**Interfaces:**
- Consumes: `ProcessRunner`, `RelayError`.
- Produces: `GitHubClient.detectProject()`, `reconcile()`, and `merge()`.

- [ ] **Step 1: Write a fixture executable and failing observable tests**

The fixture reads `FAKE_GH_SCENARIO`, emits complete documented JSON shapes, and appends received arguments to `FAKE_COMMAND_LOG`. Tests prepend `tests/fixtures/bin` to `PATH` and assert returned domain values rather than assertions on an in-memory mock.

```ts
test('detects the repository and default branch through gh JSON', async () => {
  const github = githubForScenario('project');
  assert.deepEqual(await github.detectProject('/tmp/acme'), {
    repo: 'acme/web', defaultBranch: 'main', url: 'https://github.com/acme/web'
  });
});

test('reconciles an explicit branch to a full SHA and pull request', async () => {
  const state = await githubForScenario('published').reconcile({ repo: 'acme/web', branch: 'relay/auth' });
  assert.equal(state.sha, 'b'.repeat(40));
  assert.equal(state.pullRequest, 143);
  assert.equal(state.checks, 'passing');
});

test('refuses merge when the observed head differs from the approved SHA', async () => {
  await assert.rejects(
    githubForScenario('moved').merge({ repo: 'acme/web', pullRequest: 143, expectedSha: 'a'.repeat(40), strategy: 'squash', approved: true }),
    (error: unknown) => error instanceof RelayError && error.code === 'head_moved'
  );
});

test('uses the full expected SHA when all merge gates pass', async () => {
  await githubForScenario('mergeable').merge({ repo: 'acme/web', pullRequest: 143, expectedSha: 'b'.repeat(40), strategy: 'squash', approved: true });
  assert.match(readCommandLog(), /--match-head-commit [b]{40}/);
});
```

- [ ] **Step 2: Run the GitHub suite and observe the missing client failure**

Run: `npm test -- tests/github-client.test.ts`

Expected: FAIL because `GitHubClient` is missing.

- [ ] **Step 3: Implement explicit JSON-based GitHub operations**

```ts
export class GitHubClient {
  constructor(private readonly runner: ProcessRunner) {}
  detectProject(cwd: string): Promise<DetectedProject>;
  reconcile(input: { repo: string; branch: string; pullRequest?: number }): Promise<GitHubArtifact>;
  merge(input: MergeInput): Promise<void>;
}
```

Use `gh repo view --json nameWithOwner,defaultBranchRef,url`, `gh api repos/{owner}/{repo}/git/ref/heads/{encoded-branch}`, `gh pr list --head ... --state all --json number,url,state,headRefName,headRefOid,baseRefName,isDraft`, `gh pr view --json headRefOid,isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup`, and `gh pr checks --required --json name,state,bucket,link`. Missing refs return `awaiting_publish`. Never infer a branch. Merge requires `approved`, full SHA equality, non-draft, passing required checks, mergeable state, and executes `gh pr merge --match-head-commit <sha>`.

- [ ] **Step 4: Verify focused and accumulated tests, then commit**

Run: `npm run check && npm test`

Expected: all suites pass and the fake command log proves SHA binding.

Commit: `feat: add GitHub artifact verification`

---

### Task 4: Claude cloud adapter

**Files:**
- Create: `src/providers/claude.ts`
- Create: `tests/fixtures/bin/claude`
- Create: `tests/claude-provider.test.ts`

**Interfaces:**
- Consumes: `CloudProvider`, `ProcessRunner`, `RelayError`.
- Produces: `ClaudeProvider`.

- [ ] **Step 1: Write failing real-process adapter tests**

```ts
test('starts a Claude cloud session and parses its documented URL', async () => {
  const execution = await claudeForScenario('start').start({
    prompt: 'Implement auth', cwd: '/tmp/locator', branch: 'relay/auth', mode: 'write'
  });
  assert.equal(execution.providerSessionId, 'session_abc123');
  assert.equal(execution.url, 'https://claude.ai/code/session_abc123');
  assert.equal(execution.status, 'running');
});

test('sends a follow-up to the existing session', async () => {
  const execution = await claudeForScenario('send').send!({
    providerSessionId: 'session_abc123', message: 'Fix the test', cwd: '/tmp/locator'
  });
  assert.equal(execution.providerSessionId, 'session_abc123');
  assert.match(readCommandLog(), /-p Fix the test --cloud session_abc123 --output-format json/);
});

test('rejects cloud output without a session identifier', async () => {
  await assert.rejects(
    claudeForScenario('malformed').start({ prompt: 'x', cwd: '/tmp', mode: 'write' }),
    (error: unknown) => error instanceof RelayError && error.code === 'provider_output_invalid'
  );
});
```

- [ ] **Step 2: Run the Claude suite and observe the missing adapter failure**

Run: `npm test -- tests/claude-provider.test.ts`

Expected: FAIL because `ClaudeProvider` is missing.

- [ ] **Step 3: Implement runtime capability probing and commands**

`authStatus()` runs `claude auth status`; `capabilities()` combines executable availability with version/help probing. `start()` invokes `claude --cloud <prompt>` from the locator checkout and accepts a JSON `session_id` or documented session URL. `send()` invokes `claude -p <message> --cloud <session-id> --output-format json`. `attach()` uses inherited stdio. Prompts are separate arguments and never interpolated into a shell command.

- [ ] **Step 4: Verify focused and accumulated tests, then commit**

Run: `npm run check && npm test`

Expected: Claude and prior suites pass.

Commit: `feat: add Claude cloud adapter`

---

### Task 5: Jules REST adapter

**Files:**
- Create: `src/providers/jules.ts`
- Create: `tests/jules-provider.test.ts`

**Interfaces:**
- Consumes: `CloudProvider`, injected `fetch`, runtime `JULES_API_KEY` lookup.
- Produces: `JulesProvider.start()`, `send()`, `inspect()`, `approvePlan()`, `listActivities()`.

- [ ] **Step 1: Write failing schema-complete HTTP boundary tests**

```ts
test('creates an AUTO_CREATE_PR session without persisting its API key', async () => {
  const { provider, requests } = julesWithResponses([{ status: 200, body: {
    name: 'sessions/1234567', id: 'abc123', prompt: 'Add tests', title: 'Tests', state: 'QUEUED',
    url: 'https://jules.google.com/session/abc123', createTime: '2026-08-16T12:00:00Z', updateTime: '2026-08-16T12:00:00Z'
  } }]);
  const result = await provider.start({
    prompt: 'Add tests', title: 'Tests', repo: 'acme/web', branch: 'main', source: 'sources/github-acme-web', mode: 'write'
  });
  assert.equal(result.providerSessionId, 'sessions/1234567');
  assert.equal(requests[0]?.headers.get('x-goog-api-key'), 'test-key');
  assert.deepEqual(JSON.parse(requests[0]?.body as string), {
    prompt: 'Add tests', title: 'Tests', sourceContext: {
      source: 'sources/github-acme-web', githubRepoContext: { startingBranch: 'main' }
    }, requirePlanApproval: false, automationMode: 'AUTO_CREATE_PR'
  });
});

test('sends a follow-up with the documented prompt body', async () => {
  const { provider, requests } = julesWithResponses([{ status: 200, body: {} }]);
  await provider.send!({ providerSessionId: 'sessions/1234567', message: 'Add edge cases', cwd: '/tmp' });
  assert.equal(requests[0]?.url, 'https://jules.googleapis.com/v1alpha/sessions/1234567:sendMessage');
  assert.deepEqual(JSON.parse(requests[0]?.body as string), { prompt: 'Add edge cases' });
});

test('maps completed session output to a pull request artifact', async () => {
  const provider = julesWithSessionState('COMPLETED', 'https://github.com/acme/web/pull/42');
  const inspected = await provider.inspect!({ providerSessionId: 'sessions/1234567' });
  assert.deepEqual(inspected.artifact, { pullRequestUrl: 'https://github.com/acme/web/pull/42', pullRequest: 42 });
});
```

- [ ] **Step 2: Run the Jules suite and observe the missing adapter failure**

Run: `npm test -- tests/jules-provider.test.ts`

Expected: FAIL because `JulesProvider` is missing.

- [ ] **Step 3: Implement the official v1alpha REST surface**

Use `https://jules.googleapis.com/v1alpha`. Send `x-goog-api-key` and `Content-Type: application/json`. Validate all responses with Zod. Implement `POST /sessions`, `GET /sessions/{id}`, `POST /sessions/{id}:sendMessage`, `POST /sessions/{id}:approvePlan`, and `GET /sessions/{id}/activities?pageSize=100`. Map Jules states to normalized provider states without claiming GitHub publication from `COMPLETED` alone.

- [ ] **Step 4: Verify focused and accumulated tests, then commit**

Run: `npm run check && npm test`

Expected: Jules and prior suites pass without network access.

Commit: `feat: add Jules cloud adapter`

---

### Task 6: Codex cloud adapter

**Files:**
- Create: `src/providers/codex.ts`
- Create: `tests/fixtures/bin/codex`
- Create: `tests/codex-provider.test.ts`

**Interfaces:**
- Consumes: `CloudProvider`, `ProcessRunner`, project `environmentId`.
- Produces: `CodexProvider` with explicitly unavailable queue follow-up.

- [ ] **Step 1: Write failing command and capability tests**

```ts
test('submits a cloud task to the configured environment and branch', async () => {
  const result = await codexForScenario('exec').start({
    prompt: 'Review auth', cwd: '/tmp', branch: 'relay/auth', environmentId: 'env_123', mode: 'read'
  });
  assert.equal(result.providerSessionId, 'task_456');
  assert.match(readCommandLog(), /cloud exec --env env_123 --branch relay\/auth Review auth/);
});

test('inspects task status from cloud list JSON', async () => {
  const result = await codexForScenario('list').inspect!({ providerSessionId: 'task_456', environmentId: 'env_123' });
  assert.equal(result.status, 'provider_complete');
  assert.equal(result.url, 'https://chatgpt.com/codex/tasks/task_456');
});

test('reports programmatic follow-up as unavailable', async () => {
  const provider = codexForScenario('exec');
  assert.equal((await provider.capabilities()).queueFollowup, false);
  await assert.rejects(
    provider.send!({ providerSessionId: 'task_456', message: 'continue', cwd: '/tmp' }),
    (error: unknown) => error instanceof RelayError && error.code === 'capability_unavailable'
  );
});
```

- [ ] **Step 2: Run the Codex suite and observe the missing adapter failure**

Run: `npm test -- tests/codex-provider.test.ts`

Expected: FAIL because `CodexProvider` is missing.

- [ ] **Step 3: Implement only documented cloud commands**

Invoke `codex cloud exec --env <id> --branch <branch> <prompt>`, parse the task ID from documented URL/text output, and inspect with `codex cloud list --env <id> --json`. `attach()` launches `codex cloud` with inherited stdio. `send()` always throws `capability_unavailable`; no undocumented continuation is attempted.

- [ ] **Step 4: Verify focused and accumulated tests, then commit**

Run: `npm run check && npm test`

Expected: Codex and prior suites pass.

Commit: `feat: add Codex cloud adapter`

---

### Task 7: Relay Core, handoffs, recovery, and status

**Files:**
- Create: `src/handoff.ts`
- Create: `src/relay-core.ts`
- Create: `tests/relay-core.test.ts`

**Interfaces:**
- Consumes: `StateStore`, `GitHubClient`, and a provider registry.
- Produces: the only orchestration API used by CLI and MCP.

- [ ] **Step 1: Write failing end-to-end core tests with real SQLite**

```ts
test('reuses an active provider session for send', async () => {
  const harness = await relayHarness();
  const delegated = await harness.core.delegate({ provider: 'claude', task: 'Implement auth', title: 'Auth', cwd: harness.cwd });
  const sent = await harness.core.send({ provider: 'claude', message: 'Add tests', workItemId: delegated.workItem.id });
  assert.equal(sent.session.providerSessionId, delegated.session.providerSessionId);
  assert.equal(harness.providerStarts, 1);
  assert.equal(harness.providerSends, 1);
});

test('marks provider completion as awaiting publish until GitHub resolves a branch', async () => {
  const harness = await relayHarness({ githubScenario: 'missing' });
  const result = await harness.core.delegate({ provider: 'claude', task: 'Implement auth', title: 'Auth', cwd: harness.cwd });
  assert.equal(result.run.status, 'awaiting_publish');
  assert.equal(result.artifact, undefined);
});

test('builds a handoff from the reconciled full SHA rather than transcripts', async () => {
  const harness = await relayHarness({ githubScenario: 'published' });
  const original = await harness.core.delegate({ provider: 'claude', task: 'Implement auth', title: 'Auth', cwd: harness.cwd });
  const result = await harness.core.handoff({ provider: 'jules', instruction: 'Add edge-case tests', workItemId: original.workItem.id });
  assert.match(result.prompt, new RegExp(`Source commit: ${'b'.repeat(40)}`));
  assert.doesNotMatch(result.prompt, /Implement auth/);
});

test('rejects delegation beyond depth two and the twenty-run budget', async () => {
  const harness = await relayHarness();
  await assert.rejects(
    harness.core.delegate({ provider: 'jules', task: 'loop', workItemId: 'work_1', parentRunId: 'run_depth_2' }),
    (error: unknown) => error instanceof RelayError && error.code === 'delegation_depth_exceeded'
  );
});
```

- [ ] **Step 2: Run the core suite and observe missing core failures**

Run: `npm test -- tests/relay-core.test.ts`

Expected: FAIL because `RelayCore` and `buildHandoffPacket` are missing.

- [ ] **Step 3: Implement the orchestration service**

```ts
export class RelayCore {
  doctor(): Promise<DoctorReport>;
  initialize(input: InitializeInput): Promise<ProjectRecord>;
  delegate(input: DelegateInput): Promise<RelayRunResult>;
  send(input: SendInput): Promise<RelayRunResult>;
  handoff(input: HandoffInput): Promise<RelayRunResult & { prompt: string }>;
  reconcile(input: WorkItemSelector): Promise<ArtifactRecord | undefined>;
  status(input: WorkItemSelector): Promise<RelayStatus>;
  sessions(input: WorkItemSelector): Promise<readonly SessionRecord[]>;
  providers(): Promise<Readonly<Record<ProviderName, ProviderCapabilities>>>;
  chat(provider: ProviderName, input: WorkItemSelector): Promise<number>;
  merge(input: MergeRequest): Promise<void>;
}
```

Generate IDs with `randomUUID`. Generate isolated write targets as `relay/run/<work-item>/<run>`. Store prompts only when privacy configuration permits. Acquire and release provider-account capacity in `finally`, and serialize integration updates with a WorkItem landing lease. Reconcile after every provider execution. Recover expired sessions by starting a new session with a packet from the latest verified artifact. Generate delegation lineage internally from `parentRunId`; callers cannot supply depth or origin directly.

- [ ] **Step 4: Verify focused and accumulated tests, then commit**

Run: `npm run check && npm test`

Expected: all core and boundary suites pass.

Commit: `feat: coordinate provider work items`

---

### Task 8: CLI, doctor, direct commands, REPL, and interactive merge

**Files:**
- Create: `src/app.ts`
- Create: `src/repl.ts`
- Create: `src/cli.ts`
- Create: `tests/cli.test.ts`

**Interfaces:**
- Consumes: `RelayCore`.
- Produces: `createCli()`, `runRepl()`, executable `relay` entrypoint.

- [ ] **Step 1: Write failing CLI behavior tests through the compiled interface**

```ts
test('prints machine-readable status without provider identifiers leaking into prose', async () => {
  const io = memoryIo();
  await createCli(fakeCore(), io).parseAsync(['node', 'relay', 'status', '--json']);
  assert.deepEqual(JSON.parse(io.stdout), expectedRelayStatus);
});

test('doctor reports each dependency independently', async () => {
  const io = memoryIo();
  await createCli(fakeCore({ doctor: doctorFixture }), io).parseAsync(['node', 'relay', 'doctor']);
  assert.match(io.stdout, /GitHub\s+✓/);
  assert.match(io.stdout, /Claude\s+✗/);
  assert.match(io.stdout, /Codex\s+✓/);
  assert.match(io.stdout, /Jules\s+✗/);
});

test('merge defaults to refusal when confirmation is not yes', async () => {
  const core = fakeCore();
  const io = memoryIo({ answers: ['n'] });
  await createCli(core, io).parseAsync(['node', 'relay', 'merge', '--strategy', 'squash']);
  assert.equal(core.mergeCalls, 0);
  assert.match(io.stdout, /Merge cancelled/);
});

test('plain REPL text goes to the selected provider and current WorkItem', async () => {
  const core = fakeCore();
  await runRepl(core, memoryIo({ lines: ['/use claude', 'Add tests', '/quit'] }));
  assert.deepEqual(core.sendInputs, [{ provider: 'claude', message: 'Add tests', workItemId: 'current' }]);
});
```

- [ ] **Step 2: Run the CLI suite and observe missing command failures**

Run: `npm test -- tests/cli.test.ts`

Expected: FAIL because `createCli` and `runRepl` are missing.

- [ ] **Step 3: Implement the command surface and composition root**

Register `doctor`, `init`, `delegate`, `send`, `handoff`, `status`, `sessions`, `providers`, `reconcile`, `chat`, `merge`, and `mcp`. Add shortcut commands `claude`, `codex`, and `jules` that select the current session or create one. `--json` writes JSON to stdout; diagnostics use stderr. The default action opens the readline REPL. `merge` first prints PR, SHA, checks, and review state, then accepts only a normalized `y` or `yes` before calling core.

The composition root resolves state under `XDG_STATE_HOME/relay-madness` or `~/.local/state/relay-madness`, constructs one store, runner, GitHub client, provider registry, and core, and closes the store on exit.

- [ ] **Step 4: Verify focused and accumulated tests, then commit**

Run: `npm run check && npm test && npm run build && node dist/cli.js --help`

Expected: CLI suite passes, build succeeds, and help lists the complete command surface.

Commit: `feat: add Relay command interface`

---

### Task 9: STDIO MCP server using the same core

**Files:**
- Create: `src/mcp.ts`
- Create: `tests/mcp.test.ts`

**Interfaces:**
- Consumes: `RelayCore`, `@modelcontextprotocol/server`, Zod 4.
- Produces: `createRelayMcpServer(core)` and `serveRelayMcp(core)`.

- [ ] **Step 1: Write failing in-memory MCP integration tests**

Use the official SDK `InMemoryTransport.createLinkedPair()` with a real MCP `Client` and the production server factory.

```ts
test('exposes exactly the four non-merge tools', async () => {
  const { client, close } = await connectedMcp(fakeCore());
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map(tool => tool.name).sort(), [
    'relay_delegate', 'relay_handoff', 'relay_send', 'relay_status'
  ]);
  await close();
});

test('routes a handoff through Relay Core and returns structured status', async () => {
  const core = fakeCore();
  const { client, close } = await connectedMcp(core);
  const result = await client.callTool({
    name: 'relay_handoff', arguments: { provider: 'jules', workItem: 'current', instruction: 'Add tests' }
  });
  assert.deepEqual(result.structuredContent, expectedHandoffResult);
  assert.equal(core.handoffCalls, 1);
  await close();
});

test('rejects unknown input fields before reaching Relay Core', async () => {
  const core = fakeCore();
  const { client, close } = await connectedMcp(core);
  const result = await client.callTool({
    name: 'relay_status', arguments: { workItem: 'current', merge: true }
  });
  assert.equal(result.isError, true);
  assert.equal(core.statusCalls, 0);
  await close();
});
```

- [ ] **Step 2: Run the MCP suite and observe the missing server failure**

Run: `npm test -- tests/mcp.test.ts`

Expected: FAIL because `createRelayMcpServer` is missing.

- [ ] **Step 3: Implement four strict tools and STDIO serving**

Use `McpServer.registerTool()` with `.strict()` Zod schemas. Return both human-readable `content` and validated `structuredContent`. Mark status read-only and delegation tools non-destructive. Do not register merge. `serveRelayMcp()` uses `serveStdio`; stdout remains exclusively MCP JSON-RPC and the readiness banner goes to stderr.

- [ ] **Step 4: Verify focused, accumulated, build, and stdio smoke tests, then commit**

Run: `npm run check && npm test && npm run build`

Spawn `node dist/cli.js mcp` with the SDK `StdioClientTransport`, list tools, close the client, and confirm exit zero.

Commit: `feat: expose Relay through MCP`

---

### Task 10: OSS documentation, CI, package smoke, and release readiness

**Files:**
- Modify: `README.md`
- Create: `CONTRIBUTING.md`
- Create: `SECURITY.md`
- Create: `NOTICE`
- Create: `.github/workflows/ci.yml`
- Create: `tests/package-smoke.test.ts`

**Interfaces:**
- Consumes: the compiled CLI and npm package metadata.
- Produces: contributor-facing installation, provider setup, safety model, MCP configuration, and reproducible CI.

- [ ] **Step 1: Write the failing package smoke test**

```ts
test('packed package exposes a runnable relay binary without source files', async () => {
  const packed = await packIntoTemporaryDirectory();
  const files = await listTarballFiles(packed.tarball);
  assert.ok(files.includes('package/dist/cli.js'));
  assert.ok(!files.some(file => file.startsWith('package/src/')));
  const help = await runPackedBinary(packed.tarball, ['--help']);
  assert.equal(help.exitCode, 0);
  assert.match(help.stdout, /relay delegate/);
});
```

- [ ] **Step 2: Run the smoke test and observe package-content failure**

Run: `npm test -- tests/package-smoke.test.ts`

Expected: FAIL until `files`, `prepack`, executable shebang, and package metadata are complete.

- [ ] **Step 3: Complete package metadata and public documentation**

Add `files: ["dist", "README.md", "LICENSE", "NOTICE"]`, `prepack: npm run verify`, repository/homepage/bugs metadata, keywords, Apache-2.0 license metadata, and a `#!/usr/bin/env node` shebang.

README sections must cover: the three-layer truth model; installation; `relay doctor`; project initialization; direct commands; REPL; provider-specific setup and limitations; MCP configuration for Codex, Claude Code, VS Code, and Cursor; privacy; safe merge; fixture tests; architecture; comparison with local agent orchestrators; and non-goals. State plainly that Codex scripted follow-up is unavailable and Jules API is alpha.

`NOTICE` names studied upstream projects and says no source code was copied unless a later notice says otherwise. `SECURITY.md` directs private reports through GitHub Security Advisories and documents credential boundaries. `CONTRIBUTING.md` requires tests, no real-account CI, and license-compatible contributions.

CI runs on `ubuntu-latest` and `macos-latest` with Node 22, executes `npm ci`, `npm run verify`, and `npm pack --dry-run`. Set workflow permissions to `contents: read`.

- [ ] **Step 4: Run complete release verification and inspect the tarball**

Run: `npm run verify`

Run: `npm pack --dry-run`

Run: `node dist/cli.js --help`

Run: `git diff --check`

Expected: zero test failures, zero type errors, successful build, tarball contains only intended release files, help exits zero, and no whitespace errors.

- [ ] **Step 5: Commit the release-ready surface**

Commit: `docs: prepare Relay Madness for release`

---

## Final branch verification

- [ ] Run `npm ci` from a clean dependency state.
- [ ] Run `npm run verify` and record the exact passing test count.
- [ ] Run `npm pack --dry-run` and inspect every packaged path.
- [ ] Run `node dist/cli.js doctor --json` and verify failures are reported independently without secrets.
- [ ] Run an MCP STDIO list-tools smoke test against `node dist/cli.js mcp`.
- [ ] Run `git diff --check` and `git status --short`.
- [ ] Compare the complete branch diff to the design acceptance criteria.
- [ ] Push `agent/full-build`, open a draft pull request, and verify GitHub Actions.
