import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, statSync } from 'node:fs';
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
  database.close();

  assert.deepEqual(
    versions.map(({ version }) => version),
    [1, 2, 3],
  );
  assert.ok(runColumns.some(({ name }) => name === 'baseline_sha'));
  assert.ok(
    artifactColumns.some(({ name }) => name === 'verification_status'),
  );
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
