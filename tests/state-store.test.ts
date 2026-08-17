import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, test } from 'node:test';

import Database from 'better-sqlite3';

import { RelayError } from '../src/errors.js';
import { StateStore } from '../src/state-store.js';

const temporaryRoots: string[] = [];

function databasePath(): string {
  const root = mkdtempSync(join(tmpdir(), 'relay-state-test-'));
  temporaryRoots.push(root);
  return join(root, 'state', 'relay.db');
}

function openStore(): StateStore {
  return StateStore.open(databasePath());
}

function createPopulatedV3Database(): string {
  const path = databasePath();
  mkdirSync(dirname(path), { recursive: true });
  const database = new Database(path);
  database.pragma('foreign_keys = ON');
  database.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
    INSERT INTO schema_migrations (version, applied_at) VALUES
      (1, '2026-08-16T00:00:00.000Z'),
      (2, '2026-08-16T00:01:00.000Z'),
      (3, '2026-08-16T00:02:00.000Z');
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      repo TEXT NOT NULL UNIQUE,
      default_branch TEXT NOT NULL,
      locator_path TEXT NOT NULL,
      current_work_item_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE work_items (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      base_branch TEXT NOT NULL,
      current_branch TEXT,
      current_sha TEXT,
      pull_request INTEGER,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE provider_accounts (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      label TEXT NOT NULL,
      profile_path TEXT NOT NULL,
      status TEXT NOT NULL,
      max_concurrency INTEGER NOT NULL,
      is_default INTEGER NOT NULL,
      last_used_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE provider_sessions (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      provider_session_id TEXT NOT NULL,
      provider_url TEXT,
      status TEXT NOT NULL,
      branch TEXT,
      last_activity_at TEXT NOT NULL,
      UNIQUE (work_item_id, provider, provider_session_id)
    );
    CREATE TABLE provider_runs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES provider_sessions(id) ON DELETE CASCADE,
      work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      type TEXT NOT NULL,
      prompt TEXT,
      status TEXT NOT NULL,
      mutation_mode TEXT NOT NULL,
      correlation_id TEXT NOT NULL,
      origin_provider TEXT,
      delegation_depth INTEGER NOT NULL,
      parent_run_id TEXT REFERENCES provider_runs(id),
      started_at TEXT NOT NULL,
      finished_at TEXT,
      expected_branch TEXT,
      baseline_sha TEXT,
      pinned_sha TEXT
    );
    CREATE TABLE artifact_snapshots (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
      branch TEXT NOT NULL,
      sha TEXT NOT NULL,
      pull_request INTEGER,
      checks TEXT NOT NULL,
      mergeable INTEGER,
      review_decision TEXT,
      draft INTEGER,
      observed_at TEXT NOT NULL,
      verification_status TEXT NOT NULL DEFAULT 'published'
    );
  `);
  database.prepare(
    `INSERT INTO projects (
      id, repo, default_branch, locator_path, current_work_item_id, created_at, updated_at
    ) VALUES ('project-v3', 'acme/v3', 'main', '/tmp/v3', 'work-v3', '2026-08-16T00:00:00.000Z', '2026-08-16T00:00:00.000Z')`,
  ).run();
  database.prepare(
    `INSERT INTO work_items (
      id, project_id, title, base_branch, current_branch, status, created_at, updated_at
    ) VALUES ('work-v3', 'project-v3', 'Legacy work', 'main', 'relay/legacy', 'in_progress', '2026-08-16T00:00:00.000Z', '2026-08-16T00:00:00.000Z')`,
  ).run();
  database.prepare(
    `INSERT INTO provider_sessions (
      id, work_item_id, provider, provider_session_id, status, branch, last_activity_at
    ) VALUES ('session-v3', 'work-v3', 'claude', 'legacy-session', 'active', 'relay/legacy', '2026-08-16T00:00:00.000Z')`,
  ).run();
  database.prepare(
    `INSERT INTO provider_runs (
      id, session_id, work_item_id, provider, type, prompt, status, mutation_mode,
      correlation_id, delegation_depth, expected_branch, baseline_sha, pinned_sha, started_at
    ) VALUES (
      'run-v3', 'session-v3', 'work-v3', 'claude', 'delegation', 'legacy prompt',
      'running', 'read', 'correlation-v3', 0, 'relay/legacy', '${'a'.repeat(40)}',
      '${'a'.repeat(40)}', '2026-08-16T00:00:00.000Z'
    )`,
  ).run();
  database.close();
  return path;
}

function createPopulatedV4DatabaseWithRunBranch(): string {
  const path = createPopulatedV3Database();
  const database = new Database(path);
  database.exec(`
    ALTER TABLE provider_sessions ADD COLUMN account_id TEXT REFERENCES provider_accounts(id);
    ALTER TABLE provider_runs ADD COLUMN account_id TEXT REFERENCES provider_accounts(id);
    ALTER TABLE provider_runs ADD COLUMN model TEXT;
    ALTER TABLE provider_runs ADD COLUMN base_sha TEXT;
    ALTER TABLE provider_runs ADD COLUMN result_sha TEXT;
    INSERT INTO schema_migrations (version, applied_at)
      VALUES (4, '2026-08-16T00:03:00.000Z');
    UPDATE work_items
      SET current_branch = 'relay/run/work-v3/legacy-run',
          current_sha = '${'c'.repeat(40)}',
          pull_request = 143
      WHERE id = 'work-v3';
  `);
  database.close();
  return path;
}

function createPopulatedV4DatabaseWithNullBranch(): string {
  const path = createPopulatedV4DatabaseWithRunBranch();
  const database = new Database(path);
  database
    .prepare(
      `UPDATE work_items
       SET current_branch = NULL, current_sha = NULL, pull_request = NULL
       WHERE id = 'work-v3'`,
    )
    .run();
  database.close();
  return path;
}

function storeWithAccount(
  id: string,
  provider: 'claude' | 'codex' | 'jules',
  options: Partial<{
    label: string;
    maxConcurrency: number;
    status: 'ready' | 'disabled' | 'auth_required' | 'cooldown';
    isDefault: boolean;
  }> = {},
): StateStore {
  const store = openStore();
  store.upsertProviderAccount({
    id,
    provider,
    label: options.label ?? id,
    profilePath: `/profiles/${id}`,
    status: options.status ?? 'ready',
    maxConcurrency: options.maxConcurrency ?? 1,
    isDefault: options.isDefault ?? false,
  });
  return store;
}

function seed(store: StateStore) {
  const project = store.upsertProject({
    repo: 'acme/web',
    defaultBranch: 'main',
    locatorPath: '/tmp/web',
  });
  const workItem = store.createWorkItem({
    projectId: project.id,
    title: 'Passwordless auth',
    baseBranch: 'main',
    currentBranch: 'relay/passwordless-auth',
  });
  const session = store.upsertSession({
    workItemId: workItem.id,
    provider: 'claude',
    providerSessionId: 'session_1',
    status: 'active',
  });
  return { project, workItem, session };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test('persists a project, WorkItem, session, run, and artifact snapshot', () => {
  const store = openStore();
  const { workItem, session } = seed(store);
  const run = store.createRun({
    sessionId: session.id,
    provider: 'claude',
    type: 'delegation',
    prompt: 'Build it',
    mutationMode: 'write',
  });

  store.transitionRun(run.id, 'running');
  store.transitionRun(run.id, 'provider_complete');
  store.saveArtifact({
    workItemId: workItem.id,
    branch: 'relay/passwordless-auth',
    sha: 'a'.repeat(40),
    status: 'verified',
    pullRequest: 12,
    checks: 'passing',
    mergeable: true,
  });

  const status = store.getStatus(workItem.id);
  assert.equal(status.workItem.title, 'Passwordless auth');
  assert.equal(status.sessions[0]?.providerSessionId, 'session_1');
  assert.equal(status.runs[0]?.status, 'provider_complete');
  assert.equal(status.artifact?.sha, 'a'.repeat(40));
  assert.equal(status.artifact?.status, 'verified');
  store.close();
});

test('updates a project without creating a duplicate', () => {
  const store = openStore();
  const first = store.upsertProject({
    repo: 'acme/web',
    defaultBranch: 'main',
    locatorPath: '/tmp/first',
  });
  const second = store.upsertProject({
    repo: 'acme/web',
    defaultBranch: 'trunk',
    locatorPath: '/tmp/second',
  });

  assert.equal(second.id, first.id);
  assert.equal(second.defaultBranch, 'trunk');
  assert.equal(second.locatorPath, '/tmp/second');
  store.close();
});

test('allows one mutation lease and rejects a second owner', () => {
  const store = openStore();
  const { workItem, session } = seed(store);
  const otherSession = store.upsertSession({
    workItemId: workItem.id,
    provider: 'codex',
    providerSessionId: 'session_2',
    status: 'active',
  });
  const first = store.createRun({
    sessionId: session.id,
    provider: 'claude',
    type: 'delegation',
    prompt: 'first',
    mutationMode: 'write',
  });
  const second = store.createRun({
    sessionId: otherSession.id,
    provider: 'codex',
    type: 'delegation',
    prompt: 'second',
    mutationMode: 'write',
  });

  store.acquireMutationLease(
    workItem.id,
    first.id,
    new Date('2026-08-16T12:00:00Z'),
  );
  assert.throws(
    () =>
      store.acquireMutationLease(
        workItem.id,
        second.id,
        new Date('2026-08-16T12:00:01Z'),
      ),
    (error: unknown) =>
      error instanceof RelayError && error.code === 'work_item_locked',
  );
  store.close();
});

test('transfers a mutation lease between runs in the same provider session', () => {
  const store = openStore();
  const { workItem, session } = seed(store);
  const first = store.createRun({
    sessionId: session.id,
    provider: 'claude',
    type: 'delegation',
    prompt: 'first',
    mutationMode: 'write',
  });
  const second = store.createRun({
    sessionId: session.id,
    provider: 'claude',
    type: 'message',
    prompt: 'follow up',
    mutationMode: 'write',
  });

  store.acquireMutationLease(workItem.id, first.id);
  assert.doesNotThrow(() => store.acquireMutationLease(workItem.id, second.id));
  store.releaseMutationLease(workItem.id, second.id);
  store.close();
});

test('reclaims a mutation lease after its sixty-minute deadline', () => {
  const store = openStore();
  const { workItem, session } = seed(store);
  const first = store.createRun({
    sessionId: session.id,
    provider: 'claude',
    type: 'delegation',
    prompt: 'first',
    mutationMode: 'write',
  });
  const second = store.createRun({
    sessionId: session.id,
    provider: 'claude',
    type: 'delegation',
    prompt: 'second',
    mutationMode: 'write',
  });

  store.acquireMutationLease(
    workItem.id,
    first.id,
    new Date('2026-08-16T12:00:00Z'),
  );
  store.acquireMutationLease(
    workItem.id,
    second.id,
    new Date('2026-08-16T13:00:01Z'),
  );

  store.releaseMutationLease(workItem.id, second.id);
  store.close();
});

test('rejects invalid run transitions', () => {
  const store = openStore();
  const { session } = seed(store);
  const run = store.createRun({
    sessionId: session.id,
    provider: 'claude',
    type: 'delegation',
    prompt: 'Build it',
    mutationMode: 'write',
  });

  assert.throws(
    () => store.transitionRun(run.id, 'verified'),
    (error: unknown) =>
      error instanceof RelayError && error.code === 'invalid_run_transition',
  );
  store.close();
});

test('rejects a twenty-first run for one WorkItem', () => {
  const store = openStore();
  const { session } = seed(store);
  for (let index = 0; index < 20; index += 1) {
    store.createRun({
      sessionId: session.id,
      provider: 'claude',
      type: 'message',
      prompt: `message ${index}`,
      mutationMode: 'write',
    });
  }

  assert.throws(
    () =>
      store.createRun({
        sessionId: session.id,
        provider: 'claude',
        type: 'message',
        prompt: 'one too many',
        mutationMode: 'write',
      }),
    (error: unknown) =>
      error instanceof RelayError && error.code === 'run_budget_exceeded',
  );
  store.close();
});

test('atomically limits a WorkItem to three active readers', () => {
  const store = openStore();
  const { session } = seed(store);
  for (let index = 0; index < 3; index += 1) {
    store.createRun({
      sessionId: session.id,
      provider: 'claude',
      type: 'message',
      prompt: `reader ${index}`,
      mutationMode: 'read',
    });
  }

  assert.throws(
    () =>
      store.createRun({
        sessionId: session.id,
        provider: 'claude',
        type: 'message',
        prompt: 'fourth reader',
        mutationMode: 'read',
      }),
    (error: unknown) =>
      error instanceof RelayError && error.code === 'work_item_locked',
  );
  store.close();
});

test('round-trips run publication expectations', () => {
  const store = openStore();
  const { session } = seed(store);
  const run = store.createRun({
    sessionId: session.id,
    provider: 'claude',
    type: 'delegation',
    mutationMode: 'write',
    expectedBranch: 'relay/passwordless-auth',
    baselineSha: 'a'.repeat(40),
    pinnedSha: 'b'.repeat(40),
  });

  assert.equal(run.expectedBranch, 'relay/passwordless-auth');
  assert.equal(run.baselineSha, 'a'.repeat(40));
  assert.equal(run.pinnedSha, 'b'.repeat(40));
  store.close();
});

test('persists one immutable ready candidate from a complete write run', () => {
  const store = openStore();
  const { workItem, session } = seed(store);
  const run = store.createRun({
    id: 'candidate-run',
    sessionId: session.id,
    provider: 'claude',
    type: 'delegation',
    mutationMode: 'write',
    expectedBranch: 'relay/run/work-1/candidate-run',
    baseSha: 'a'.repeat(40),
    resultSha: 'b'.repeat(40),
  });

  const candidate = store.createCandidateForRun(run.id);
  store.setRunResultSha(run.id, 'c'.repeat(40));
  const repeated = store.createCandidateForRun(run.id);

  assert.equal(candidate?.id, run.id);
  assert.equal(candidate?.runId, run.id);
  assert.equal(candidate?.workItemId, workItem.id);
  assert.equal(candidate?.status, 'ready');
  assert.equal(candidate?.sourceBranch, 'relay/run/work-1/candidate-run');
  assert.equal(candidate?.sourceSha, 'b'.repeat(40));
  assert.equal(candidate?.baseSha, 'a'.repeat(40));
  assert.equal(candidate?.integrationBranch, workItem.integrationBranch);
  assert.deepEqual(candidate?.conflictFiles, []);
  assert.equal(repeated?.sourceSha, 'b'.repeat(40));
  assert.equal(store.getCandidate(run.id)?.sourceSha, 'b'.repeat(40));
  store.close();
});

test('reserves a dedicated integration branch for a read-first WorkItem', () => {
  const store = openStore();
  const project = store.upsertProject({
    repo: 'acme/read-first',
    defaultBranch: 'main',
    locatorPath: '/tmp/read-first',
  });

  const workItem = store.createWorkItem({
    id: 'read-first-work',
    projectId: project.id,
    title: 'Read first',
    baseBranch: 'main',
    currentBranch: 'main',
  });

  assert.equal(workItem.currentBranch, 'main');
  assert.match(workItem.integrationBranch, /^relay\/work\//);
  assert.notEqual(workItem.integrationBranch, workItem.baseBranch);
  assert.equal(workItem.integrationBranch.startsWith('relay/run/'), false);
  store.close();
});

test('does not create candidates from messages, missing branches, or unchanged bases', () => {
  const store = openStore();
  const { session } = seed(store);
  const inputs = [
    {
      id: 'message-only',
      mutationMode: 'write' as const,
      prompt: `Published commit ${'b'.repeat(40)} in PR #123`,
      baseSha: 'a'.repeat(40),
    },
    {
      id: 'missing-branch',
      mutationMode: 'write' as const,
      baseSha: 'a'.repeat(40),
      resultSha: 'b'.repeat(40),
    },
    {
      id: 'unchanged',
      mutationMode: 'write' as const,
      expectedBranch: 'relay/run/work-1/unchanged',
      baseSha: 'a'.repeat(40),
      resultSha: 'a'.repeat(40),
    },
    {
      id: 'read-run',
      mutationMode: 'read' as const,
      expectedBranch: 'relay/run/work-1/read-run',
      baseSha: 'a'.repeat(40),
      resultSha: 'b'.repeat(40),
    },
  ];

  for (const input of inputs) {
    const run = store.createRun({
      sessionId: session.id,
      provider: 'claude',
      type: 'message',
      ...input,
    });
    assert.equal(store.createCandidateForRun(run.id), undefined);
  }
  store.close();
});

test('allows only one landing lease per WorkItem and reclaims it after sixty minutes', () => {
  const store = openStore();
  const { workItem, session } = seed(store);
  const first = store.createRun({
    id: 'landing-a',
    sessionId: session.id,
    provider: 'claude',
    type: 'delegation',
    mutationMode: 'write',
  });
  const second = store.createRun({
    id: 'landing-b',
    sessionId: session.id,
    provider: 'claude',
    type: 'delegation',
    mutationMode: 'write',
  });

  store.acquireLandingLease(
    workItem.id,
    first.id,
    new Date('2026-08-16T12:00:00Z'),
  );
  assert.throws(
    () =>
      store.acquireLandingLease(
        workItem.id,
        second.id,
        new Date('2026-08-16T12:00:01Z'),
      ),
    (error: unknown) =>
      error instanceof RelayError && error.code === 'work_item_locked',
  );
  assert.doesNotThrow(() =>
    store.acquireLandingLease(
      workItem.id,
      second.id,
      new Date('2026-08-16T13:00:01Z'),
    ),
  );
  store.releaseLandingLease(workItem.id, second.id);
  store.close();
});

test('prefers an existing active session over newer pending or failed attempts', () => {
  const store = openStore();
  const { workItem, session } = seed(store);
  store.upsertSession({
    workItemId: workItem.id,
    provider: 'claude',
    providerSessionId: 'pending:replacement',
    status: 'pending',
  });
  store.upsertSession({
    workItemId: workItem.id,
    provider: 'claude',
    providerSessionId: 'failed-replacement',
    status: 'failed',
  });

  assert.equal(store.getSession(workItem.id, 'claude')?.id, session.id);
  store.close();
});

test('applies ordered schema migrations', () => {
  const path = databasePath();
  const store = StateStore.open(path);
  store.close();
  const database = new Database(path, { readonly: true });
  const versions = database
    .prepare('SELECT version FROM schema_migrations ORDER BY version')
    .all() as Array<{ version: number }>;
  const runColumns = database.pragma('table_info(provider_runs)') as Array<{
    name: string;
  }>;
  const artifactColumns = database.pragma(
    'table_info(artifact_snapshots)',
  ) as Array<{ name: string }>;
  const candidateColumns = database.pragma('table_info(candidates)') as Array<{
    name: string;
  }>;
  const landingLeaseColumns = database.pragma(
    'table_info(landing_leases)',
  ) as Array<{ name: string }>;
  database.close();

  assert.deepEqual(
    versions.map(({ version }) => version),
    [1, 2, 3, 4, 5, 6],
  );
  assert.ok(runColumns.some(({ name }) => name === 'baseline_sha'));
  assert.ok(runColumns.some(({ name }) => name === 'account_id'));
  assert.ok(runColumns.some(({ name }) => name === 'model'));
  assert.ok(runColumns.some(({ name }) => name === 'base_sha'));
  assert.ok(runColumns.some(({ name }) => name === 'result_sha'));
  assert.ok(
    artifactColumns.some(({ name }) => name === 'verification_status'),
  );
  assert.ok(candidateColumns.some(({ name }) => name === 'integration_base_sha'));
  assert.ok(candidateColumns.some(({ name }) => name === 'integration_branch'));
  assert.ok(
    candidateColumns.some(({ name }) => name === 'integration_ref_existed'),
  );
  assert.ok(candidateColumns.some(({ name }) => name === 'conflict_paths_json'));
  assert.ok(landingLeaseColumns.some(({ name }) => name === 'expires_at'));
});

test('migrates a version-four relay run branch without retaining its SHA or PR', () => {
  const store = StateStore.open(createPopulatedV4DatabaseWithRunBranch());

  const workItem = store.getWorkItem('work-v3');
  assert.match(workItem.integrationBranch, /^relay\/work\//);
  assert.equal(workItem.integrationBranch.startsWith('relay/run/'), false);
  assert.notEqual(workItem.integrationBranch, workItem.baseBranch);
  assert.equal(workItem.currentBranch, workItem.integrationBranch);
  assert.equal(workItem.currentSha, undefined);
  assert.equal(workItem.pullRequest, undefined);
  store.close();
});

test('preserves a null legacy current branch while backfilling integration', () => {
  const store = StateStore.open(createPopulatedV4DatabaseWithNullBranch());

  const workItem = store.getWorkItem('work-v3');
  assert.match(workItem.integrationBranch, /^relay\/work\//);
  assert.notEqual(workItem.integrationBranch, workItem.baseBranch);
  assert.equal(workItem.currentBranch, undefined);
  assert.equal(workItem.currentSha, undefined);
  assert.equal(workItem.pullRequest, undefined);
  store.close();
});

test('migrates a populated version-three database without deleting legacy runs', () => {
  const store = StateStore.open(createPopulatedV3Database());

  const status = store.getStatus('work-v3');
  assert.equal(store.getProject('project-v3').currentWorkItemId, 'work-v3');
  assert.equal(status.sessions[0]?.id, 'session-v3');
  assert.equal(status.sessions[0]?.accountId, undefined);
  assert.equal(status.runs[0]?.id, 'run-v3');
  assert.equal(status.runs[0]?.sessionId, 'session-v3');
  assert.equal(status.runs[0]?.accountId, undefined);
  assert.equal(status.runs[0]?.model, undefined);
  assert.equal(status.runs[0]?.baseSha, undefined);
  assert.equal(status.runs[0]?.resultSha, undefined);
  store.close();
});

test('stores only a provider profile reference and selects one explicit default', () => {
  const store = openStore();
  store.upsertProviderAccount({
    id: 'codex-a',
    provider: 'codex',
    label: 'Primary',
    profilePath: '/profiles/codex-a',
    status: 'ready',
    maxConcurrency: 1,
    isDefault: true,
  });
  store.upsertProviderAccount({
    id: 'codex-b',
    provider: 'codex',
    label: 'Spare',
    profilePath: '/profiles/codex-b',
    status: 'ready',
    maxConcurrency: 2,
    isDefault: true,
  });

  const account = store.getProviderAccount('codex-a');
  assert.equal(account?.profilePath, '/profiles/codex-a');
  assert.equal(store.getDefaultProviderAccount('codex')?.id, 'codex-b');
  assert.equal(
    store.listProviderAccounts('codex').filter((item) => item.isDefault).length,
    1,
  );
  store.close();
});

test('keeps identical provider session IDs isolated by account', () => {
  const store = openStore();
  const { project } = seed(store);
  const workItem = store.getCurrentWorkItem(project.id)!;
  store.upsertProviderAccount({
    id: 'claude-a',
    provider: 'claude',
    label: 'Claude A',
    profilePath: '/profiles/claude-a',
    status: 'ready',
    maxConcurrency: 1,
    isDefault: false,
  });
  store.upsertProviderAccount({
    id: 'claude-b',
    provider: 'claude',
    label: 'Claude B',
    profilePath: '/profiles/claude-b',
    status: 'ready',
    maxConcurrency: 1,
    isDefault: false,
  });

  const first = store.upsertSession({
    workItemId: workItem.id,
    provider: 'claude',
    accountId: 'claude-a',
    providerSessionId: 'shared-session',
    status: 'active',
  });
  const second = store.upsertSession({
    workItemId: workItem.id,
    provider: 'claude',
    accountId: 'claude-b',
    providerSessionId: 'shared-session',
    status: 'active',
  });

  assert.notEqual(first.id, second.id);
  assert.equal(
    store.getSession(workItem.id, 'claude', 'claude-a')?.id,
    first.id,
  );
  assert.equal(
    store.getSession(workItem.id, 'claude', 'claude-b')?.id,
    second.id,
  );
  store.close();
});

test('returns the latest weekly usage independently for each model bucket', () => {
  const store = storeWithAccount('claude-a', 'claude');
  store.recordUsageSnapshot({
    accountId: 'claude-a',
    period: 'weekly',
    model: 'opus',
    remainingPercent: 35,
    resetsAt: '2026-08-20T00:00:00.000Z',
    source: 'manual',
    observedAt: '2026-08-16T10:00:00.000Z',
  });
  store.recordUsageSnapshot({
    accountId: 'claude-a',
    period: 'weekly',
    model: 'sonnet',
    remainingPercent: 80,
    resetsAt: '2026-08-20T00:00:00.000Z',
    source: 'provider',
    observedAt: '2026-08-16T10:30:00.000Z',
  });
  store.recordUsageSnapshot({
    accountId: 'claude-a',
    period: 'weekly',
    model: 'opus',
    remainingPercent: 28,
    resetsAt: '2026-08-20T00:00:00.000Z',
    source: 'manual',
    observedAt: '2026-08-16T11:00:00.000Z',
  });

  assert.deepEqual(
    store
      .listLatestUsage('claude-a')
      .map(({ model, remainingPercent }) => ({ model, remainingPercent })),
    [
      { model: 'opus', remainingPercent: 28 },
      { model: 'sonnet', remainingPercent: 80 },
    ],
  );
  store.close();
});

test('accepts weekly usage boundaries and rejects invalid percentages or reset times', () => {
  const store = storeWithAccount('claude-a', 'claude');
  store.recordUsageSnapshot({
    accountId: 'claude-a',
    period: 'weekly',
    model: 'opus',
    remainingPercent: 0,
    source: 'manual',
    observedAt: '2026-08-16T10:00:00.000Z',
  });
  store.recordUsageSnapshot({
    accountId: 'claude-a',
    period: 'weekly',
    model: 'sonnet',
    remainingPercent: 100,
    resetsAt: '2026-08-20T00:00:00.000Z',
    source: 'manual',
    observedAt: '2026-08-16T10:00:00.000Z',
  });

  for (const remainingPercent of [-1, 101]) {
    assert.throws(
      () =>
        store.recordUsageSnapshot({
          accountId: 'claude-a',
          period: 'weekly',
          model: 'haiku',
          remainingPercent,
          source: 'manual',
          observedAt: '2026-08-16T10:00:00.000Z',
        }),
      (error: unknown) =>
        error instanceof RelayError && error.code === 'invalid_argument',
    );
  }
  assert.throws(
    () =>
      store.recordUsageSnapshot({
        accountId: 'claude-a',
        period: 'weekly',
        model: 'haiku',
        remainingPercent: 50,
        resetsAt: 'not-an-iso-time',
        source: 'manual',
        observedAt: '2026-08-16T10:00:00.000Z',
      }),
    (error: unknown) =>
      error instanceof RelayError && error.code === 'invalid_argument',
  );
  store.close();
});

test('enforces account capacity transactionally and reclaims stale leases', () => {
  const store = storeWithAccount('codex-a', 'codex', { maxConcurrency: 1 });
  store.acquireAccountLease('codex-a', 'run-a', new Date('2026-08-16T10:00:00Z'));
  assert.throws(
    () => store.acquireAccountLease('codex-a', 'run-b', new Date('2026-08-16T10:00:01Z')),
    (error: unknown) =>
      error instanceof RelayError && error.code === 'account_at_capacity',
  );

  const replacement = store.acquireAccountLease(
    'codex-a',
    'run-b',
    new Date('2026-08-16T11:00:01Z'),
  );
  assert.equal(replacement.runId, 'run-b');
  store.releaseAccountLease('codex-a', 'run-b');
  store.close();
});

test('does not acquire leases from disabled or authentication-required accounts', () => {
  for (const status of ['disabled', 'auth_required'] as const) {
    const store = storeWithAccount(`codex-${status}`, 'codex', { status });
    assert.throws(
      () => store.acquireAccountLease(`codex-${status}`, 'run-a'),
      (error: unknown) =>
        error instanceof RelayError && error.code === 'account_unavailable',
    );
    store.close();
  }
});

test('rejects changing an account to a different provider', () => {
  const store = storeWithAccount('codex-a', 'codex');
  assert.throws(
    () =>
      store.upsertProviderAccount({
        id: 'codex-a',
        provider: 'claude',
        label: 'Wrong provider',
        profilePath: '/profiles/codex-a',
        status: 'ready',
        maxConcurrency: 1,
        isDefault: false,
      }),
    (error: unknown) =>
      error instanceof RelayError && error.code === 'provider_mismatch',
  );
  store.close();
});

test('stores project configuration by account and rejects credentials', () => {
  const store = openStore();
  const { project } = seed(store);
  store.upsertProviderAccount({
    id: 'claude-a',
    provider: 'claude',
    label: 'Claude',
    profilePath: '/profiles/claude-a',
    status: 'ready',
    maxConcurrency: 1,
    isDefault: false,
  });
  store.upsertProviderAccount({
    id: 'claude-b',
    provider: 'claude',
    label: 'Claude spare',
    profilePath: '/profiles/claude-b',
    status: 'ready',
    maxConcurrency: 1,
    isDefault: false,
  });
  store.setProviderAccountConfig(project.id, 'claude-a', { model: 'opus' });
  store.setProviderAccountConfig(project.id, 'claude-b', { model: 'sonnet' });

  assert.deepEqual(store.getProviderAccountConfig(project.id, 'claude-a'), {
    model: 'opus',
  });
  assert.deepEqual(store.getProviderAccountConfig(project.id, 'claude-b'), {
    model: 'sonnet',
  });
  assert.throws(
    () =>
      store.setProviderAccountConfig(project.id, 'claude-a', {
        credentialReference: 'not-allowed',
      }),
    (error: unknown) =>
      error instanceof RelayError && error.code === 'invalid_argument',
  );
  store.close();
});

test('rejects credential carrier key segments without persisting either configuration', () => {
  const store = openStore();
  const { project } = seed(store);
  store.upsertProviderAccount({
    id: 'codex-a',
    provider: 'codex',
    label: 'Codex',
    profilePath: '/profiles/codex-a',
    status: 'ready',
    maxConcurrency: 1,
    isDefault: false,
  });

  const sensitiveSettings: ReadonlyArray<Readonly<Record<string, unknown>>> = [
    { environment: { SESSION: 'do-not-store' } },
    { env: { SESSION: 'do-not-store' } },
    { cookie: 'do-not-store' },
    { cookies: 'do-not-store' },
    { keychain: 'do-not-store' },
    { accessToken: 'do-not-store' },
    { apiKey: 'do-not-store' },
    { 'api-key': 'do-not-store' },
    { apiKeys: 'do-not-store' },
    { apikey: 'do-not-store' },
    { accesskey: 'do-not-store' },
    { accesstoken: 'do-not-store' },
    { credentialReference: 'do-not-store' },
  ];

  for (const settings of sensitiveSettings) {
    assert.throws(
      () => store.setProviderAccountConfig(project.id, 'codex-a', settings),
      (error: unknown) =>
        error instanceof RelayError && error.code === 'invalid_argument',
    );
    assert.equal(store.getProviderAccountConfig(project.id, 'codex-a'), undefined);

    assert.throws(
      () => store.setProviderConfig(project.id, 'codex', settings),
      (error: unknown) =>
        error instanceof RelayError && error.code === 'invalid_argument',
    );
    assert.equal(store.getProviderConfig(project.id, 'codex'), undefined);
  }

  store.setProviderAccountConfig(project.id, 'codex-a', {
    environmentId: 'env_123',
    monkey: 'safe',
  });
  assert.deepEqual(store.getProviderAccountConfig(project.id, 'codex-a'), {
    environmentId: 'env_123',
    monkey: 'safe',
  });
  store.close();
});

test('rejects provider settings that look like credentials', () => {
  const store = openStore();
  const { project } = seed(store);

  assert.throws(
    () => store.setProviderConfig(project.id, 'jules', { apiKey: 'secret' }),
    (error: unknown) =>
      error instanceof RelayError && error.code === 'invalid_argument',
  );
  store.close();
});

test('creates the database and parent directory with user-only permissions', () => {
  const path = databasePath();
  const store = StateStore.open(path);
  store.close();

  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(dirname(path)).mode & 0o777, 0o700);
});

test('does not change permissions on an existing caller-owned directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'relay-existing-parent-'));
  temporaryRoots.push(root);
  chmodSync(root, 0o755);

  const store = StateStore.open(join(root, 'relay.db'));
  store.close();

  assert.equal(statSync(root).mode & 0o777, 0o755);
});
