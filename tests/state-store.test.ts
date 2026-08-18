import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, test } from 'node:test';

import Database from 'better-sqlite3';

import { RelayError } from '../src/errors.js';
import type { ProviderName } from '../src/provider.js';
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

function createMalformedV6Database(): string {
  const path = databasePath();
  const store = StateStore.open(path);
  const project = store.upsertProject({
    repo: 'acme/malformed-v6',
    defaultBranch: 'develop',
    locatorPath: '/tmp/malformed-v6',
  });
  const workItem = store.createWorkItem({
    id: 'work-v6',
    projectId: project.id,
    title: 'Malformed integration',
    baseBranch: 'develop',
    currentBranch: 'develop',
  });
  store.close();

  const database = new Database(path);
  database
    .prepare('UPDATE work_items SET integration_branch = ? WHERE id = ?')
    .run('main', workItem.id);
  database.prepare('DELETE FROM schema_migrations WHERE version = ?').run(7);
  database.close();
  return path;
}

function storeWithAccount(
  id: string,
  provider: 'claude' | 'codex',
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

function activeRunForAccount(
  store: StateStore,
  input: {
    accountId: string;
    provider: 'claude' | 'codex';
    id?: string;
    providerSessionId?: string;
    sessionStatus?: 'pending' | 'active';
  },
) {
  const project = store.upsertProject({
    repo: `acme/${input.accountId}-${input.id ?? 'run'}`,
    defaultBranch: 'main',
    locatorPath: '/tmp/account-run',
  });
  const workItem = store.createWorkItem({
    projectId: project.id,
    title: 'Account run',
    baseBranch: 'main',
  });
  const session = store.upsertSession({
    workItemId: workItem.id,
    provider: input.provider,
    accountId: input.accountId,
    providerSessionId: input.providerSessionId ?? `session-${input.id ?? input.accountId}`,
    status: input.sessionStatus ?? 'active',
  });
  const run = store.createRun({
    ...(input.id === undefined ? {} : { id: input.id }),
    sessionId: session.id,
    provider: input.provider,
    accountId: input.accountId,
    type: 'delegation',
    mutationMode: 'write',
  });
  return { workItem, session, run: store.transitionRun(run.id, 'running') };
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

test('pins one WorkItem skill source and persists immutable session and run skills', () => {
  const store = openStore();
  const { workItem } = seed(store);
  const sourceSha = 'a'.repeat(40);
  const skills = [
    {
      name: 'review-security',
      path: '.agents/skills/review-security',
      sourceSha,
      treeSha: 'b'.repeat(40),
    },
  ] as const;

  assert.equal(store.getWorkItem(workItem.id).skillSourceSha, undefined);
  assert.equal(
    store.pinWorkItemSkillSource(workItem.id, sourceSha).skillSourceSha,
    sourceSha,
  );
  assert.equal(
    store.pinWorkItemSkillSource(workItem.id, sourceSha).skillSourceSha,
    sourceSha,
  );
  assert.throws(
    () => store.pinWorkItemSkillSource(workItem.id, 'c'.repeat(40)),
    (error: unknown) =>
      error instanceof RelayError && error.code === 'state_conflict',
  );

  const session = store.upsertSession({
    workItemId: workItem.id,
    provider: 'codex',
    providerSessionId: 'skill-session',
    status: 'active',
    skills,
  });
  assert.deepEqual(session.skills, skills);
  assert.deepEqual(
    store.upsertSession({
      workItemId: workItem.id,
      provider: 'codex',
      providerSessionId: 'skill-session',
      status: 'complete',
    }).skills,
    skills,
  );
  assert.throws(
    () =>
      store.upsertSession({
        workItemId: workItem.id,
        provider: 'codex',
        providerSessionId: 'skill-session',
        status: 'complete',
        skills: [
          {
            name: 'write-tests',
            path: '.agents/skills/write-tests',
            sourceSha,
            treeSha: 'd'.repeat(40),
          },
        ],
      }),
    (error: unknown) =>
      error instanceof RelayError && error.code === 'state_conflict',
  );

  const run = store.createRun({
    sessionId: session.id,
    provider: 'codex',
    type: 'delegation',
    mutationMode: 'read',
  });
  assert.deepEqual(run.skills, skills);
  assert.deepEqual(store.getStatus(workItem.id).runs[0]?.skills, skills);
  store.close();
});

test('fails closed when stored skill coordinates are corrupt', () => {
  const path = databasePath();
  const store = StateStore.open(path);
  const { session } = seed(store);
  store.close();

  const database = new Database(path);
  database
    .prepare('UPDATE provider_sessions SET skills_json = ? WHERE id = ?')
    .run('{broken-json', session.id);
  database.close();

  const reopened = StateStore.open(path);
  assert.throws(
    () => reopened.getSession(session.workItemId, 'claude'),
    (error: unknown) =>
      error instanceof RelayError && error.code === 'state_conflict',
  );
  reopened.close();
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
    notnull: number;
    dflt_value: string | null;
  }>;
  const workItemColumns = database.pragma('table_info(work_items)') as Array<{
    name: string;
  }>;
  const sessionColumns = database.pragma(
    'table_info(provider_sessions)',
  ) as Array<{ name: string; notnull: number; dflt_value: string | null }>;
  const artifactColumns = database.pragma(
    'table_info(artifact_snapshots)',
  ) as Array<{ name: string }>;
  const candidateColumns = database.pragma('table_info(candidates)') as Array<{
    name: string;
  }>;
  const landingLeaseColumns = database.pragma(
    'table_info(landing_leases)',
  ) as Array<{ name: string }>;
  const accountColumns = database.pragma(
    'table_info(provider_accounts)',
  ) as Array<{ name: string }>;
  const accountLeaseForeignKeys = database.pragma(
    'foreign_key_list(account_leases)',
  ) as Array<{ table: string; from: string }>;
  const indexes = database
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'index' AND name LIKE 'relay_%'
       ORDER BY name`,
    )
    .all() as Array<{ name: string }>;
  database.close();

  assert.deepEqual(
    versions.map(({ version }) => version),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  );
  assert.deepEqual(
    indexes.map(({ name }) => name),
    [
      'relay_account_profile_identity',
      'relay_account_usage_latest',
      'relay_active_session_scope',
      'relay_remote_session_identity',
    ],
  );
  assert.ok(
    workItemColumns.some(({ name }) => name === 'skill_source_sha'),
  );
  assert.ok(accountColumns.some(({ name }) => name === 'auth_fingerprint'));
  assert.ok(accountColumns.some(({ name }) => name === 'auth_verified_at'));
  assert.ok(
    sessionColumns.some(
      ({ name, notnull, dflt_value: defaultValue }) =>
        name === 'skills_json' && notnull === 1 && defaultValue === "'[]'",
    ),
  );
  assert.ok(
    runColumns.some(
      ({ name, notnull, dflt_value: defaultValue }) =>
        name === 'skills_json' && notnull === 1 && defaultValue === "'[]'",
    ),
  );
  assert.ok(runColumns.some(({ name }) => name === 'baseline_sha'));
  assert.ok(runColumns.some(({ name }) => name === 'account_id'));
  assert.ok(runColumns.some(({ name }) => name === 'model'));
  assert.ok(runColumns.some(({ name }) => name === 'base_sha'));
  assert.ok(runColumns.some(({ name }) => name === 'result_sha'));
  assert.ok(runColumns.some(({ name }) => name === 'launch_attempt_id'));
  assert.ok(runColumns.some(({ name }) => name === 'launch_state'));
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
  assert.ok(
    accountLeaseForeignKeys.some(
      ({ table, from }) => table === 'provider_runs' && from === 'run_id',
    ),
  );
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

test('repairs a malformed legacy integration branch that points at main', () => {
  const store = StateStore.open(createMalformedV6Database());

  const workItem = store.getWorkItem('work-v6');
  assert.equal(workItem.baseBranch, 'develop');
  assert.match(workItem.integrationBranch, /^relay\/work\//);
  assert.notEqual(workItem.integrationBranch, 'main');
  store.close();
});

test('migrates a populated version-three database without deleting legacy runs', () => {
  const store = StateStore.open(createPopulatedV3Database());

  const status = store.getStatus('work-v3');
  assert.equal(store.getProject('project-v3').currentWorkItemId, 'work-v3');
  assert.equal(status.sessions[0]?.id, 'session-v3');
  assert.equal(status.sessions[0]?.accountId, undefined);
  assert.deepEqual(status.sessions[0]?.skills, []);
  assert.equal(status.runs[0]?.id, 'run-v3');
  assert.equal(status.runs[0]?.sessionId, 'session-v3');
  assert.equal(status.runs[0]?.accountId, undefined);
  assert.equal(status.runs[0]?.model, undefined);
  assert.equal(status.runs[0]?.baseSha, undefined);
  assert.equal(status.runs[0]?.resultSha, undefined);
  assert.deepEqual(status.runs[0]?.skills, []);
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

test('binds an opaque native identity and marks the provider account ready', () => {
  const store = openStore();
  store.upsertProviderAccount({
    id: 'claude-a',
    provider: 'claude',
    label: 'Primary',
    profilePath: '/profiles/claude-a',
    status: 'auth_required',
    maxConcurrency: 1,
    isDefault: true,
  });

  const account = store.bindProviderAccountAuth(
    'claude-a',
    'a'.repeat(64),
    new Date('2026-08-18T05:00:00.000Z'),
  );

  assert.equal(account.status, 'ready');
  assert.equal(account.authFingerprint, 'a'.repeat(64));
  assert.equal(account.authVerifiedAt, '2026-08-18T05:00:00.000Z');
  store.close();
});

test('clears a bound identity when its provider profile path changes', () => {
  const store = openStore();
  store.upsertProviderAccount({
    id: 'claude-a',
    provider: 'claude',
    label: 'Primary',
    profilePath: '/profiles/claude-a',
    status: 'auth_required',
    maxConcurrency: 1,
    isDefault: true,
  });
  store.bindProviderAccountAuth('claude-a', 'a'.repeat(64));

  store.upsertProviderAccount({
    id: 'claude-a',
    provider: 'claude',
    label: 'Replacement',
    profilePath: '/profiles/claude-replacement',
    status: 'auth_required',
    maxConcurrency: 1,
    isDefault: true,
  });

  const account = store.getProviderAccount('claude-a');
  assert.equal(account?.authFingerprint, undefined);
  assert.equal(account?.authVerifiedAt, undefined);
  store.close();
});

test('rejects two logical accounts that share one provider profile', () => {
  const store = openStore();
  store.upsertProviderAccount({
    id: 'codex-a',
    provider: 'codex',
    label: 'Primary',
    profilePath: '/profiles/shared-codex',
    status: 'ready',
    maxConcurrency: 1,
    isDefault: false,
  });

  assert.throws(
    () =>
      store.upsertProviderAccount({
        id: 'codex-b',
        provider: 'codex',
        label: 'Duplicate',
        profilePath: '/profiles/shared-codex',
        status: 'ready',
        maxConcurrency: 1,
        isDefault: false,
      }),
    (error: unknown) =>
      error instanceof RelayError && error.code === 'state_conflict',
  );
  assert.equal(store.getProviderAccount('codex-b'), undefined);
  store.close();
});

test('rejects relative provider profile references', () => {
  const store = openStore();

  assert.throws(
    () =>
      store.upsertProviderAccount({
        id: 'codex-relative',
        provider: 'codex',
        label: 'Relative',
        profilePath: 'profiles/codex-relative',
        status: 'ready',
        maxConcurrency: 1,
        isDefault: false,
      }),
    (error: unknown) =>
      error instanceof RelayError && error.code === 'invalid_argument',
  );
  assert.equal(store.getProviderAccount('codex-relative'), undefined);
  store.close();
});

test('normalizes an absolute provider profile before identity checks', () => {
  const store = openStore();
  store.upsertProviderAccount({
    id: 'claude-a',
    provider: 'claude',
    label: 'Primary',
    profilePath: '/profiles/team/../claude-a',
    status: 'ready',
    maxConcurrency: 1,
    isDefault: false,
  });

  assert.equal(
    store.getProviderAccount('claude-a')?.profilePath,
    '/profiles/claude-a',
  );
  assert.throws(
    () =>
      store.upsertProviderAccount({
        id: 'claude-b',
        provider: 'claude',
        label: 'Alias',
        profilePath: '/profiles/claude-a',
        status: 'ready',
        maxConcurrency: 1,
        isDefault: false,
      }),
    (error: unknown) =>
      error instanceof RelayError && error.code === 'state_conflict',
  );
  store.close();
});

test('rejects accounts for providers outside the supported contract', () => {
  const store = openStore();

  assert.throws(
    () =>
      store.upsertProviderAccount({
        id: 'unsupported-a',
        provider: 'jules' as ProviderName,
        label: 'Unsupported',
        profilePath: '/profiles/unsupported-a',
        status: 'ready',
        maxConcurrency: 1,
        isDefault: false,
      }),
    (error: unknown) =>
      error instanceof RelayError && error.code === 'invalid_argument',
  );
  assert.equal(store.getProviderAccount('unsupported-a'), undefined);
  store.close();
});

test('rejects project configuration for providers outside the supported contract', () => {
  const store = openStore();
  const { project } = seed(store);

  assert.throws(
    () =>
      store.setProviderConfig(project.id, 'jules' as ProviderName, {
        source: 'sources/github-acme-web',
      }),
    (error: unknown) =>
      error instanceof RelayError && error.code === 'invalid_argument',
  );
  assert.equal(
    store.getProviderConfig(project.id, 'jules' as ProviderName),
    undefined,
  );
  store.close();
});

test('rejects sessions for providers outside the supported contract', () => {
  const store = openStore();
  const { workItem } = seed(store);

  assert.throws(
    () =>
      store.upsertSession({
        workItemId: workItem.id,
        provider: 'jules' as ProviderName,
        providerSessionId: 'unsupported-session',
        status: 'active',
      }),
    (error: unknown) =>
      error instanceof RelayError && error.code === 'invalid_argument',
  );
  assert.equal(store.listSessions(workItem.id).length, 1);
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

test('rejects one remote session identity across different WorkItems', () => {
  const store = storeWithAccount('claude-a', 'claude');
  const firstProject = store.upsertProject({
    repo: 'acme/first-session-scope',
    defaultBranch: 'main',
    locatorPath: '/tmp/first-session-scope',
  });
  const secondProject = store.upsertProject({
    repo: 'acme/second-session-scope',
    defaultBranch: 'main',
    locatorPath: '/tmp/second-session-scope',
  });
  const firstWorkItem = store.createWorkItem({
    projectId: firstProject.id,
    title: 'First scope',
    baseBranch: 'main',
  });
  const secondWorkItem = store.createWorkItem({
    projectId: secondProject.id,
    title: 'Second scope',
    baseBranch: 'main',
  });
  store.upsertSession({
    workItemId: firstWorkItem.id,
    provider: 'claude',
    accountId: 'claude-a',
    providerSessionId: 'remote-session-1',
    status: 'active',
  });

  assert.throws(
    () =>
      store.upsertSession({
        workItemId: secondWorkItem.id,
        provider: 'claude',
        accountId: 'claude-a',
        providerSessionId: 'remote-session-1',
        status: 'active',
      }),
    (error: unknown) =>
      error instanceof RelayError && error.code === 'state_conflict',
  );
  assert.equal(store.listSessions(secondWorkItem.id).length, 0);
  store.close();
});

test('rejects activating a pending session with another WorkItems remote identity', () => {
  const store = storeWithAccount('claude-a', 'claude');
  const firstProject = store.upsertProject({
    repo: 'acme/active-session-owner',
    defaultBranch: 'main',
    locatorPath: '/tmp/active-session-owner',
  });
  const secondProject = store.upsertProject({
    repo: 'acme/pending-session-owner',
    defaultBranch: 'main',
    locatorPath: '/tmp/pending-session-owner',
  });
  const firstWorkItem = store.createWorkItem({
    projectId: firstProject.id,
    title: 'Active owner',
    baseBranch: 'main',
  });
  const secondWorkItem = store.createWorkItem({
    projectId: secondProject.id,
    title: 'Pending owner',
    baseBranch: 'main',
  });
  store.upsertSession({
    workItemId: firstWorkItem.id,
    provider: 'claude',
    accountId: 'claude-a',
    providerSessionId: 'remote-session-1',
    status: 'active',
  });
  const pending = store.upsertSession({
    workItemId: secondWorkItem.id,
    provider: 'claude',
    accountId: 'claude-a',
    providerSessionId: 'pending:second',
    status: 'pending',
  });

  assert.throws(
    () =>
      store.activateSession(pending.id, {
        providerSessionId: 'remote-session-1',
        status: 'active',
      }),
    (error: unknown) =>
      error instanceof RelayError && error.code === 'state_conflict',
  );
  assert.equal(
    store.getSession(secondWorkItem.id, 'claude', 'claude-a')?.status,
    'pending',
  );
  store.close();
});

test('round-trips one thousand isolated account sessions after reopening', () => {
  const path = databasePath();
  const store = StateStore.open(path);
  const project = store.upsertProject({
    repo: 'acme/thousand-account-fleet',
    defaultBranch: 'main',
    locatorPath: '/tmp/thousand-account-fleet',
  });
  const workItem = store.createWorkItem({
    projectId: project.id,
    title: 'Fleet routing proof',
    baseBranch: 'main',
  });

  for (let index = 0; index < 1_000; index += 1) {
    const suffix = index.toString().padStart(4, '0');
    const accountId = `codex-${suffix}`;
    store.upsertProviderAccount({
      id: accountId,
      provider: 'codex',
      label: `Codex ${suffix}`,
      profilePath: `/profiles/${accountId}`,
      status: 'ready',
      maxConcurrency: 1,
      isDefault: index === 0,
    });
    store.upsertSession({
      workItemId: workItem.id,
      provider: 'codex',
      accountId,
      providerSessionId: `remote-${suffix}`,
      status: 'active',
    });
  }

  assert.equal(store.listProviderAccounts('codex').length, 1_000);
  assert.equal(store.listSessions(workItem.id).length, 1_000);
  store.close();

  const reopened = StateStore.open(path);
  assert.equal(reopened.getDefaultProviderAccount('codex')?.id, 'codex-0000');
  assert.equal(
    reopened.getSession(workItem.id, 'codex', 'codex-0000')
      ?.providerSessionId,
    'remote-0000',
  );
  assert.equal(
    reopened.getSession(workItem.id, 'codex', 'codex-0999')
      ?.providerSessionId,
    'remote-0999',
  );
  const firstPage = reopened.listProviderAccountPage({
    provider: 'codex',
    status: 'ready',
    limit: 100,
  });
  assert.equal(firstPage.accounts.length, 100);
  assert.equal(firstPage.accounts[0]?.id, 'codex-0000');
  assert.equal(firstPage.accounts[99]?.id, 'codex-0099');
  assert.equal(firstPage.nextCursor, 'codex-0099');
  const secondPage = reopened.listProviderAccountPage({
    provider: 'codex',
    status: 'ready',
    limit: 100,
    cursor: firstPage.nextCursor,
  });
  assert.equal(secondPage.accounts[0]?.id, 'codex-0100');
  assert.equal(secondPage.accounts[99]?.id, 'codex-0199');
  assert.equal(secondPage.nextCursor, 'codex-0199');
  assert.equal(reopened.listProviderAccounts('codex').length, 1_000);
  assert.equal(reopened.listSessions(workItem.id).length, 1_000);
  reopened.close();
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
  const first = activeRunForAccount(store, { accountId: 'codex-a', provider: 'codex', id: 'run-a' });
  const second = activeRunForAccount(store, { accountId: 'codex-a', provider: 'codex', id: 'run-b' });
  store.acquireAccountLease('codex-a', first.run.id, new Date('2026-08-16T10:00:00Z'));
  assert.throws(
    () => store.acquireAccountLease('codex-a', second.run.id, new Date('2026-08-16T10:00:01Z')),
    (error: unknown) =>
      error instanceof RelayError && error.code === 'account_at_capacity',
  );

  const replacement = store.acquireAccountLease(
    'codex-a',
    second.run.id,
    new Date('2026-08-16T11:00:01Z'),
  );
  assert.equal(replacement.runId, 'run-b');
  store.releaseAccountLease('codex-a', second.run.id);
  store.close();
});

test('counts only unexpired account leases without reclaiming expired rows', () => {
  const path = databasePath();
  const store = StateStore.open(path);
  store.upsertProviderAccount({
    id: 'codex-a',
    provider: 'codex',
    label: 'Primary',
    profilePath: '/profiles/codex-a',
    status: 'ready',
    maxConcurrency: 1,
    isDefault: true,
  });
  const run = activeRunForAccount(store, { accountId: 'codex-a', provider: 'codex', id: 'run-a' });
  store.acquireAccountLease('codex-a', run.run.id, new Date('2026-08-16T10:00:00Z'));

  assert.equal(
    store.countActiveAccountLeases('codex-a', new Date('2026-08-16T11:00:01Z')),
    0,
  );
  store.close();

  const database = new Database(path, { readonly: true });
  const row = database
    .prepare('SELECT COUNT(*) AS count FROM account_leases WHERE account_id = ?')
    .get('codex-a') as { count: number };
  database.close();
  assert.equal(row.count, 1);
});

test('heartbeats only an active run-owned account lease without exceeding capacity', () => {
  const store = storeWithAccount('codex-a', 'codex', { maxConcurrency: 1 });
  const first = activeRunForAccount(store, { accountId: 'codex-a', provider: 'codex', id: 'heartbeat-a' });
  const second = activeRunForAccount(store, { accountId: 'codex-a', provider: 'codex', id: 'heartbeat-b' });
  store.acquireAccountLease('codex-a', first.run.id, new Date('2026-08-16T10:00:00Z'));

  const renewed = store.heartbeatAccountLease(
    'codex-a',
    first.run.id,
    new Date('2026-08-16T10:59:00Z'),
  );

  assert.equal(renewed.expiresAt, '2026-08-16T11:59:00.000Z');
  assert.throws(
    () => store.acquireAccountLease('codex-a', second.run.id, new Date('2026-08-16T11:30:00Z')),
    (error: unknown) => error instanceof RelayError && error.code === 'account_at_capacity',
  );
  assert.throws(
    () => store.heartbeatAccountLease('codex-a', second.run.id, new Date('2026-08-16T11:30:00Z')),
    (error: unknown) => error instanceof RelayError && error.code === 'not_found',
  );
  store.close();
});

test('does not revive an expired account lease through heartbeat', () => {
  const store = storeWithAccount('codex-a', 'codex', { maxConcurrency: 1 });
  const first = activeRunForAccount(store, { accountId: 'codex-a', provider: 'codex', id: 'late-a' });
  const second = activeRunForAccount(store, { accountId: 'codex-a', provider: 'codex', id: 'late-b' });
  store.acquireAccountLease('codex-a', first.run.id, new Date('2026-08-16T10:00:00Z'));
  store.acquireAccountLease('codex-a', second.run.id, new Date('2026-08-16T11:00:01Z'));

  assert.throws(
    () => store.heartbeatAccountLease('codex-a', first.run.id, new Date('2026-08-16T11:00:01Z')),
    (error: unknown) => error instanceof RelayError && error.code === 'not_found',
  );
  assert.equal(store.countActiveAccountLeases('codex-a', new Date('2026-08-16T11:00:01Z')), 1);
  store.close();
});

test('derives run provider and account identity from its session', () => {
  const store = storeWithAccount('claude-a', 'claude');
  store.upsertProviderAccount({
    id: 'claude-b', provider: 'claude', label: 'B', profilePath: '/profiles/claude-b',
    status: 'ready', maxConcurrency: 1, isDefault: false,
  });
  const { session } = activeRunForAccount(store, { accountId: 'claude-a', provider: 'claude', id: 'identity-base' });

  assert.throws(
    () => store.createRun({ sessionId: session.id, provider: 'codex', type: 'message', mutationMode: 'read' }),
    (error: unknown) => error instanceof RelayError && error.code === 'provider_mismatch',
  );
  assert.throws(
    () => store.createRun({ sessionId: session.id, provider: 'claude', accountId: 'claude-b', type: 'message', mutationMode: 'read' }),
    (error: unknown) => error instanceof RelayError && error.code === 'provider_mismatch',
  );
  const canonical = store.createRun({
    sessionId: session.id, provider: 'claude', type: 'message', mutationMode: 'read',
  });
  assert.equal(canonical.accountId, 'claude-a');
  store.close();
});

test('rejects a prepared launch with its pending session and account lease', () => {
  const store = storeWithAccount('claude-rejected', 'claude');
  const { session, run } = activeRunForAccount(store, {
    accountId: 'claude-rejected',
    provider: 'claude',
    id: 'rejected-launch',
    providerSessionId: 'pending:rejected-launch',
    sessionStatus: 'pending',
  });
  store.acquireAccountLease('claude-rejected', run.id);
  store.prepareRunLaunch(run.id, 'attempt-rejected-launch');

  const rejected = store.rejectRunLaunch(run.id, 'attempt-rejected-launch');

  assert.equal(rejected.status, 'failed');
  assert.equal(rejected.launchState, undefined);
  assert.equal(
    store.getStatus(run.workItemId).sessions.find(({ id }) => id === session.id)
      ?.status,
    'failed',
  );
  assert.equal(store.countActiveAccountLeases('claude-rejected'), 0);
  store.close();
});

test('quarantines an interrupted launch after reopening the state database', () => {
  const path = databasePath();
  const store = StateStore.open(path);
  store.upsertProviderAccount({
    id: 'codex-a', provider: 'codex', label: 'A', profilePath: '/profiles/codex-a',
    status: 'ready', maxConcurrency: 1, isDefault: false,
  });
  const { run } = activeRunForAccount(store, {
    accountId: 'codex-a',
    provider: 'codex',
    id: 'uncertain-a',
    providerSessionId: 'pending:uncertain-a',
  });
  store.acquireAccountLease('codex-a', run.id);
  const attempt = store.prepareRunLaunch(run.id, 'attempt-uncertain-a');
  assert.equal(attempt.launchState, 'prepared');
  store.close();

  const reopened = StateStore.open(path);
  const recovered = reopened.getRun(run.id);
  assert.equal(recovered.status, 'launch_uncertain');
  assert.equal(recovered.launchState, 'uncertain');
  assert.equal(recovered.launchAttemptId, 'attempt-uncertain-a');
  assert.equal(reopened.countActiveAccountLeases('codex-a'), 1);
  assert.equal(
    reopened.countActiveAccountLeases(
      'codex-a',
      new Date('2126-08-16T11:00:01Z'),
    ),
    1,
  );
  const replacement = activeRunForAccount(reopened, {
    accountId: 'codex-a',
    provider: 'codex',
    id: 'uncertain-replacement',
  });
  assert.throws(
    () =>
      reopened.acquireAccountLease(
        'codex-a',
        replacement.run.id,
        new Date('2126-08-16T11:00:01Z'),
      ),
    (error: unknown) =>
      error instanceof RelayError && error.code === 'account_at_capacity',
  );
  reopened.close();
});

test('does not quarantine a launch owned by another live StateStore', () => {
  const path = databasePath();
  const owner = StateStore.open(path);
  owner.upsertProviderAccount({
    id: 'codex-a',
    provider: 'codex',
    label: 'A',
    profilePath: '/profiles/codex-a',
    status: 'ready',
    maxConcurrency: 1,
    isDefault: false,
  });
  const { run } = activeRunForAccount(owner, {
    accountId: 'codex-a',
    provider: 'codex',
    id: 'live-launch',
  });
  owner.prepareRunLaunch(run.id, 'attempt-live');

  const observer = StateStore.open(path);

  assert.equal(observer.getRun(run.id).status, 'running');
  assert.equal(observer.getRun(run.id).launchState, 'prepared');
  observer.close();
  owner.markRunLaunchAccepted(run.id, 'attempt-live');
  owner.completeRunLaunch(run.id, 'attempt-live');
  owner.close();
});

test('does not quarantine a launch after local acceptance is durably completed', () => {
  const path = databasePath();
  const store = StateStore.open(path);
  store.upsertProviderAccount({
    id: 'codex-safe',
    provider: 'codex',
    label: 'Safe',
    profilePath: '/profiles/codex-safe',
    status: 'ready',
    maxConcurrency: 1,
    isDefault: false,
  });
  const { run } = activeRunForAccount(store, {
    accountId: 'codex-safe',
    provider: 'codex',
    id: 'accepted-safe',
  });
  const attemptId = 'attempt-accepted-safe';
  store.prepareRunLaunch(run.id, attemptId);
  store.markRunLaunchAccepted(run.id, attemptId);
  store.completeRunLaunch(run.id, attemptId);
  store.close();

  const reopened = StateStore.open(path);
  assert.equal(reopened.getRun(run.id).status, 'running');
  assert.equal(reopened.getRun(run.id).launchState, undefined);
  reopened.close();
});

test('releases quarantined capacity only through explicit uncertain-launch resolution', () => {
  const store = storeWithAccount('codex-resolve', 'codex');
  const { session, run } = activeRunForAccount(store, {
    accountId: 'codex-resolve',
    provider: 'codex',
    id: 'uncertain-resolve',
    providerSessionId: 'pending:uncertain-resolve',
    sessionStatus: 'pending',
  });
  store.acquireAccountLease('codex-resolve', run.id);
  store.prepareRunLaunch(run.id, 'attempt-resolve');
  store.markRunLaunchUncertain(run.id, 'attempt-resolve');

  const resolved = store.resolveUncertainLaunch(run.id);

  assert.equal(resolved.status, 'cancelled');
  assert.equal(store.countActiveAccountLeases('codex-resolve'), 0);
  assert.equal(
    store.getStatus(run.workItemId).sessions.find(({ id }) => id === session.id)
      ?.status,
    'failed',
  );
  store.close();
});

test('invalidates an active session when resolving post-acceptance uncertainty', () => {
  const store = storeWithAccount('codex-active-resolve', 'codex');
  const { session, run } = activeRunForAccount(store, {
    accountId: 'codex-active-resolve',
    provider: 'codex',
    id: 'uncertain-active-resolve',
  });
  store.acquireAccountLease('codex-active-resolve', run.id);
  store.prepareRunLaunch(run.id, 'attempt-active-resolve');
  store.markRunLaunchAccepted(run.id, 'attempt-active-resolve');
  store.markRunLaunchUncertain(run.id, 'attempt-active-resolve');

  store.resolveUncertainLaunch(run.id);

  assert.equal(
    store.getStatus(run.workItemId).sessions.find(({ id }) => id === session.id)
      ?.status,
    'failed',
  );
  store.close();
});

test('quarantines running siblings when resolving a shared-session launch', () => {
  const store = storeWithAccount('codex-shared-resolve', 'codex', {
    maxConcurrency: 2,
  });
  const { session, run } = activeRunForAccount(store, {
    accountId: 'codex-shared-resolve',
    provider: 'codex',
    id: 'uncertain-shared-a',
  });
  const sibling = store.transitionRun(
    store.createRun({
      id: 'uncertain-shared-b',
      sessionId: session.id,
      provider: 'codex',
      accountId: 'codex-shared-resolve',
      type: 'message',
      mutationMode: 'read',
    }).id,
    'running',
  );
  store.acquireAccountLease('codex-shared-resolve', run.id);
  store.acquireAccountLease('codex-shared-resolve', sibling.id);
  store.prepareRunLaunch(run.id, 'attempt-shared-resolve');
  store.markRunLaunchUncertain(run.id, 'attempt-shared-resolve');

  store.resolveUncertainLaunch(run.id);

  assert.equal(store.getRun(sibling.id).status, 'launch_uncertain');
  assert.equal(store.getRun(sibling.id).launchState, 'uncertain');
  assert.equal(store.countActiveAccountLeases('codex-shared-resolve'), 1);
  store.resolveUncertainLaunch(sibling.id);
  assert.equal(store.countActiveAccountLeases('codex-shared-resolve'), 0);
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
    () => store.setProviderConfig(project.id, 'codex', { apiKey: 'secret' }),
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
