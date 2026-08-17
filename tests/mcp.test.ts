import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Client, InMemoryTransport } from '@modelcontextprotocol/client';

import type { RelayApi } from '../src/app.js';
import { RelayError } from '../src/errors.js';
import { createRelayMcpServer } from '../src/mcp.js';

const sha = 'b'.repeat(40);

function fakeCore() {
  const calls = {
    handoff: [] as unknown[],
    send: [] as unknown[],
    status: 0,
    merge: 0,
    land: [] as string[],
  };
  const workItem = {
    id: 'work_1',
    projectId: 'project_1',
    title: 'Authentication',
    baseBranch: 'main',
    currentBranch: 'relay/auth',
    status: 'in_progress',
    createdAt: '2026-08-16T00:00:00.000Z',
    updatedAt: '2026-08-16T00:00:00.000Z',
  } as const;
  const artifact = {
    id: 'artifact_1',
    workItemId: 'work_1',
    branch: 'relay/auth',
    sha,
    status: 'verified',
    pullRequest: 143,
    checks: 'passing',
    observedAt: '2026-08-16T00:00:00.000Z',
  } as const;
  const result = {
    project: {
      id: 'project_1',
      repo: 'acme/web',
      defaultBranch: 'main',
      locatorPath: '/workspace/acme-web',
      createdAt: '2026-08-16T00:00:00.000Z',
      updatedAt: '2026-08-16T00:00:00.000Z',
    },
    workItem,
    session: {
      id: 'hidden',
      workItemId: 'work_1',
      provider: 'jules',
      providerSessionId: 'must-not-leak',
      status: 'active',
      lastActivityAt: '2026-08-16T00:00:00.000Z',
    },
    run: {
      id: 'run_1',
      sessionId: 'hidden',
      workItemId: 'work_1',
      provider: 'jules',
      type: 'handoff',
      mutationMode: 'read',
      status: 'running',
      correlationId: 'correlation_1',
      delegationDepth: 0,
      startedAt: '2026-08-16T00:00:00.000Z',
    },
    artifact,
  } as const;
  const core = {
    doctor: async () => ({}),
    initialize: async () => result.project,
    delegate: async () => result,
    send: async (input: unknown) => {
      calls.send.push(input);
      return result;
    },
    handoff: async (input: unknown) => {
      calls.handoff.push(input);
      return { ...result, prompt: 'hidden prompt' };
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
            source: 'manual',
            observedAt: '2026-08-16T00:00:00.000Z',
          },
        ],
      },
    ],
    land: async (runId: string) => {
      calls.land.push(runId);
      return {
        runId,
        status: 'landed',
        stagingSha: sha,
        landedSha: 'a'.repeat(40),
      };
    },
    status: async () => {
      calls.status += 1;
      return {
        project: result.project,
        workItem,
        sessions: [result.session],
        runs: [result.run],
        artifact,
      };
    },
    sessions: async () => [],
    providers: async () => ({}),
    reconcile: async () => artifact,
    chat: async () => 0,
    merge: async () => {
      calls.merge += 1;
    },
  } as unknown as RelayApi;
  return { core, calls };
}

async function connectedMcp(core: RelayApi) {
  const server = createRelayMcpServer(core, { cwd: '/workspace/acme-web' });
  const client = new Client({ name: 'relay-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

test('exposes account inspection and integration-only landing without a merge tool', async () => {
  const { core } = fakeCore();
  const { client, close } = await connectedMcp(core);
  try {
    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name).sort(),
      [
        'relay_accounts',
        'relay_delegate',
        'relay_handoff',
        'relay_land',
        'relay_send',
        'relay_status',
      ],
    );
    assert.equal(
      listed.tools.find((tool) => tool.name === 'relay_status')?.annotations
        ?.readOnlyHint,
      true,
    );
    assert.equal(
      listed.tools.find((tool) => tool.name === 'relay_accounts')?.annotations
        ?.readOnlyHint,
      true,
    );
    assert.equal(
      listed.tools.find((tool) => tool.name === 'relay_land')?.annotations
        ?.destructiveHint,
      true,
    );
  } finally {
    await close();
  }
});

test('returns redacted account capacity, leases, and latest usage to MCP clients', async () => {
  const { core } = fakeCore();
  const { client, close } = await connectedMcp(core);
  try {
    const response = await client.callTool({
      name: 'relay_accounts',
      arguments: {},
    });
    assert.deepEqual(response.structuredContent, {
      accounts: [
        {
          id: 'codex-a',
          label: 'Primary',
          provider: 'codex',
          status: 'ready',
          capacity: 1,
          activeLeaseCount: 0,
          latestUsage: [
            {
              model: 'gpt-5.6-sol',
              remainingPercent: 62,
              source: 'manual',
              observedAt: '2026-08-16T00:00:00.000Z',
            },
          ],
        },
      ],
    });
    assert.equal(JSON.stringify(response).includes('profilePath'), false);
  } finally {
    await close();
  }
});

test('lands a candidate through the integration branch without merging main', async () => {
  const { core, calls } = fakeCore();
  const { client, close } = await connectedMcp(core);
  try {
    const response = await client.callTool({
      name: 'relay_land',
      arguments: { runId: 'run_1' },
    });
    assert.deepEqual(response.structuredContent, {
      runId: 'run_1',
      status: 'landed',
      stagingSha: sha,
      landedSha: 'a'.repeat(40),
    });
    assert.deepEqual(calls.land, ['run_1']);
    assert.equal(calls.merge, 0);
  } finally {
    await close();
  }
});

test('routes a handoff through Relay Core without exposing provider IDs', async () => {
  const { core, calls } = fakeCore();
  const { client, close } = await connectedMcp(core);
  try {
    const response = await client.callTool({
      name: 'relay_handoff',
      arguments: {
        provider: 'jules',
        workItem: 'current',
        instruction: 'Add tests',
      },
    });
    assert.deepEqual(response.structuredContent, {
      workItem: 'work_1',
      repo: 'acme/web',
      title: 'Authentication',
      provider: 'jules',
      runId: 'run_1',
      correlationId: 'correlation_1',
      delegationDepth: 0,
      status: 'running',
      branch: 'relay/auth',
      sha,
      pullRequest: 143,
      checks: 'passing',
    });
    assert.equal(JSON.stringify(response).includes('must-not-leak'), false);
    assert.deepEqual(calls.handoff, [
      {
        provider: 'jules',
        instruction: 'Add tests',
        mode: 'read',
        workItemId: 'current',
        cwd: '/workspace/acme-web',
      },
    ]);
  } finally {
    await close();
  }
});

test('returns compact GitHub and provider status', async () => {
  const { core, calls } = fakeCore();
  const { client, close } = await connectedMcp(core);
  try {
    const response = await client.callTool({
      name: 'relay_status',
      arguments: { workItem: 'current' },
    });
    assert.deepEqual(response.structuredContent, {
      workItem: 'work_1',
      repo: 'acme/web',
      title: 'Authentication',
      status: 'in_progress',
      branch: 'relay/auth',
      sha,
      pullRequest: 143,
      checks: 'passing',
      providers: { jules: 'active' },
    });
    assert.equal(calls.status, 1);
  } finally {
    await close();
  }
});

test('reports the reusable provider session instead of a failed replacement', async () => {
  const { core } = fakeCore();
  const originalStatus = core.status;
  const coreWithHistory = {
    ...core,
    status: async (...args: Parameters<RelayApi['status']>) => {
      const status = await originalStatus(...args);
      return {
        ...status,
        sessions: [
          ...status.sessions,
          {
            ...status.sessions[0]!,
            id: 'failed-replacement',
            providerSessionId: 'hidden-failed-id',
            status: 'failed' as const,
            lastActivityAt: '2026-08-16T00:01:00.000Z',
          },
        ],
      };
    },
  } as RelayApi;
  const { client, close } = await connectedMcp(coreWithHistory);
  try {
    const response = await client.callTool({
      name: 'relay_status',
      arguments: { workItem: 'current' },
    });
    assert.deepEqual(
      (response.structuredContent as { providers?: unknown }).providers,
      { jules: 'active' },
    );
  } finally {
    await close();
  }
});

test('rejects unknown input fields before reaching Relay Core', async () => {
  const { core, calls } = fakeCore();
  const { client, close } = await connectedMcp(core);
  try {
    const response = await client.callTool({
      name: 'relay_status',
      arguments: { workItem: 'current', merge: true },
    });
    assert.equal(response.isError, true);
    assert.equal(calls.status, 0);
  } finally {
    await close();
  }
});

test('forwards handoff account and model selection through Relay Core', async () => {
  const { core, calls } = fakeCore();
  const { client, close } = await connectedMcp(core);
  try {
    const response = await client.callTool({
      name: 'relay_handoff',
      arguments: {
        provider: 'jules',
        workItem: 'current',
        instruction: 'Review it',
        account: 'jules-a',
        model: 'jules-latest',
      },
    });
    assert.equal(response.isError, undefined);
    assert.deepEqual(calls.handoff, [
      {
        provider: 'jules',
        instruction: 'Review it',
        mode: 'read',
        workItemId: 'current',
        cwd: '/workspace/acme-web',
        accountId: 'jules-a',
        model: 'jules-latest',
      },
    ]);
  } finally {
    await close();
  }
});

test('forwards send account and model selection through Relay Core', async () => {
  const { core, calls } = fakeCore();
  const { client, close } = await connectedMcp(core);
  try {
    await client.callTool({
      name: 'relay_send',
      arguments: {
        provider: 'jules',
        workItem: 'work_1',
        message: 'Continue',
        account: 'jules-a',
        model: 'gemini-2.5-pro',
      },
    });

    assert.deepEqual(calls.send, [
      {
        provider: 'jules',
        message: 'Continue',
        mode: 'read',
        workItemId: 'work_1',
        cwd: '/workspace/acme-web',
        accountId: 'jules-a',
        model: 'gemini-2.5-pro',
      },
    ]);
  } finally {
    await close();
  }
});

test('rejects unknown delegate, handoff, and landing fields before reaching Relay Core', async () => {
  const { core, calls } = fakeCore();
  const { client, close } = await connectedMcp(core);
  try {
    const rejectedDelegate = await client.callTool({
      name: 'relay_delegate',
      arguments: {
        provider: 'codex',
        task: 'Implement it',
        unknown: true,
      },
    });
    const rejected = await client.callTool({
      name: 'relay_handoff',
      arguments: {
        provider: 'jules',
        workItem: 'current',
        instruction: 'Review it',
        unknown: true,
      },
    });
    const rejectedLand = await client.callTool({
      name: 'relay_land',
      arguments: { runId: 'run_1', merge: true },
    });
    assert.equal(rejectedDelegate.isError, true);
    assert.equal(rejected.isError, true);
    assert.equal(rejectedLand.isError, true);
    assert.deepEqual(calls.handoff, []);
    assert.deepEqual(calls.land, []);
  } finally {
    await close();
  }
});

test('returns only allowlisted MCP error fields without subprocess diagnostics', async () => {
  const { core } = fakeCore();
  const throwingCore = {
    ...core,
    send: async () => {
      throw new RelayError(
        'process_failed',
        'Command failed in /private/profiles/claude-a with PLAINTEXT_SECRET and prompt: build auth.',
        {
          profilePath: '/private/profiles/claude-a',
          prompt: 'build auth',
          stdout: 'PLAINTEXT_SECRET',
          stderr: 'PLAINTEXT_SECRET',
          nested: ['PLAINTEXT_SECRET'],
        },
      );
    },
  } as RelayApi;
  const { client, close } = await connectedMcp(throwingCore);
  try {
    const response = await client.callTool({
      name: 'relay_send',
      arguments: {
        provider: 'claude',
        workItem: 'current',
        message: 'Continue',
      },
    });
    assert.equal(response.isError, true);
    assert.equal(response.structuredContent, undefined);
    const text = response.content[0];
    assert.equal(text?.type, 'text');
    if (text?.type !== 'text') assert.fail('Expected text error content.');
    assert.deepEqual(JSON.parse(text.text), {
      error: { code: 'process_failed' },
    });
    assert.equal(text.text.includes('/private/profiles/claude-a'), false);
    assert.equal(text.text.includes('PLAINTEXT_SECRET'), false);
    assert.equal(text.text.includes('build auth'), false);
  } finally {
    await close();
  }
});

test('returns candidate lifecycle details in MCP status', async () => {
  const { core } = fakeCore();
  const coreWithCandidate = {
    ...core,
    status: async () => ({
      ...(await core.status({ workItemId: 'current' })),
      candidates: [
        {
          id: 'run_1',
          runId: 'run_1',
          workItemId: 'work_1',
          status: 'staged' as const,
          sourceBranch: 'relay/run/auth-run_1',
          sourceSha: 'c'.repeat(40),
          baseSha: 'd'.repeat(40),
          integrationBranch: 'relay/work/auth',
          stagingBranch: 'relay/stage/run_1',
          stagingSha: 'e'.repeat(40),
          conflictFiles: [],
          createdAt: '2026-08-16T00:00:00.000Z',
          updatedAt: '2026-08-16T00:00:00.000Z',
        },
      ],
    }),
  } as RelayApi;
  const { client, close } = await connectedMcp(coreWithCandidate);
  try {
    const response = await client.callTool({
      name: 'relay_status',
      arguments: { workItem: 'current' },
    });
    assert.deepEqual(
      (response.structuredContent as { candidates?: unknown }).candidates,
      [
        {
          runId: 'run_1',
          status: 'staged',
          sourceBranch: 'relay/run/auth-run_1',
          sourceSha: 'c'.repeat(40),
          baseSha: 'd'.repeat(40),
          integrationBranch: 'relay/work/auth',
          stagingBranch: 'relay/stage/run_1',
          stagingSha: 'e'.repeat(40),
          conflictFiles: [],
        },
      ],
    );
  } finally {
    await close();
  }
});
