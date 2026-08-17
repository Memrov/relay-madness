import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import { RelayError } from '../src/errors.js';
import {
  LandingCoordinator,
  type LandingGitHub,
  type LandingResult,
} from '../src/landing.js';
import { ProcessRunner } from '../src/process-runner.js';
import {
  StateStore,
  type CheckSummary,
} from '../src/state-store.js';

const roots: string[] = [];
const stores: StateStore[] = [];

class RecordingRunner extends ProcessRunner {
  readonly commands: Array<{ command: string; args: readonly string[] }> = [];

  override async run(
    command: string,
    args: readonly string[],
    options: Parameters<ProcessRunner['run']>[2] = {},
  ) {
    this.commands.push({ command, args: [...args] });
    return await super.run(command, args, options);
  }
}

class FakeLandingGitHub implements LandingGitHub {
  readonly inspected: Array<{ repo: string; sha: string }> = [];
  readonly pullRequests: Array<{
    repo: string;
    head: string;
    base: string;
    title: string;
    body: string;
  }> = [];

  constructor(
    private readonly remote: string,
    public checks: CheckSummary = 'unknown',
  ) {}

  async getCommitChecks(repo: string, sha: string): Promise<CheckSummary> {
    this.inspected.push({ repo, sha });
    return this.checks;
  }

  async getBranchSha(_repo: string, branch: string): Promise<string | undefined> {
    return remoteSha(this.remote, branch);
  }

  async ensurePullRequest(input: {
    repo: string;
    head: string;
    base: string;
    title: string;
    body: string;
  }): Promise<{ number: number; url: string }> {
    this.pullRequests.push(input);
    return { number: 71, url: 'https://example.test/acme/web/pull/71' };
  }
}

interface LandingFixture {
  root: string;
  remote: string;
  checkout: string;
  store: StateStore;
  runner: RecordingRunner;
  github: FakeLandingGitHub;
  lander: LandingCoordinator;
  runId: string;
  workItemId: string;
  sourceBranch: string;
  sourceSha: string;
  integrationBranch: string;
  integrationBefore: string;
  remoteSha(branch: string): string | undefined;
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('prepares one candidate on a staging branch without moving integration', async () => {
  const fixture = await createLandingRepository();

  const result = await fixture.lander.land(fixture.runId);

  assert.equal(result.status, 'staged');
  assert.equal(
    fixture.remoteSha(fixture.integrationBranch),
    fixture.integrationBefore,
  );
  assert.equal(fixture.remoteSha(result.stagingBranch!), result.stagingSha);
});

test('fast-forwards integration only after the exact staging SHA passes checks', async () => {
  const fixture = await createLandingRepository({ checks: 'passing' });
  const staged = await fixture.lander.land(fixture.runId);

  const landed = await fixture.lander.land(fixture.runId);

  assert.equal(landed.status, 'landed');
  assert.equal(
    fixture.remoteSha(fixture.integrationBranch),
    staged.stagingSha,
  );
  assert.deepEqual(fixture.github.inspected, [
    { repo: 'acme/web', sha: staged.stagingSha! },
  ]);
  assert.equal(fixture.github.pullRequests.length, 1);
  assert.equal(fixture.github.pullRequests[0]?.head, fixture.integrationBranch);
  assert.equal(fixture.github.pullRequests[0]?.base, 'main');
});

test('creates a missing integration branch only after its staged SHA passes checks', async () => {
  const fixture = await createLandingRepository({
    checks: 'passing',
    integrationExists: false,
  });

  const staged = await fixture.lander.land(fixture.runId);
  assert.equal(staged.status, 'staged');
  assert.equal(fixture.remoteSha(fixture.integrationBranch), undefined);

  const landed = await fixture.lander.land(fixture.runId);
  assert.equal(landed.status, 'landed');
  assert.equal(
    fixture.remoteSha(fixture.integrationBranch),
    staged.stagingSha,
  );
});

test('lands a read-first WorkItem on its reserved integration branch, never base', async () => {
  const fixture = await createLandingRepository({
    checks: 'passing',
    integrationExists: false,
    workItemCurrentBranch: 'main',
  });

  const staged = await fixture.lander.land(fixture.runId);
  assert.equal(staged.status, 'staged');
  assert.match(fixture.integrationBranch, /^relay\/work\//);
  assert.notEqual(fixture.integrationBranch, 'main');
  assert.equal(fixture.remoteSha('main'), fixture.integrationBefore);
  assert.equal(fixture.remoteSha(fixture.integrationBranch), undefined);

  const landed = await fixture.lander.land(fixture.runId);
  assert.equal(landed.status, 'landed');
  assert.equal(fixture.remoteSha(fixture.integrationBranch), staged.stagingSha);
  assert.equal(fixture.remoteSha('main'), fixture.integrationBefore);
});

test('rejects malformed candidate state that targets main when the base is develop', async () => {
  const fixture = await createLandingRepository();
  const mainBefore = fixture.remoteSha('main');
  const getCandidate = fixture.store.getCandidate.bind(fixture.store);
  const getWorkItem = fixture.store.getWorkItem.bind(fixture.store);
  fixture.store.getCandidate = (runId) => {
    const candidate = getCandidate(runId);
    return candidate === undefined ? undefined : { ...candidate, integrationBranch: 'main' };
  };
  fixture.store.getWorkItem = (workItemId) => ({
    ...getWorkItem(workItemId),
    baseBranch: 'develop',
  });

  const result = await fixture.lander.land(fixture.runId);

  assert.equal(result.status, 'stale');
  assert.equal(fixture.remoteSha('main'), mainBefore);
  assert.equal(fixture.runner.commands.length, 0);
});

test('leaves integration unchanged on textual conflict', async () => {
  const fixture = await createConflictingLandingRepository();

  const result = await fixture.lander.land(fixture.runId);

  assert.equal(result.status, 'conflict');
  assert.deepEqual(result.conflictFiles, ['src/shared.ts']);
  assert.equal(
    fixture.remoteSha(fixture.integrationBranch),
    fixture.integrationBefore,
  );
});

test('keeps pending and unknown checks staged at the exact prepared SHA', async () => {
  for (const checks of ['pending', 'unknown'] as const) {
    const fixture = await createLandingRepository({ checks });
    const staged = await fixture.lander.land(fixture.runId);

    const waiting = await fixture.lander.land(fixture.runId);

    assert.equal(waiting.status, 'staged');
    assert.equal(waiting.stagingSha, staged.stagingSha);
    assert.equal(
      fixture.remoteSha(fixture.integrationBranch),
      fixture.integrationBefore,
    );
  }
});

test('marks a staged candidate when exact-SHA checks fail', async () => {
  const fixture = await createLandingRepository({ checks: 'failing' });
  await fixture.lander.land(fixture.runId);

  const result = await fixture.lander.land(fixture.runId);

  assert.equal(result.status, 'checks_failed');
  assert.equal(
    fixture.remoteSha(fixture.integrationBranch),
    fixture.integrationBefore,
  );
});

test('does not overwrite an integration head that moved after staging', async () => {
  const fixture = await createLandingRepository({ checks: 'passing' });
  await fixture.lander.land(fixture.runId);
  const movedSha = commitOnBranch(
    fixture.checkout,
    fixture.integrationBranch,
    'src/integration-only.ts',
    'integration moved\n',
    'Move integration',
  );

  const result = await fixture.lander.land(fixture.runId);

  assert.equal(result.status, 'stale');
  assert.equal(fixture.remoteSha(fixture.integrationBranch), movedSha);
  assert.equal(fixture.github.pullRequests.length, 0);
});

test('finishes on the candidate integration branch after WorkItem current branch changes', async () => {
  const fixture = await createLandingRepository({ checks: 'passing' });
  const staged = await fixture.lander.land(fixture.runId);
  const changedBranch = 'relay/work/changed-after-stage';
  git(
    fixture.checkout,
    'push',
    'origin',
    `${fixture.integrationBefore}:refs/heads/${changedBranch}`,
  );
  fixture.store.saveArtifact({
    workItemId: fixture.workItemId,
    branch: changedBranch,
    sha: fixture.integrationBefore,
    status: 'published',
    checks: 'unknown',
  });

  const landed = await fixture.lander.land(fixture.runId);

  assert.equal(landed.status, 'landed');
  assert.equal(fixture.remoteSha(fixture.integrationBranch), staged.stagingSha);
  assert.equal(fixture.remoteSha(changedBranch), fixture.integrationBefore);
  assert.equal(fixture.github.pullRequests[0]?.head, fixture.integrationBranch);
});

test('recovers an exact staged commit after a push-to-database crash boundary', async () => {
  const fixture = await createLandingRepository();
  const recordCandidateStage =
    fixture.store.recordCandidateStage.bind(fixture.store);
  let injectFailure = true;
  fixture.store.recordCandidateStage = (runId, input) => {
    if (injectFailure) {
      injectFailure = false;
      throw new Error('injected database boundary failure');
    }
    return recordCandidateStage(runId, input);
  };

  await assert.rejects(
    fixture.lander.land(fixture.runId),
    /injected database boundary failure/,
  );
  assert.equal(fixture.store.getCandidate(fixture.runId)?.status, 'ready');
  assert.match(
    git(
      fixture.remote,
      'for-each-ref',
      '--format=%(refname:short)',
      'refs/heads/relay/stage',
    ),
    /^relay\/stage\//,
  );

  const recovered = await fixture.lander.land(fixture.runId);

  assert.equal(recovered.status, 'staged');
  assert.equal(
    fixture.remoteSha(recovered.stagingBranch!),
    recovered.stagingSha,
  );
});

test('rejects a preexisting stage ref without exact candidate provenance', async () => {
  const fixture = await createLandingRepository();
  const stagingBranch = `relay/stage/run-1-${fixture.integrationBefore.slice(0, 8)}`;
  git(fixture.checkout, 'switch', '-c', stagingBranch, fixture.integrationBefore);
  writeFileSync(join(fixture.checkout, 'src', 'untrusted.ts'), 'export {}\n');
  git(fixture.checkout, 'add', '.');
  git(fixture.checkout, 'commit', '-m', 'Untrusted staged commit');
  git(fixture.checkout, 'push', '-u', 'origin', stagingBranch);

  const result = await fixture.lander.land(fixture.runId);

  assert.equal(result.status, 'stale');
  assert.notEqual(fixture.remoteSha(stagingBranch), fixture.sourceSha);
  assert.equal(
    fixture.remoteSha(fixture.integrationBranch),
    fixture.integrationBefore,
  );
});

test('serializes two landing attempts for the same WorkItem', async () => {
  const fixture = await createLandingRepository();

  const attempts = await Promise.allSettled([
    fixture.lander.land(fixture.runId),
    fixture.lander.land(fixture.runId),
  ]);

  assert.equal(attempts.filter(({ status }) => status === 'fulfilled').length, 1);
  const rejected = attempts.find(({ status }) => status === 'rejected');
  assert.ok(rejected?.status === 'rejected');
  assert.ok(
    rejected.reason instanceof RelayError &&
      rejected.reason.code === 'work_item_locked',
  );
});

test('rejects a candidate SHA that is not the committed source-branch head', async () => {
  const fixture = await createLandingRepository({ resultSha: 'f'.repeat(40) });

  const result = await fixture.lander.land(fixture.runId);

  assert.equal(result.status, 'stale');
  assert.equal(
    fixture.remoteSha(fixture.integrationBranch),
    fixture.integrationBefore,
  );
});

test('cleans temporary staging state without deleting source or forcing a push', async () => {
  const fixture = await createLandingRepository({ checks: 'passing' });
  await fixture.lander.land(fixture.runId);
  const result = await fixture.lander.land(fixture.runId);

  assert.equal(result.status, 'landed');
  assert.equal(fixture.remoteSha(fixture.sourceBranch), fixture.sourceSha);
  assert.equal(
    fixture.runner.commands.some(({ args }) => args.includes('--force')),
    false,
  );
});

async function createConflictingLandingRepository(): Promise<LandingFixture> {
  return await createLandingRepository({ conflict: true });
}

async function createLandingRepository(
  options: {
    checks?: CheckSummary;
    conflict?: boolean;
    integrationExists?: boolean;
    resultSha?: string;
    workItemCurrentBranch?: string;
  } = {},
): Promise<LandingFixture> {
  const root = mkdtempSync(join(tmpdir(), 'relay-landing-test-'));
  roots.push(root);
  const remote = join(root, 'remote.git');
  const checkout = join(root, 'checkout');
  git(root, 'init', '--bare', remote);
  git(root, 'clone', remote, checkout);
  git(checkout, 'config', 'user.name', 'Relay Test');
  git(checkout, 'config', 'user.email', 'relay@example.test');
  mkdirSync(join(checkout, 'src'), { recursive: true });
  writeFileSync(join(checkout, 'src', 'shared.ts'), 'export const shared = 1;\n');
  git(checkout, 'add', '.');
  git(checkout, 'commit', '-m', 'Initial');
  git(checkout, 'branch', '-M', 'main');
  git(checkout, 'push', '-u', 'origin', 'main');

  const integrationBranch = 'relay/work/auth';
  let integrationBefore = git(checkout, 'rev-parse', 'main');
  if (options.integrationExists !== false) {
    git(checkout, 'switch', '-c', integrationBranch);
    if (options.conflict === true) {
      writeFileSync(join(checkout, 'src', 'shared.ts'), 'export const shared = 2;\n');
    } else {
      writeFileSync(
        join(checkout, 'src', 'integration.ts'),
        'export const base = true;\n',
      );
    }
    git(checkout, 'add', '.');
    git(checkout, 'commit', '-m', 'Integration base');
    git(checkout, 'push', '-u', 'origin', integrationBranch);
    integrationBefore = git(checkout, 'rev-parse', 'HEAD');
  }

  const sourceBranch = 'relay/run/work-1/run-1';
  git(checkout, 'switch', '-c', sourceBranch, 'main');
  if (options.conflict === true) {
    writeFileSync(join(checkout, 'src', 'shared.ts'), 'export const shared = 3;\n');
  } else {
    writeFileSync(join(checkout, 'src', 'feature.ts'), 'export const feature = true;\n');
  }
  git(checkout, 'add', '.');
  git(checkout, 'commit', '-m', 'Candidate change');
  git(checkout, 'push', '-u', 'origin', sourceBranch);
  const sourceSha = git(checkout, 'rev-parse', 'HEAD');

  const store = StateStore.open(join(root, 'state', 'relay.db'));
  stores.push(store);
  const project = store.upsertProject({
    repo: 'acme/web',
    defaultBranch: 'main',
    locatorPath: checkout,
  });
  const workItem = store.createWorkItem({
    id: 'work-1',
    projectId: project.id,
    title: 'Authentication',
    baseBranch: 'main',
    currentBranch: options.workItemCurrentBranch ?? integrationBranch,
  });
  const session = store.upsertSession({
    workItemId: workItem.id,
    provider: 'codex',
    providerSessionId: 'session-1',
    status: 'active',
    branch: sourceBranch,
  });
  const run = store.createRun({
    id: 'run-1',
    sessionId: session.id,
    provider: 'codex',
    type: 'delegation',
    mutationMode: 'write',
    expectedBranch: sourceBranch,
    baseSha: git(checkout, 'rev-parse', 'main'),
    resultSha: options.resultSha ?? sourceSha,
  });
  const candidate = store.createCandidateForRun(run.id);
  assert.ok(candidate);

  const runner = new RecordingRunner();
  const github = new FakeLandingGitHub(remote, options.checks);
  const lander = new LandingCoordinator({ store, github, runner });
  return {
    root,
    remote,
    checkout,
    store,
    runner,
    github,
    lander,
    runId: run.id,
    workItemId: workItem.id,
    sourceBranch,
    sourceSha,
    integrationBranch: candidate.integrationBranch,
    integrationBefore,
    remoteSha: (branch) => remoteSha(remote, branch),
  };
}

function commitOnBranch(
  checkout: string,
  branch: string,
  path: string,
  content: string,
  message: string,
): string {
  git(checkout, 'switch', branch);
  writeFileSync(join(checkout, path), content);
  git(checkout, 'add', path);
  git(checkout, 'commit', '-m', message);
  git(checkout, 'push', 'origin', branch);
  return git(checkout, 'rev-parse', 'HEAD');
}

function remoteSha(remote: string, branch: string): string | undefined {
  const output = git(remote, 'rev-parse', '--verify', `refs/heads/${branch}`, {
    allowFailure: true,
  });
  return output === '' ? undefined : output;
}

function git(
  cwd: string,
  ...input: Array<string | { allowFailure: boolean }>
): string {
  const options =
    typeof input.at(-1) === 'object'
      ? (input.pop() as { allowFailure: boolean })
      : undefined;
  try {
    return execFileSync('git', input as string[], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', options?.allowFailure === true ? 'ignore' : 'pipe'],
    }).trim();
  } catch (error) {
    if (options?.allowFailure === true) return '';
    throw error;
  }
}

function assertLandingResult(
  _result: LandingResult,
): void {
  // Compile-time exhaustiveness anchor for the public landing result.
}
