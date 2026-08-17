import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RelayError } from '../src/errors.js';
import { JulesProvider } from '../src/providers/jules.js';

interface CapturedRequest {
  url: string;
  method: string;
  headers: Headers;
  body: string;
}

interface FakeResponse {
  status: number;
  body: unknown;
}

function julesWithResponses(responses: readonly FakeResponse[], apiKey = 'test-key') {
  const queue = [...responses];
  const requests: CapturedRequest[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push({
      url: request.url,
      method: request.method,
      headers: request.headers,
      body: await request.text(),
    });
    const next = queue.shift();
    assert.ok(next, 'The Jules test received an unexpected HTTP request.');
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { 'content-type': 'application/json' },
    });
  };

  return {
    provider: new JulesProvider({
      fetch: fakeFetch,
      apiKey: () => (apiKey === '' ? undefined : apiKey),
    }),
    requests,
  };
}

const queuedSession = {
  name: 'sessions/1234567',
  id: 'abc123',
  prompt: 'Add tests',
  title: 'Tests',
  state: 'QUEUED',
  url: 'https://jules.google.com/session/abc123',
  createTime: '2026-08-16T12:00:00Z',
  updateTime: '2026-08-16T12:00:00Z',
};

test('creates an AUTO_CREATE_PR session without persisting its API key', async () => {
  const { provider, requests } = julesWithResponses([
    { status: 200, body: queuedSession },
  ]);

  const result = await provider.start({
    prompt: 'Add tests',
    title: 'Tests',
    repo: 'acme/web',
    cwd: '/tmp',
    branch: 'main',
    source: 'sources/github-acme-web',
    mode: 'write',
  });

  assert.deepEqual(result, {
    providerSessionId: 'sessions/1234567',
    status: 'queued',
    url: 'https://jules.google.com/session/abc123',
  });
  assert.equal(requests[0]?.headers.get('x-goog-api-key'), 'test-key');
  assert.deepEqual(JSON.parse(requests[0]?.body ?? ''), {
    prompt: 'Add tests',
    title: 'Tests',
    sourceContext: {
      source: 'sources/github-acme-web',
      githubRepoContext: { startingBranch: 'main' },
    },
    requirePlanApproval: false,
    automationMode: 'AUTO_CREATE_PR',
  });
});

test('sends a follow-up with the documented prompt body', async () => {
  const { provider, requests } = julesWithResponses([
    { status: 200, body: {} },
  ]);

  const result = await provider.send!({
    providerSessionId: 'sessions/1234567',
    message: 'Add edge cases',
    cwd: '/tmp',
  });

  assert.equal(
    requests[0]?.url,
    'https://jules.googleapis.com/v1alpha/sessions/1234567:sendMessage',
  );
  assert.deepEqual(JSON.parse(requests[0]?.body ?? ''), {
    prompt: 'Add edge cases',
  });
  assert.deepEqual(result, {
    providerSessionId: 'sessions/1234567',
    status: 'running',
  });
});

test('maps completed session output to a pull request artifact', async () => {
  const { provider } = julesWithResponses([
    {
      status: 200,
      body: {
        ...queuedSession,
        state: 'COMPLETED',
        outputs: [
          {
            pullRequest: {
              url: 'https://github.com/acme/web/pull/42',
              title: 'Add tests',
              description: 'Added test coverage',
            },
          },
        ],
      },
    },
  ]);

  const inspected = await provider.inspect!({
    providerSessionId: 'sessions/1234567',
  });

  assert.deepEqual(inspected, {
    status: 'provider_complete',
    url: 'https://jules.google.com/session/abc123',
    artifact: {
      pullRequestUrl: 'https://github.com/acme/web/pull/42',
      pullRequest: 42,
    },
  });
});

test('does not invent an artifact when a completed session has no pull request', async () => {
  const { provider } = julesWithResponses([
    { status: 200, body: { ...queuedSession, state: 'COMPLETED', outputs: [] } },
  ]);

  assert.deepEqual(
    await provider.inspect!({ providerSessionId: 'sessions/1234567' }),
    {
      status: 'provider_complete',
      url: 'https://jules.google.com/session/abc123',
    },
  );
});

test('approves plans and lists activities through official endpoints', async () => {
  const { provider, requests } = julesWithResponses([
    { status: 200, body: {} },
    {
      status: 200,
      body: {
        activities: [
          {
            name: 'sessions/1234567/activities/act1',
            id: 'act1',
            originator: 'agent',
            description: 'Plan generated',
            planGenerated: {
              plan: {
                id: 'plan1',
                steps: [
                  {
                    id: 'step1',
                    index: 0,
                    title: 'Inspect',
                    description: 'Inspect the repository',
                  },
                ],
                createTime: '2026-08-16T12:01:00Z',
              },
            },
            createTime: '2026-08-16T12:01:00Z',
          },
        ],
      },
    },
  ]);

  await provider.approvePlan('sessions/1234567');
  const activities = await provider.listActivities('sessions/1234567');

  assert.match(requests[0]?.url ?? '', /sessions\/1234567:approvePlan$/);
  assert.match(requests[1]?.url ?? '', /sessions\/1234567\/activities\?pageSize=100$/);
  assert.equal(activities[0]?.description, 'Plan generated');
});

test('reports missing API-key authentication without making a request', async () => {
  const { provider, requests } = julesWithResponses([], '');

  assert.deepEqual(await provider.authStatus(), {
    authenticated: false,
    detail: 'JULES_API_KEY is not set.',
  });
  assert.equal(requests.length, 0);
  await assert.rejects(
    provider.start({ prompt: 'x', cwd: '/tmp', mode: 'write' }),
    (error: unknown) =>
      error instanceof RelayError && error.code === 'configuration_missing',
  );
});

test('reports the documented Jules capabilities', async () => {
  const { provider } = julesWithResponses([]);

  assert.deepEqual(await provider.capabilities(), {
    start: true,
    structuredStart: true,
    queueFollowup: true,
    interactiveAttach: false,
    structuredStatus: true,
    events: true,
    selectBranch: true,
    publishPullRequest: true,
    cancel: false,
    subscriptionAuth: false,
    selectModel: false,
    profileIsolation: false,
  });
});
