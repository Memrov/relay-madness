import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Client, InMemoryTransport } from '@modelcontextprotocol/client';

import type { RelayApi } from '../src/app.js';
import { RelayError } from '../src/errors.js';
import { createRelayMcpServer } from '../src/mcp.js';

const sha = 'b'.repeat(40);

function fakeCore() {
  const calls = { handoff: 0, status: 0 };
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
    send: async () => result,
    handoff: async () => {
      calls.handoff += 1;
      return { ...result, prompt: 'hidden prompt' };
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
    merge: async () => {},
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

test('exposes exactly the four non-merge tools', async () => {
  const { core } = fakeCore();
  const { client, close } = await connectedMcp(core);
  try {
    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name).sort(),
      ['relay_delegate', 'relay_handoff', 'relay_send', 'relay_status'],
    );
    assert.equal(
      listed.tools.find((tool) => tool.name === 'relay_status')?.annotations
        ?.readOnlyHint,
      true,
    );
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
    assert.equal(calls.handoff, 1);
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

test('returns typed, redacted Relay errors to MCP clients', async () => {
  const { core } = fakeCore();
  const throwingCore = {
    ...core,
    send: async () => {
      throw new RelayError('work_item_locked', 'WorkItem is busy.', {
        apiToken: 'must-not-leak',
      });
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
      error: {
        code: 'work_item_locked',
        message: 'WorkItem is busy.',
        details: { apiToken: '[REDACTED]' },
      },
    });
  } finally {
    await close();
  }
});
