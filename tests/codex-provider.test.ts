import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'node:test';

import { RelayError } from '../src/errors.js';
import { ProcessRunner } from '../src/process-runner.js';
import { CodexProvider } from '../src/providers/codex.js';

const roots: string[] = [];
const fixtureBin = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'bin',
);

function codexForScenario(scenario: string) {
  const root = mkdtempSync(join(tmpdir(), 'relay-codex-test-'));
  roots.push(root);
  const commandLog = join(root, 'commands.jsonl');
  const environmentLog = join(root, 'environment.jsonl');
  const env = {
    PATH: `${fixtureBin}:${process.env.PATH ?? ''}`,
    FAKE_CODEX_SCENARIO: scenario,
    FAKE_COMMAND_LOG: commandLog,
    FAKE_ENVIRONMENT_LOG: environmentLog,
  };
  return {
    provider: new CodexProvider(new ProcessRunner(), { env }),
    cwd: root,
    readCommands: () =>
      readFileSync(commandLog, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[]),
    readEnvironments: () =>
      readFileSync(environmentLog, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { CODEX_HOME?: string }),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test('submits a cloud task to the configured environment and branch', async () => {
  const { provider, cwd, readCommands } = codexForScenario('exec');

  const result = await provider.start({
    prompt: 'Review auth',
    cwd,
    startingBranch: 'relay/auth',
    environmentId: 'env_123',
    mode: 'read',
  });

  assert.deepEqual(result, {
    providerSessionId: 'task_456',
    status: 'running',
    url: 'https://chatgpt.com/codex/tasks/task_456',
  });
  assert.deepEqual(readCommands()[0], [
    'cloud',
    'exec',
    '--env',
    'env_123',
    '--branch',
    'relay/auth',
    'Review auth',
  ]);
});

test('runs Codex with the selected account home and requested cloud model', async () => {
  const { provider, cwd, readCommands, readEnvironments } = codexForScenario('exec');

  await provider.start({
    prompt: 'Build it',
    cwd,
    mode: 'write',
    resultBranch: 'relay/run/work-1/run-1',
    environmentId: 'env-1',
    profilePath: '/profiles/codex-a',
    model: 'gpt-5.6-sol',
  });

  assert.deepEqual(readCommands()[0], [
    'cloud',
    'exec',
    '--env',
    'env-1',
    '-c',
    'model="gpt-5.6-sol"',
    '--branch',
    'relay/run/work-1/run-1',
    'Build it',
  ]);
  assert.equal(readEnvironments()[0]?.CODEX_HOME, '/profiles/codex-a');
});

test('inspects task status from cloud list JSON', async () => {
  const { provider } = codexForScenario('list');

  const result = await provider.inspect!({
    providerSessionId: 'task_456',
    environmentId: 'env_123',
  });

  assert.deepEqual(result, {
    status: 'provider_complete',
    url: 'https://chatgpt.com/codex/tasks/task_456',
    summary: 'Review complete',
  });
});

test('requires an environment for cloud submission and inspection', async () => {
  const { provider, cwd } = codexForScenario('exec');

  await assert.rejects(
    provider.start({ prompt: 'Review', cwd, mode: 'read' }),
    (error: unknown) =>
      error instanceof RelayError && error.code === 'configuration_missing',
  );
  await assert.rejects(
    provider.inspect!({ providerSessionId: 'task_456' }),
    (error: unknown) =>
      error instanceof RelayError && error.code === 'configuration_missing',
  );
});

test('reports programmatic follow-up as unavailable', async () => {
  const { provider, cwd } = codexForScenario('exec');

  assert.equal((await provider.capabilities()).queueFollowup, false);
  await assert.rejects(
    provider.send!({
      providerSessionId: 'task_456',
      message: 'continue',
      cwd,
    }),
    (error: unknown) =>
      error instanceof RelayError && error.code === 'capability_unavailable',
  );
});

test('uses Codex login status without copying credentials', async () => {
  const { provider } = codexForScenario('exec');

  assert.deepEqual(await provider.authStatus(), {
    authenticated: true,
    method: 'ChatGPT',
  });
});

test('rejects submission output without a task identifier', async () => {
  const { provider, cwd } = codexForScenario('malformed');

  await assert.rejects(
    provider.start({
      prompt: 'Review',
      cwd,
      environmentId: 'env_123',
      mode: 'read',
    }),
    (error: unknown) =>
      error instanceof RelayError && error.code === 'provider_output_invalid',
  );
});

test('rejects Codex submission URLs outside the documented task route', async () => {
  for (const scenario of ['invalid-url-host', 'invalid-url-path', 'invalid-url-id']) {
    const { provider, cwd } = codexForScenario(scenario);
    await assert.rejects(
      provider.start({
        prompt: 'Review',
        cwd,
        environmentId: 'env_123',
        mode: 'read',
      }),
      (error: unknown) =>
        error instanceof RelayError && error.code === 'provider_output_invalid',
    );
  }
});

test('rejects a listed Codex task whose URL disagrees with its task ID', async () => {
  const { provider } = codexForScenario('invalid-list-url');

  await assert.rejects(
    provider.inspect!({
      providerSessionId: 'task_456',
      environmentId: 'env_123',
    }),
    (error: unknown) =>
      error instanceof RelayError && error.code === 'provider_output_invalid',
  );
});

test('launches the native cloud picker as its chat escape hatch', async () => {
  const { provider, cwd, readCommands } = codexForScenario('attach');

  assert.equal(
    await provider.attach!({ providerSessionId: 'task_456', cwd }),
    0,
  );
  assert.deepEqual(readCommands()[0], ['cloud']);
});
