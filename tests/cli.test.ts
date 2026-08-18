import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  createCli,
  createRelayApplication,
  type RelayApi,
  type RelayIo,
} from '../src/app.js';
import type { ProviderName } from '../src/provider.js';
import { runRepl } from '../src/repl.js';

const sha = 'b'.repeat(40);
const statusFixture = {
  workItem: {
    id: 'work_1',
    projectId: 'project_1',
    title: 'Authentication',
    baseBranch: 'main',
    integrationBranch: 'relay/auth',
    currentBranch: 'relay/auth',
    currentSha: sha,
    pullRequest: 143,
    status: 'in_progress',
    createdAt: '2026-08-16T00:00:00.000Z',
    updatedAt: '2026-08-16T00:00:00.000Z',
  },
  sessions: [],
  runs: [],
  artifact: {
    id: 'artifact_1',
    workItemId: 'work_1',
    branch: 'relay/auth',
    sha,
    status: 'verified',
    pullRequest: 143,
    checks: 'passing',
    mergeable: true,
    reviewDecision: 'APPROVED',
    draft: false,
    observedAt: '2026-08-16T00:00:00.000Z',
  },
} as const;

interface CoreCalls {
  merge: unknown[];
  send: unknown[];
  delegate: unknown[];
  handoff: unknown[];
  initialize: unknown[];
  addAccount: unknown[];
  recordUsage: unknown[];
  land: unknown[];
  chat: unknown[];
  resolveLaunch: unknown[];
}

function fakeCore(overrides: Partial<RelayApi> = {}): {
  core: RelayApi;
  calls: CoreCalls;
} {
  const calls: CoreCalls = {
    merge: [],
    send: [],
    delegate: [],
    handoff: [],
    initialize: [],
    addAccount: [],
    recordUsage: [],
    land: [],
    chat: [],
    resolveLaunch: [],
  };
  const core = {
    doctor: async () => ({
      github: { authenticated: true, method: 'gh CLI' },
      providers: {
        claude: {
          auth: { authenticated: false, detail: 'not logged in' },
          capabilities: {},
        },
        codex: {
          auth: { authenticated: true, method: 'ChatGPT' },
          capabilities: {},
        },
      },
    }),
    initialize: async (input: unknown) => {
      calls.initialize.push(input);
      return { id: 'project_1', repo: 'acme/web' };
    },
    delegate: async (input: unknown) => {
      calls.delegate.push(input);
      return { run: { status: 'running' }, workItem: statusFixture.workItem };
    },
    send: async (input: unknown) => {
      calls.send.push(input);
      return { run: { status: 'running' }, workItem: statusFixture.workItem };
    },
    handoff: async (input: unknown) => {
      calls.handoff.push(input);
      return { run: { status: 'running' } };
    },
    status: async () => statusFixture,
    addAccount: async (input: unknown) => {
      calls.addAccount.push(input);
      return {
        ...(input as object),
        createdAt: '2026-08-16T00:00:00.000Z',
        updatedAt: '2026-08-16T00:00:00.000Z',
      };
    },
    accounts: async () => [
      {
        id: 'codex-a',
        label: 'Primary',
        provider: 'codex',
        status: 'ready',
        capacity: 1,
        activeLeaseCount: 0,
        latestUsage: [
          {
            id: 'usage_1',
            accountId: 'codex-a',
            period: 'weekly',
            model: 'gpt-5.6-sol',
            remainingPercent: 62,
            resetsAt: '2026-08-20T00:00:00.000Z',
            source: 'manual',
            observedAt: '2026-08-16T00:00:00.000Z',
          },
        ],
      },
    ],
    recordUsage: async (input: unknown) => {
      calls.recordUsage.push(input);
      return { id: 'usage_1', ...(input as object) };
    },
    usage: async () => [
      {
        id: 'usage_1',
        accountId: 'codex-a',
        period: 'weekly',
        model: 'gpt-5.6-sol',
        remainingPercent: 62,
        resetsAt: '2026-08-20T00:00:00.000Z',
        source: 'manual',
        observedAt: '2026-08-16T00:00:00.000Z',
      },
    ],
    land: async (runId: string) => {
      calls.land.push(runId);
      return {
        runId,
        status: 'landed',
        stagingBranch: 'relay/stage/run_1-deadbeef',
        stagingSha: sha,
        landedSha: 'a'.repeat(40),
      };
    },
    sessions: async () => [],
    providers: async () => ({}),
    reconcile: async () => statusFixture.artifact,
    resolveLaunch: async (input: unknown) => {
      calls.resolveLaunch.push(input);
      return { id: 'run_uncertain', status: 'cancelled' } as never;
    },
    chat: async (...input: unknown[]) => {
      calls.chat.push(input);
      return 0;
    },
    merge: async (input: unknown) => {
      calls.merge.push(input);
    },
    ...overrides,
  } as unknown as RelayApi;
  return { core, calls };
}

function memoryIo(options: {
  answers?: readonly string[];
  lines?: readonly string[];
} = {}): RelayIo & { stdout: string; stderr: string } {
  const inputs = [...(options.lines ?? options.answers ?? [])];
  return {
    stdout: '',
    stderr: '',
    cwd: () => '/workspace/acme-web',
    write(text: string) {
      this.stdout += text;
    },
    writeError(text: string) {
      this.stderr += text;
    },
    async readLine() {
      return inputs.shift();
    },
    close() {},
  };
}

test('advertises only Codex and Claude provider commands', () => {
  const { core } = fakeCore();
  const io = memoryIo();
  const cli = createCli(core, io);
  const init = cli.commands.find((command) => command.name() === 'init');
  const delegate = cli.commands.find((command) => command.name() === 'delegate');

  assert.ok(init);
  assert.ok(delegate);
  assert.doesNotMatch(cli.helpInformation(), /\bjules\b/i);
  assert.doesNotMatch(init.helpInformation(), /\bjules\b/i);
  assert.doesNotMatch(delegate.helpInformation(), /\bjules\b/i);
});

test('rejects an unsupported provider before delegation', async () => {
  const { core, calls } = fakeCore();
  const io = memoryIo();

  await assert.rejects(
    createCli(core, io).parseAsync([
      'node',
      'relay',
      'delegate',
      'jules',
      'Review it',
    ]),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'invalid_argument',
  );
  assert.deepEqual(calls.delegate, []);
});

test('identifies the REPL as Relay Cluster and rejects unsupported switches', async () => {
  const { core } = fakeCore();
  const io = memoryIo({ lines: ['/use jules', '/quit'] });

  await runRepl(core, io);

  assert.match(io.stdout, /^Relay Cluster/);
  assert.match(io.stderr, /invalid_argument: Unknown provider jules\./);
});

test('stores new application state under the Relay Cluster identity', () => {
  const root = mkdtempSync(join(tmpdir(), 'relay-cluster-state-test-'));
  try {
    const application = createRelayApplication({
      env: { XDG_STATE_HOME: root },
    });
    application.close();

    assert.equal(existsSync(join(root, 'relay-cluster', 'relay.db')), true);
    assert.equal(existsSync(join(root, 'relay-madness')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('prints machine-readable status', async () => {
  const { core } = fakeCore();
  const io = memoryIo();

  await createCli(core, io).parseAsync([
    'node',
    'relay',
    'status',
    '--json',
  ]);

  assert.deepEqual(JSON.parse(io.stdout), statusFixture);
});

test('surfaces quarantined launch state in human-readable status', async () => {
  const { core } = fakeCore({
    status: async () => ({
      ...statusFixture,
      project: {
        id: 'project_1',
        repo: 'acme/web',
        defaultBranch: 'main',
        locatorPath: '/workspace/acme-web',
        createdAt: '2026-08-16T00:00:00.000Z',
        updatedAt: '2026-08-16T00:00:00.000Z',
      },
      runs: [
        {
          id: 'run_uncertain',
          sessionId: 'session_pending',
          workItemId: 'work_1',
          provider: 'claude',
          type: 'delegation',
          mutationMode: 'read',
          status: 'launch_uncertain',
          correlationId: 'run_uncertain',
          delegationDepth: 0,
          startedAt: '2026-08-16T00:00:00.000Z',
          skills: [],
        },
      ],
    }),
  });
  const io = memoryIo();

  await createCli(core, io).parseAsync(['node', 'relay', 'status']);

  assert.match(io.stdout, /run_uncertain\s+launch_uncertain/);
  assert.match(io.stdout, /explicit operator resolution required/);
});

test('doctor reports each dependency independently', async () => {
  const { core } = fakeCore();
  const io = memoryIo();

  await createCli(core, io).parseAsync(['node', 'relay', 'doctor']);

  assert.match(io.stdout, /GitHub\s+✓/);
  assert.match(io.stdout, /Claude\s+✗/);
  assert.match(io.stdout, /Codex\s+✓/);
  assert.doesNotMatch(io.stdout, /Jules/i);
  assert.match(
    io.stdout,
    /Provider identities are trusted GitHub writers; Relay prompts do not enforce branch authorization\./,
  );
  assert.match(
    createCli(core, io).helpInformation(),
    /provider GitHub-writer trust boundary/,
  );
});

test('merge defaults to refusal when confirmation is not yes', async () => {
  const { core, calls } = fakeCore();
  const io = memoryIo({ answers: ['n'] });

  await createCli(core, io).parseAsync([
    'node',
    'relay',
    'merge',
    '--strategy',
    'squash',
  ]);

  assert.equal(calls.merge.length, 0);
  assert.match(io.stdout, /PR #143/);
  assert.match(io.stdout, new RegExp(sha));
  assert.match(io.stdout, /Merge cancelled/);
});

test('resolves launch quarantine only after explicit operator confirmation', async () => {
  const { core, calls } = fakeCore();
  const refusedIo = memoryIo({ answers: ['no'] });
  await createCli(core, refusedIo).parseAsync([
    'node',
    'relay',
    'resolve-launch',
    'run_uncertain',
  ]);
  assert.deepEqual(calls.resolveLaunch, []);

  const approvedIo = memoryIo({ answers: ['yes'] });
  await createCli(core, approvedIo).parseAsync([
    'node',
    'relay',
    'resolve-launch',
    'run_uncertain',
  ]);
  assert.deepEqual(calls.resolveLaunch, [
    { runId: 'run_uncertain', confirmed: true },
  ]);
  assert.match(approvedIo.stdout, /resolved as cancelled/);
});

test('merge binds an affirmative confirmation to core approval', async () => {
  const { core, calls } = fakeCore();
  const io = memoryIo({ answers: ['yes'] });

  await createCli(core, io).parseAsync([
    'node',
    'relay',
    'merge',
    '--strategy',
    'rebase',
  ]);

  assert.deepEqual(calls.merge, [
    {
      cwd: '/workspace/acme-web',
      strategy: 'rebase',
      approved: true,
      pullRequest: 143,
      expectedSha: sha,
    },
  ]);
});

test('initializes only non-secret provider references', async () => {
  const { core, calls } = fakeCore();
  const io = memoryIo();

  await createCli(core, io).parseAsync([
    'node',
    'relay',
    'init',
    '--codex-env',
    'env_123',
  ]);

  assert.deepEqual(calls.initialize, [
    {
      cwd: '/workspace/acme-web',
      providerConfigs: {
        codex: { environmentId: 'env_123' },
      },
    },
  ]);
});

test('forwards account and model selection for send', async () => {
  const { core, calls } = fakeCore();
  const io = memoryIo();

  await createCli(core, io).parseAsync([
    'node',
    'relay',
    'send',
    'claude',
    'Continue',
    '--work-item',
    'work_1',
    '--account',
    'claude-a',
    '--model',
    'opus',
  ]);

  assert.deepEqual(calls.send, [
    {
      provider: 'claude',
      message: 'Continue',
      mode: 'read',
      workItemId: 'work_1',
      cwd: '/workspace/acme-web',
      accountId: 'claude-a',
      model: 'opus',
    },
  ]);
});

test('forwards account selection for chat', async () => {
  const { core, calls } = fakeCore();
  const io = memoryIo();

  await createCli(core, io).parseAsync([
    'node',
    'relay',
    'chat',
    'claude',
    '--work-item',
    'work_1',
    '--account',
    'claude-a',
  ]);

  assert.deepEqual(calls.chat, [
    [
      'claude',
      {
        workItemId: 'work_1',
        cwd: '/workspace/acme-web',
        accountId: 'claude-a',
      },
    ],
  ]);
});

test('manages account and caller-supplied weekly usage without listing profile paths', async () => {
  const { core, calls } = fakeCore();
  const io = memoryIo();
  const cli = createCli(core, io);

  await cli.parseAsync([
    'node',
    'relay',
    'account',
    'add',
    'codex',
    'codex-a',
    '--label',
    'Primary',
    '--profile',
    '/profiles/codex-a',
    '--default',
  ]);
  await cli.parseAsync(['node', 'relay', 'accounts', '--json']);
  await cli.parseAsync([
    'node',
    'relay',
    'usage',
    'set',
    'codex-a',
    '--model',
    'gpt-5.6-sol',
    '--remaining-percent',
    '62',
    '--resets-at',
    '2026-08-20T00:00:00Z',
  ]);
  await cli.parseAsync(['node', 'relay', 'usage', '--account', 'codex-a', '--json']);

  assert.deepEqual(calls.addAccount, [
    {
      provider: 'codex',
      id: 'codex-a',
      label: 'Primary',
      profilePath: '/profiles/codex-a',
      status: 'ready',
      maxConcurrency: 1,
      isDefault: true,
    },
  ]);
  assert.deepEqual(calls.recordUsage, [
    {
      accountId: 'codex-a',
      period: 'weekly',
      model: 'gpt-5.6-sol',
      remainingPercent: 62,
      resetsAt: '2026-08-20T00:00:00.000Z',
      source: 'manual',
    },
  ]);
  assert.equal(io.stdout.includes('/profiles/codex-a'), false);
  assert.match(io.stdout, /"accountId": "codex-a"/);
});

test('rejects blank remaining usage percentages before recording a snapshot', async () => {
  const { core, calls } = fakeCore();
  const io = memoryIo();

  await assert.rejects(
    createCli(core, io).parseAsync([
      'node',
      'relay',
      'usage',
      'set',
      'codex-a',
      '--model',
      'gpt-5.6-sol',
      '--remaining-percent',
      ' \t ',
    ]),
    /--remaining-percent must be a finite number from 0 through 100/,
  );
  assert.deepEqual(calls.recordUsage, []);
});

test('forwards explicit account and model selection when delegating', async () => {
  const { core, calls } = fakeCore();
  const io = memoryIo();

  await createCli(core, io).parseAsync([
    'node',
    'relay',
    'delegate',
    'codex',
    'Implement it',
    '--account',
    'codex-a',
    '--model',
    'gpt-5.6-sol',
  ]);

  assert.deepEqual(calls.delegate, [
    {
      provider: 'codex',
      task: 'Implement it',
      cwd: '/workspace/acme-web',
      mode: 'write',
      accountId: 'codex-a',
      model: 'gpt-5.6-sol',
    },
  ]);
});

test('forwards ordered skill selections from delegate and handoff commands', async () => {
  const { core, calls } = fakeCore();
  const io = memoryIo();
  const cli = createCli(core, io);

  await cli.parseAsync([
    'node',
    'relay',
    'delegate',
    'codex',
    'Implement it',
    '--skill',
    'write-tests',
    '--skill',
    'review-security',
  ]);
  await cli.parseAsync([
    'node',
    'relay',
    'handoff',
    'claude',
    'Review it',
    '--work-item',
    'work_1',
    '--skill',
    'review-security',
  ]);

  assert.deepEqual(calls.delegate[0], {
    provider: 'codex',
    task: 'Implement it',
    cwd: '/workspace/acme-web',
    mode: 'write',
    skills: ['write-tests', 'review-security'],
  });
  assert.deepEqual(calls.handoff, [
    {
      provider: 'claude',
      instruction: 'Review it',
      mode: 'read',
      workItemId: 'work_1',
      cwd: '/workspace/acme-web',
      skills: ['review-security'],
    },
  ]);
});

test('allows shortcut skills only when explicitly starting a new WorkItem', async () => {
  const { core, calls } = fakeCore();
  const io = memoryIo();

  await createCli(core, io).parseAsync([
    'node',
    'relay',
    'claude',
    'Review auth',
    '--new',
    '--skill',
    'review-security',
  ]);
  assert.deepEqual(calls.delegate, [
    {
      provider: 'claude',
      task: 'Review auth',
      cwd: '/workspace/acme-web',
      mode: 'read',
      skills: ['review-security'],
    },
  ]);

  await assert.rejects(
    createCli(core, io).parseAsync([
      'node',
      'relay',
      'claude',
      'Continue',
      '--skill',
      'review-security',
    ]),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'invalid_argument',
  );
  assert.deepEqual(calls.send, []);
});

test('lands only the WorkItem integration branch through the landing coordinator', async () => {
  const { core, calls } = fakeCore();
  const io = memoryIo();

  await createCli(core, io).parseAsync([
    'node',
    'relay',
    'land',
    'run_1',
    '--json',
  ]);

  assert.deepEqual(calls.land, ['run_1']);
  assert.deepEqual(calls.merge, []);
  assert.deepEqual(JSON.parse(io.stdout), {
    runId: 'run_1',
    status: 'landed',
    stagingBranch: 'relay/stage/run_1-deadbeef',
    stagingSha: sha,
    landedSha: 'a'.repeat(40),
  });
});

test('plain REPL text goes to the selected provider and current WorkItem', async () => {
  const { core, calls } = fakeCore();
  const io = memoryIo({ lines: ['/use claude', 'Add tests', '/quit'] });

  await runRepl(core, io);

  assert.deepEqual(calls.send, [
    {
      provider: 'claude',
      message: 'Add tests',
      workItemId: 'current',
      cwd: '/workspace/acme-web',
    },
  ]);
});

test('REPL handoff keeps the selected provider explicit', async () => {
  const { core } = fakeCore({
    handoff: async (input) => {
      assert.deepEqual(input, {
        provider: 'codex' satisfies ProviderName,
        instruction: 'Add edge cases',
        workItemId: 'current',
        cwd: '/workspace/acme-web',
      });
      return { run: { status: 'running' } } as never;
    },
  });
  const io = memoryIo({ lines: ['/handoff codex Add edge cases', '/quit'] });

  await runRepl(core, io);
});

test('REPL forwards explicit ordered skills for new work and handoff', async () => {
  const { core, calls } = fakeCore();
  const io = memoryIo({
    lines: [
      '/new claude --skill review-security --skill write-tests -- Review auth',
      '/handoff codex --skill write-tests -- Add edge cases',
      '/quit',
    ],
  });

  await runRepl(core, io);

  assert.deepEqual(calls.delegate, [
    {
      provider: 'claude',
      task: 'Review auth',
      cwd: '/workspace/acme-web',
      mode: 'write',
      skills: ['review-security', 'write-tests'],
    },
  ]);
  assert.deepEqual(calls.handoff, [
    {
      provider: 'codex',
      instruction: 'Add edge cases',
      workItemId: 'current',
      cwd: '/workspace/acme-web',
      skills: ['write-tests'],
    },
  ]);
});

test('REPL merge binds approval to the pull request and SHA it displayed', async () => {
  const { core, calls } = fakeCore();
  const io = memoryIo({ lines: ['/merge squash', 'yes', '/quit'] });

  await runRepl(core, io);

  assert.deepEqual(calls.merge, [
    {
      workItemId: 'current',
      cwd: '/workspace/acme-web',
      strategy: 'squash',
      approved: true,
      pullRequest: 143,
      expectedSha: sha,
    },
  ]);
});
