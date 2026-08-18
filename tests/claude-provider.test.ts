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

function claudeForScenario(
  scenario: string,
  extraEnv: NodeJS.ProcessEnv = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'relay-claude-test-'));
  roots.push(root);
  const commandLog = join(root, 'commands.jsonl');
  const environmentLog = join(root, 'environment.jsonl');
  const env = {
    PATH: `${fixtureBin}:${process.env.PATH ?? ''}`,
    FAKE_CLAUDE_SCENARIO: scenario,
    FAKE_COMMAND_LOG: commandLog,
    FAKE_ENVIRONMENT_LOG: environmentLog,
    ...extraEnv,
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
      .map((line) => JSON.parse(line) as {
        CLAUDE_CONFIG_DIR?: string;
        ANTHROPIC_API_KEY?: string;
        ANTHROPIC_AUTH_TOKEN?: string;
        CLAUDE_CODE_OAUTH_TOKEN?: string;
        ANTHROPIC_PROFILE?: string;
        CLAUDE_CODE_USE_BEDROCK?: string;
      });
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
    mode: 'read',
  });

  assert.deepEqual(execution, {
    providerSessionId: 'session_abc123',
    url: 'https://claude.ai/code/session_abc123',
    status: 'running',
  });
  assert.deepEqual(readCommands()[0], ['--cloud', 'Implement auth']);
});

test('starts Claude cloud through the interactive terminal it requires', async () => {
  const { provider, cwd } = claudeForScenario('start-requires-tty');

  const execution = await provider.start({
    prompt: 'Inspect the repository',
    cwd,
    mode: 'read',
  });

  assert.deepEqual(execution, {
    providerSessionId: 'session_abc123',
    url: 'https://claude.ai/code/session_abc123',
    status: 'running',
  });
});

test('canonicalizes Claude cloud session links with CLI tracking metadata', async () => {
  const { provider, cwd } = claudeForScenario('start-query-url');

  const execution = await provider.start({
    prompt: 'Inspect the repository',
    cwd,
    mode: 'read',
  });

  assert.deepEqual(execution, {
    providerSessionId: 'session_abc123',
    url: 'https://claude.ai/code/session_abc123',
    status: 'running',
  });
});

test('accepts documented cse cloud session IDs and their safe separators', async () => {
  const { provider, cwd } = claudeForScenario('start-cse-url');

  const execution = await provider.start({
    prompt: 'Inspect the repository',
    cwd,
    mode: 'read',
  });

  assert.deepEqual(execution, {
    providerSessionId: 'cse_abc-123_def',
    url: 'https://claude.ai/code/cse_abc-123_def',
    status: 'running',
  });
});

test('selects the Claude session link after unrelated PTY output URLs', async () => {
  const { provider, cwd } = claudeForScenario('start-prefixed-url');

  const execution = await provider.start({
    prompt: 'Inspect the repository',
    cwd,
    mode: 'read',
  });

  assert.deepEqual(execution, {
    providerSessionId: 'session_abc123',
    url: 'https://claude.ai/code/session_abc123',
    status: 'running',
  });
});

test('runs Claude with the selected config directory and model', async () => {
  const { provider, cwd, readCommands, readEnvironments } = claudeForScenario('start');

  await provider.start({
    prompt: 'Build it',
    cwd,
    mode: 'read',
    profilePath: '/profiles/claude-a',
    model: 'opus',
  });

  assert.equal(readEnvironments()[0]?.CLAUDE_CONFIG_DIR, '/profiles/claude-a');
  assert.ok(readCommands()[0]?.includes('--model'));
});

test('reports authentication independently of account-gated attachment', async () => {
  const { provider } = claudeForScenario('start');

  assert.deepEqual(await provider.authStatus(), {
    authenticated: true,
    method: 'claude.ai',
  });
  const capabilities = await provider.capabilities();
  assert.equal(capabilities.start, true);
  assert.equal(capabilities.interactiveAttach, false);
  assert.equal(capabilities.structuredStatus, false);
});

test('reports one opaque identity for an authenticated Claude profile', async () => {
  const { provider, cwd, readEnvironments } = claudeForScenario('start');
  const profilePath = join(cwd, 'profiles', 'claude-a');

  const status = await provider.authStatus(profilePath);

  assert.deepEqual(status, {
    authenticated: true,
    method: 'claude.ai',
    identityFingerprint:
      '029a2469a15ea6c54d50c525080717c37341dcc776b010d0e1b1278016b9d020',
  });
  assert.equal(readEnvironments()[0]?.CLAUDE_CONFIG_DIR, profilePath);
});

test('logs in one fresh Claude profile and reuses its native login', async () => {
  const { provider, cwd, readCommands, readEnvironments } =
    claudeForScenario('profile-login-required', {
      ANTHROPIC_API_KEY: 'wrong-account-key',
      ANTHROPIC_AUTH_TOKEN: 'wrong-account-token',
      CLAUDE_CODE_OAUTH_TOKEN: 'wrong-account-oauth',
      ANTHROPIC_PROFILE: 'wrong-account-profile',
      CLAUDE_CODE_USE_BEDROCK: '1',
    });
  const profilePath = join(cwd, 'profiles', 'claude-a');

  const first = await provider.loginProfile!(profilePath);
  const second = await provider.loginProfile!(profilePath);

  assert.equal(first.authenticated, true);
  assert.equal(first.identityFingerprint, second.identityFingerprint);
  assert.deepEqual(readCommands(), [
    ['auth', 'status'],
    ['auth', 'login'],
    ['auth', 'status'],
    ['auth', 'status'],
  ]);
  assert.deepEqual(
    readEnvironments().map(({ CLAUDE_CONFIG_DIR }) => CLAUDE_CONFIG_DIR),
    [profilePath, profilePath, profilePath, profilePath],
  );
  for (const environment of readEnvironments()) {
    assert.equal(environment.ANTHROPIC_API_KEY, undefined);
    assert.equal(environment.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(environment.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    assert.equal(environment.ANTHROPIC_PROFILE, undefined);
    assert.equal(environment.CLAUDE_CODE_USE_BEDROCK, undefined);
  }
});

test('advertises documented queue-and-exit cloud follow-up', async () => {
  const { provider } = claudeForScenario('start');

  const capabilities = await provider.capabilities();

  assert.equal(capabilities.queueFollowup, true);
});

test('queues a follow-up to the existing Claude cloud session', async () => {
  const { provider, cwd, readCommands } = claudeForScenario('send');

  const execution = await provider.send!({
    providerSessionId: 'session_abc123',
    message: 'Fix the test',
    cwd,
  });

  assert.deepEqual(execution, {
    providerSessionId: 'session_abc123',
    url: 'https://claude.ai/code/session_abc123',
    status: 'running',
  });
  assert.deepEqual(readCommands()[0], [
    '-p',
    'Fix the test',
    '--cloud',
    'session_abc123',
    '--output-format',
    'json',
  ]);
});

test('queues a follow-up using a documented cse session ID', async () => {
  const { provider, cwd } = claudeForScenario('send-cse');

  const execution = await provider.send!({
    providerSessionId: 'cse_abc-123_def',
    message: 'Continue',
    cwd,
  });

  assert.deepEqual(execution, {
    providerSessionId: 'cse_abc-123_def',
    url: 'https://claude.ai/code/cse_abc-123_def',
    status: 'running',
  });
});

test('rejects a Claude follow-up acknowledgement for another session', async () => {
  const { provider, cwd } = claudeForScenario('send-mismatch');

  await assert.rejects(
    provider.send!({
      providerSessionId: 'session_abc123',
      message: 'Continue',
      cwd,
    }),
    (error: unknown) =>
      error instanceof RelayError && error.code === 'provider_output_invalid',
  );
});

test('rejects a failed Claude cloud follow-up acknowledgement', async () => {
  const { provider, cwd } = claudeForScenario('send-failed');

  await assert.rejects(
    provider.send!({
      providerSessionId: 'session_abc123',
      message: 'Continue',
      cwd,
    }),
    (error: unknown) =>
      error instanceof RelayError && error.code === 'provider_rejected',
  );
});

test('does not infer account-gated attachment from the current CLI help', async () => {
  const { provider } = claudeForScenario('current-help');

  const capabilities = await provider.capabilities();

  assert.equal(capabilities.start, true);
  assert.equal(capabilities.profileIsolation, true);
  assert.equal(capabilities.interactiveAttach, false);
});

test('does not advertise cloud operations when only the Claude binary is installed', async () => {
  const { provider } = claudeForScenario('installed-no-cloud');

  const capabilities = await provider.capabilities();

  assert.equal(capabilities.start, false);
  assert.equal(capabilities.queueFollowup, false);
  assert.equal(capabilities.interactiveAttach, false);
  assert.equal(capabilities.selectModel, false);
  assert.equal(capabilities.profileIsolation, false);
  assert.equal(capabilities.controlledResultBranch, false);
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
    provider.start({ prompt: 'x', cwd, mode: 'read' }),
    (error: unknown) =>
      error instanceof RelayError &&
      error.code === 'provider_output_invalid',
  );
});

test('rejects Claude cloud URLs outside the documented session route', async () => {
  for (const scenario of ['invalid-url-host', 'invalid-url-path', 'invalid-url-id']) {
    const { provider, cwd } = claudeForScenario(scenario);
    await assert.rejects(
      provider.start({ prompt: 'x', cwd, mode: 'read' }),
      (error: unknown) =>
        error instanceof RelayError && error.code === 'provider_output_invalid',
    );
  }
});
