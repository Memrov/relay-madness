import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createCli,
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
  initialize: unknown[];
}

function fakeCore(overrides: Partial<RelayApi> = {}): {
  core: RelayApi;
  calls: CoreCalls;
} {
  const calls: CoreCalls = { merge: [], send: [], delegate: [], initialize: [] };
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
        jules: {
          auth: { authenticated: false, detail: 'missing key' },
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
    handoff: async () => ({ run: { status: 'running' } }),
    status: async () => statusFixture,
    sessions: async () => [],
    providers: async () => ({}),
    reconcile: async () => statusFixture.artifact,
    chat: async () => 0,
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

test('doctor reports each dependency independently', async () => {
  const { core } = fakeCore();
  const io = memoryIo();

  await createCli(core, io).parseAsync(['node', 'relay', 'doctor']);

  assert.match(io.stdout, /GitHub\s+✓/);
  assert.match(io.stdout, /Claude\s+✗/);
  assert.match(io.stdout, /Codex\s+✓/);
  assert.match(io.stdout, /Jules\s+✗/);
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
    '--jules-source',
    'sources/github-acme-web',
  ]);

  assert.deepEqual(calls.initialize, [
    {
      cwd: '/workspace/acme-web',
      providerConfigs: {
        codex: { environmentId: 'env_123' },
        jules: { source: 'sources/github-acme-web' },
      },
    },
  ]);
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
        provider: 'jules' satisfies ProviderName,
        instruction: 'Add edge cases',
        workItemId: 'current',
        cwd: '/workspace/acme-web',
      });
      return { run: { status: 'running' } } as never;
    },
  });
  const io = memoryIo({ lines: ['/handoff jules Add edge cases', '/quit'] });

  await runRepl(core, io);
});
