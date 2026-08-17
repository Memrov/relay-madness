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
    [1, 2],
  );
  assert.ok(runColumns.some(({ name }) => name === 'baseline_sha'));
  assert.ok(
    artifactColumns.some(({ name }) => name === 'verification_status'),
  );
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
