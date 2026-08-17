import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'node:test';

import { RelayError } from '../src/errors.js';
import { GitHubClient } from '../src/github-client.js';
import { ProcessRunner } from '../src/process-runner.js';

const roots: string[] = [];
const fixtureBin = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'bin',
);

function githubForScenario(scenario: string) {
  const root = mkdtempSync(join(tmpdir(), 'relay-gh-test-'));
  roots.push(root);
  const commandLog = join(root, 'commands.jsonl');
  const env = {
    PATH: `${fixtureBin}:${process.env.PATH ?? ''}`,
    FAKE_GH_SCENARIO: scenario,
    FAKE_COMMAND_LOG: commandLog,
  };
  return {
    github: new GitHubClient(new ProcessRunner(), { env }),
    cwd: root,
    readCommands: () =>
      readFileSync(commandLog, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[]),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test('detects the repository and default branch through gh JSON', async () => {
  const { github, cwd } = githubForScenario('project');

  assert.deepEqual(await github.detectProject(cwd), {
    repo: 'acme/web',
    defaultBranch: 'main',
    url: 'https://github.com/acme/web',
  });
});

test('reports GitHub CLI authentication independently', async () => {
  const authenticated = githubForScenario('project').github;
  const loggedOut = githubForScenario('logged-out').github;

  assert.deepEqual(await authenticated.authStatus(), {
    authenticated: true,
    method: 'gh CLI',
  });
  assert.deepEqual(await loggedOut.authStatus(), {
    authenticated: false,
    detail: 'GitHub CLI is not authenticated.',
  });
});

test('reconciles an explicit branch to a full SHA and pull request', async () => {
  const { github } = githubForScenario('published');

  const state = await github.reconcile({
    repo: 'acme/web',
    branch: 'relay/auth',
    expectedBaseBranch: 'main',
  });

  assert.equal(state.status, 'verified');
  assert.equal(state.sha, 'b'.repeat(40));
  assert.equal(state.pullRequest, 143);
  assert.equal(state.checks, 'passing');
});

test('reports an explicit missing branch as awaiting publish', async () => {
  const { github } = githubForScenario('missing');

  const state = await github.reconcile({
    repo: 'acme/web',
    branch: 'relay/auth',
    expectedBaseBranch: 'main',
  });

  assert.deepEqual(state, {
    status: 'awaiting_publish',
    branch: 'relay/auth',
    checks: 'unknown',
  });
});

test('rejects pull-request truth from a different head SHA', async () => {
  const { github } = githubForScenario('pr-head-mismatch');

  await assert.rejects(
    github.reconcile({
      repo: 'acme/web',
      branch: 'relay/auth',
      expectedBaseBranch: 'main',
    }),
    /does not match the expected branch SHA/,
  );
});

test('rejects a stored pull request for a different branch', async () => {
  const { github } = githubForScenario('pr-branch-mismatch');

  await assert.rejects(
    github.reconcile({
      repo: 'acme/web',
      branch: 'relay/auth',
      pullRequest: 143,
      expectedBaseBranch: 'main',
    }),
    /does not belong to branch relay\/auth/,
  );
});

test('refuses merge without explicit approval', async () => {
  const { github } = githubForScenario('mergeable');

  await assert.rejects(
    github.merge({
      repo: 'acme/web',
      pullRequest: 143,
      expectedSha: 'b'.repeat(40),
      expectedBaseBranch: 'main',
      strategy: 'squash',
      approved: false,
    }),
    (error: unknown) =>
      error instanceof RelayError && error.code === 'merge_not_approved',
  );
});

test('refuses merge when the observed head differs from the approved SHA', async () => {
  const { github } = githubForScenario('moved');

  await assert.rejects(
    github.merge({
      repo: 'acme/web',
      pullRequest: 143,
      expectedSha: 'a'.repeat(40),
      expectedBaseBranch: 'main',
      strategy: 'squash',
      approved: true,
    }),
    (error: unknown) =>
      error instanceof RelayError && error.code === 'head_moved',
  );
});

test('refuses merge while required checks are failing', async () => {
  const { github } = githubForScenario('failing');

  await assert.rejects(
    github.merge({
      repo: 'acme/web',
      pullRequest: 143,
      expectedSha: 'b'.repeat(40),
      expectedBaseBranch: 'main',
      strategy: 'squash',
      approved: true,
    }),
    (error: unknown) =>
      error instanceof RelayError && error.code === 'merge_not_ready',
  );
});

test('refuses merge when the pull request is no longer open', async () => {
  const { github } = githubForScenario('closed');

  await assert.rejects(
    github.merge({
      repo: 'acme/web',
      pullRequest: 143,
      expectedSha: 'b'.repeat(40),
      expectedBaseBranch: 'main',
      strategy: 'squash',
      approved: true,
    }),
    (error: unknown) =>
      error instanceof RelayError && error.code === 'merge_not_ready',
  );
});

test('uses the full expected SHA when every merge gate passes', async () => {
  const { github, readCommands } = githubForScenario('mergeable');

  await github.merge({
    repo: 'acme/web',
    pullRequest: 143,
    expectedSha: 'b'.repeat(40),
    expectedBaseBranch: 'main',
    strategy: 'squash',
    approved: true,
  });

  const mergeCommand = readCommands().find(
    (args) => args[0] === 'pr' && args[1] === 'merge',
  );
  assert.deepEqual(mergeCommand, [
    'pr',
    'merge',
    '143',
    '--repo',
    'acme/web',
    '--squash',
    '--match-head-commit',
    'b'.repeat(40),
  ]);
});

test('rejects reconciliation when a pull request targets another base branch', async () => {
  const { github } = githubForScenario('published');

  await assert.rejects(
    github.reconcile({
      repo: 'acme/web',
      branch: 'relay/auth',
      expectedBaseBranch: 'release',
    }),
    (error: unknown) =>
      error instanceof RelayError && error.code === 'github_state_mismatch',
  );
});

test('rejects final merge when the pull request targets another base branch', async () => {
  const { github, readCommands } = githubForScenario('mergeable');

  await assert.rejects(
    github.merge({
      repo: 'acme/web',
      pullRequest: 143,
      expectedSha: 'b'.repeat(40),
      expectedBaseBranch: 'release',
      strategy: 'squash',
      approved: true,
    }),
    (error: unknown) =>
      error instanceof RelayError && error.code === 'github_state_mismatch',
  );
  assert.equal(
    readCommands().some((args) => args[0] === 'pr' && args[1] === 'merge'),
    false,
  );
});

test('summarizes checks for the exact commit SHA', async () => {
  const passing = githubForScenario('commit-checks-passing').github;
  const pending = githubForScenario('commit-checks-pending').github;
  const failing = githubForScenario('commit-checks-failing').github;
  const mixed = githubForScenario('commit-checks-mixed').github;
  const unknown = githubForScenario('commit-checks-unknown').github;
  const legacyFailing = githubForScenario('commit-checks-legacy-failing').github;
  const legacyPending = githubForScenario('commit-checks-legacy-pending').github;
  const sha = 'e'.repeat(40);

  assert.equal(await passing.getCommitChecks('acme/web', sha), 'passing');
  assert.equal(await pending.getCommitChecks('acme/web', sha), 'pending');
  assert.equal(await failing.getCommitChecks('acme/web', sha), 'failing');
  assert.equal(await mixed.getCommitChecks('acme/web', sha), 'failing');
  assert.equal(await unknown.getCommitChecks('acme/web', sha), 'unknown');
  assert.equal(await legacyFailing.getCommitChecks('acme/web', sha), 'failing');
  assert.equal(await legacyPending.getCommitChecks('acme/web', sha), 'pending');
});

test('inspects every commit-check page before classifying the SHA', async () => {
  const { github, readCommands } = githubForScenario('commit-checks-multi-page');
  const sha = 'e'.repeat(40);

  assert.equal(await github.getCommitChecks('acme/web', sha), 'failing');
  const command = readCommands().find((args) =>
    args.some((argument) => argument.includes('/check-runs')),
  );
  assert.ok(command?.includes('--paginate'));
  assert.ok(command?.includes('--slurp'));
  const legacyCommand = readCommands().find(
    (args) =>
      args[0] === 'api' &&
      args[1] === `repos/acme/web/commits/${sha}/status`,
  );
  assert.ok(legacyCommand?.includes('--paginate'));
  assert.ok(legacyCommand?.includes('--slurp'));
});

test('reuses one correctly targeted integration pull request', async () => {
  const { github, readCommands } = githubForScenario('published');

  const pullRequest = await github.ensurePullRequest({
    repo: 'acme/web',
    head: 'relay/auth',
    base: 'main',
    title: 'Relay integration',
    body: 'Prepared by Relay.',
  });

  assert.equal(pullRequest.number, 143);
  assert.equal(
    readCommands().some(
      (args) => args[0] === 'api' && args.includes('--method') && args.includes('POST'),
    ),
    false,
  );
});

test('creates an integration pull request only when no matching head exists', async () => {
  const { github, readCommands } = githubForScenario('no-pr');

  const pullRequest = await github.ensurePullRequest({
    repo: 'acme/web',
    head: 'relay/auth',
    base: 'main',
    title: 'Relay integration',
    body: 'Prepared by Relay.',
  });

  assert.equal(pullRequest.number, 144);
  assert.ok(
    readCommands().some(
      (args) => args[0] === 'api' && args.includes('--method') && args.includes('POST'),
    ),
  );
});

test('passes pull request strings literally through raw GitHub fields', async () => {
  const { github, readCommands } = githubForScenario('no-pr');

  await github.ensurePullRequest({
    repo: 'acme/web',
    head: 'relay/auth',
    base: 'main',
    title: '@/tmp/untrusted-title',
    body: '007',
  });

  const command = readCommands().find(
    (args) => args[0] === 'api' && args.includes('POST'),
  );
  assert.ok(command);
  assert.equal(command.includes('--field'), false);
  assert.ok(command.includes('--raw-field'));
  assert.ok(command.includes('title=@/tmp/untrusted-title'));
  assert.ok(command.includes('body=007'));
});
