import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'node:test';

import { RelayError } from '../src/errors.js';
import { ProcessRunner } from '../src/process-runner.js';
import { ClaudeProvider } from '../src/providers/claude.js';

const roots: string[] = [];
const fixtureBin = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'bin',
);

function claudeForScenario(scenario: string) {
  const root = mkdtempSync(join(tmpdir(), 'relay-claude-test-'));
  roots.push(root);
  const commandLog = join(root, 'commands.jsonl');
  const environmentLog = join(root, 'environment.jsonl');
  const env = {
    PATH: `${fixtureBin}:${process.env.PATH ?? ''}`,
    FAKE_CLAUDE_SCENARIO: scenario,
    FAKE_COMMAND_LOG: commandLog,
    FAKE_ENVIRONMENT_LOG: environmentLog,
  };
  const readCommands = () =>
    readFileSync(commandLog, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
  const readEnvironments = () =>
    readFileSync(environmentLog, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { CLAUDE_CONFIG_DIR?: string });
  return {
    provider: new ClaudeProvider(new ProcessRunner(), { env }),
    cwd: root,
    readCommands,
    readEnvironments,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test('starts a Claude cloud session and parses its documented URL', async () => {
  const { provider, cwd, readCommands } = claudeForScenario('start');

  const execution = await provider.start({
    prompt: 'Implement auth',
    cwd,
    branch: 'relay/auth',
    mode: 'write',
  });

  assert.deepEqual(execution, {
    providerSessionId: 'session_abc123',
    url: 'https://claude.ai/code/session_abc123',
    status: 'running',
  });
  assert.deepEqual(readCommands()[0], ['--cloud', 'Implement auth']);
});

test('runs Claude with the selected config directory and model', async () => {
  const { provider, cwd, readCommands, readEnvironments } = claudeForScenario('start');

  await provider.start({
    prompt: 'Build it',
    cwd,
    mode: 'write',
    profilePath: '/profiles/claude-a',
    model: 'opus',
  });

  assert.equal(readEnvironments()[0]?.CLAUDE_CONFIG_DIR, '/profiles/claude-a');
  assert.ok(readCommands()[0]?.includes('--model'));
});

test('sends a follow-up to the existing session', async () => {
  const { provider, cwd, readCommands } = claudeForScenario('send');

  const execution = await provider.send!({
    providerSessionId: 'session_abc123',
    message: 'Fix the test',
    cwd,
  });

  assert.equal(execution.providerSessionId, 'session_abc123');
  assert.deepEqual(readCommands()[0], [
    '-p',
    'Fix the test',
    '--cloud',
    'session_abc123',
    '--output-format',
    'json',
  ]);
});

test('reports authentication and attach capability independently', async () => {
  const { provider } = claudeForScenario('start');

  assert.deepEqual(await provider.authStatus(), {
    authenticated: true,
    method: 'claude.ai',
  });
  const capabilities = await provider.capabilities();
  assert.equal(capabilities.start, true);
  assert.equal(capabilities.queueFollowup, true);
  assert.equal(capabilities.interactiveAttach, true);
  assert.equal(capabilities.structuredStatus, false);
});

test('reports a logged-out CLI without throwing', async () => {
  const { provider } = claudeForScenario('logged-out');

  assert.deepEqual(await provider.authStatus(), {
    authenticated: false,
    method: 'none',
  });
});

test('rejects cloud output without a session identifier', async () => {
  const { provider, cwd } = claudeForScenario('malformed');

  await assert.rejects(
    provider.start({ prompt: 'x', cwd, mode: 'write' }),
    (error: unknown) =>
      error instanceof RelayError &&
      error.code === 'provider_output_invalid',
  );
});

test('attaches with inherited provider-native terminal behavior', async () => {
  const { provider, cwd, readCommands } = claudeForScenario('attach');

  assert.equal(
    await provider.attach!({ providerSessionId: 'session_abc123', cwd }),
    0,
  );
  assert.deepEqual(readCommands()[0], ['--cloud', 'session_abc123']);
});
