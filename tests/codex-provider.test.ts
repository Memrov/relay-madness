import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'node:test';

import { RelayError } from '../src/errors.js';
import type { CloudProvider, ProviderCapabilities } from '../src/provider.js';
import { ProcessRunner } from '../src/process-runner.js';
import { CodexProvider } from '../src/providers/codex.js';

const roots: string[] = [];
const fixtureBin = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'bin',
);

function codexForScenario(
  scenario: string,
  environment: NodeJS.ProcessEnv = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'relay-codex-test-'));
  roots.push(root);
  const commandLog = join(root, 'commands.jsonl');
  const environmentLog = join(root, 'environment.jsonl');
  const env = {
    ...environment,
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
        .map((line) => JSON.parse(line) as {
          CODEX_HOME?: string;
          CODEX_SQLITE_HOME?: string;
          OPENAI_API_KEY?: string;
          CODEX_ACCESS_TOKEN?: string;
        }),
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

test('accepts current Codex cloud task identifiers', async () => {
  const { provider, cwd } = codexForScenario('current-cli');

  assert.deepEqual(
    await provider.start({
      prompt: 'Review auth',
      cwd,
      startingBranch: 'main',
      environmentId: 'acme/web',
      mode: 'read',
    }),
    {
      providerSessionId: 'task_e_6a83c77cbef483309fffeee9568686bd',
      status: 'running',
      url: 'https://chatgpt.com/codex/tasks/task_e_6a83c77cbef483309fffeee9568686bd',
    },
  );
});

test('runs Codex with the selected account home and requested cloud model', async () => {
  const { provider, cwd, readCommands, readEnvironments } = codexForScenario(
    'exec',
    {
      CODEX_SQLITE_HOME: '/wrong/shared-state',
      OPENAI_API_KEY: 'wrong-api-key',
      CODEX_ACCESS_TOKEN: 'wrong-access-token',
    },
  );

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
    'cli_auth_credentials_store="file"',
    '-c',
    'forced_login_method="chatgpt"',
    '-c',
    'model="gpt-5.6-sol"',
    '--branch',
    'relay/run/work-1/run-1',
    'Build it',
  ]);
  assert.deepEqual(readEnvironments()[0], {
    CODEX_HOME: '/profiles/codex-a',
    CODEX_SQLITE_HOME: '/profiles/codex-a',
  });
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

test('inspects current Codex cloud list output', async () => {
  const { provider } = codexForScenario('current-cli');

  assert.deepEqual(
    await provider.inspect!({
      providerSessionId: 'task_e_6a83c77cbef483309fffeee9568686bd',
      environmentId: 'acme/web',
    }),
    {
      status: 'provider_complete',
      url: 'https://chatgpt.com/codex/tasks/task_e_6a83c77cbef483309fffeee9568686bd',
      summary: '0 files changed, +0/-0',
    },
  );
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

test('logs in one isolated Codex profile and reuses its native login', async () => {
  const { provider, cwd, readCommands, readEnvironments } = codexForScenario(
    'profile-login',
    {
      CODEX_SQLITE_HOME: '/wrong/shared-state',
      OPENAI_API_KEY: 'wrong-api-key',
      CODEX_ACCESS_TOKEN: 'wrong-access-token',
    },
  );
  const profilePath = join(cwd, 'codex-profile');
  const login = (provider as CloudProvider).loginProfile;
  assert.ok(login);

  assert.deepEqual(await login.call(provider, profilePath), {
    authenticated: true,
    method: 'ChatGPT',
  });
  assert.equal(statSync(profilePath).mode & 0o777, 0o700);
  assert.deepEqual(await login.call(provider, profilePath), {
    authenticated: true,
    method: 'ChatGPT',
  });
  assert.deepEqual(readCommands(), [
    [
      'login',
      'status',
      '-c',
      'cli_auth_credentials_store="file"',
      '-c',
      'forced_login_method="chatgpt"',
    ],
    [
      'login',
      '-c',
      'cli_auth_credentials_store="file"',
      '-c',
      'forced_login_method="chatgpt"',
    ],
    [
      'login',
      'status',
      '-c',
      'cli_auth_credentials_store="file"',
      '-c',
      'forced_login_method="chatgpt"',
    ],
    [
      'login',
      'status',
      '-c',
      'cli_auth_credentials_store="file"',
      '-c',
      'forced_login_method="chatgpt"',
    ],
  ]);
  assert.deepEqual(
    readEnvironments(),
    Array.from({ length: 4 }, () => ({
      CODEX_HOME: profilePath,
      CODEX_SQLITE_HOME: profilePath,
    })),
  );
});

test('rejects API-key authentication for Codex Cloud profiles', async () => {
  const { provider } = codexForScenario('api-key');

  assert.deepEqual(await provider.authStatus('/profiles/codex-a'), {
    authenticated: false,
    method: 'API key',
    detail: 'Codex Cloud requires ChatGPT authentication.',
  });
});

test('rejects a successful Codex login status without an authentication method', async () => {
  const { provider } = codexForScenario('malformed-login-status');

  await assert.rejects(
    provider.authStatus('/profiles/codex-a'),
    (error: unknown) =>
      error instanceof RelayError && error.code === 'provider_output_invalid',
  );
});

test('reports that Codex cannot expose a stable profile identity', async () => {
  const { provider } = codexForScenario('exec');
  const capabilities = await provider.capabilities() as ProviderCapabilities & {
    reportsProfileIdentity?: boolean;
  };

  assert.equal(capabilities.reportsProfileIdentity, false);
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
