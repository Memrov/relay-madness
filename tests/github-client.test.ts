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
  });

  assert.deepEqual(state, {
    status: 'awaiting_publish',
    branch: 'relay/auth',
    checks: 'unknown',
  });
});

test('refuses merge without explicit approval', async () => {
  const { github } = githubForScenario('mergeable');

  await assert.rejects(
    github.merge({
      repo: 'acme/web',
      pullRequest: 143,
      expectedSha: 'b'.repeat(40),
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
