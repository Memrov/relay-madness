import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'node:test';

import { RelayError } from '../src/errors.js';
import { GitHubClient } from '../src/github-client.js';
import type {
  AttachInput,
  AuthStatus,
  CloudProvider,
  InspectRunInput,
  ProviderCapabilities,
  ProviderExecution,
  ProviderInspection,
  ProviderName,
  ProviderRunStatus,
  SendRunInput,
  StartRunInput,
} from '../src/provider.js';
import { ProcessRunner } from '../src/process-runner.js';
import { RelayCore } from '../src/relay-core.js';
import { StateStore } from '../src/state-store.js';

const roots: string[] = [];
const stores: StateStore[] = [];
const fixtureBin = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'bin',
);

class FakeProvider implements CloudProvider {
  readonly starts: StartRunInput[] = [];
  readonly sends: SendRunInput[] = [];
  readonly inspections: InspectRunInput[] = [];
  startStatus: ProviderRunStatus = 'running';
  sendStatus: ProviderRunStatus = 'running';

  constructor(readonly name: ProviderName) {}

  async capabilities(): Promise<ProviderCapabilities> {
    return {
      start: true,
      structuredStart: true,
      queueFollowup: this.name !== 'codex',
      interactiveAttach: true,
      structuredStatus: true,
      events: this.name === 'jules',
      selectBranch: this.name !== 'claude',
      publishPullRequest: this.name === 'jules',
      cancel: false,
      subscriptionAuth: this.name !== 'jules',
    };
  }

  async authStatus(): Promise<AuthStatus> {
    return { authenticated: true, method: 'fake' };
  }

  async start(input: StartRunInput): Promise<ProviderExecution> {
    this.starts.push(input);
    return {
      providerSessionId: `${this.name}_session_${this.starts.length}`,
      status: this.startStatus,
      url: `https://example.test/${this.name}/${this.starts.length}`,
    };
  }

  async send(input: SendRunInput): Promise<ProviderExecution> {
    this.sends.push(input);
    return {
      providerSessionId: input.providerSessionId,
      status: this.sendStatus,
    };
  }

  async inspect(input: InspectRunInput): Promise<ProviderInspection> {
    this.inspections.push(input);
    return { status: this.startStatus };
  }

  async attach(_input: AttachInput): Promise<number> {
    return 0;
  }
}

async function relayHarness(
  options: {
    githubScenario?: string;
    providerStatus?: ProviderRunStatus;
    storePrompts?: boolean;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'relay-core-test-'));
  roots.push(root);
  const store = StateStore.open(join(root, 'state', 'relay.db'));
  stores.push(store);
  const env = {
    PATH: `${fixtureBin}:${process.env.PATH ?? ''}`,
    FAKE_GH_SCENARIO: options.githubScenario ?? 'missing',
    FAKE_COMMAND_LOG: join(root, 'gh-commands.jsonl'),
  };
  const claude = new FakeProvider('claude');
  const codex = new FakeProvider('codex');
  const jules = new FakeProvider('jules');
  for (const provider of [claude, codex, jules]) {
    provider.startStatus = options.providerStatus ?? 'running';
  }
  const core = new RelayCore({
    store,
    github: new GitHubClient(new ProcessRunner(), { env }),
    providers: new Map<ProviderName, CloudProvider>([
      ['claude', claude],
      ['codex', codex],
      ['jules', jules],
    ]),
    storePrompts: options.storePrompts ?? true,
  });
  return { core, store, cwd: root, claude, codex, jules };
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test('initializes provider references and passes them into a delegated run', async () => {
  const harness = await relayHarness();
  const project = await harness.core.initialize({
    cwd: harness.cwd,
    providerConfigs: {
      codex: { environmentId: 'env_123' },
      jules: { source: 'sources/github-acme-web' },
    },
  });

  const result = await harness.core.delegate({
    provider: 'codex',
    task: 'Review auth',
    title: 'Auth review',
    cwd: harness.cwd,
    mode: 'read',
  });

  assert.equal(project.repo, 'acme/web');
  assert.equal(harness.codex.starts[0]?.environmentId, 'env_123');
  assert.match(result.workItem.currentBranch ?? '', /^relay\/auth-review-[0-9a-f]{8}$/);
});

test('reuses an active provider session for send', async () => {
  const harness = await relayHarness();
  const delegated = await harness.core.delegate({
    provider: 'claude',
    task: 'Implement auth',
    title: 'Auth',
    cwd: harness.cwd,
    mode: 'read',
  });

  const sent = await harness.core.send({
    provider: 'claude',
    message: 'Add tests',
    workItemId: delegated.workItem.id,
    mode: 'read',
  });

  assert.equal(
    sent.session.providerSessionId,
    delegated.session.providerSessionId,
  );
  assert.equal(harness.claude.starts.length, 1);
  assert.equal(harness.claude.sends.length, 1);
});

test('marks provider completion as awaiting publish until GitHub resolves the branch', async () => {
  const harness = await relayHarness({ providerStatus: 'provider_complete' });

  const result = await harness.core.delegate({
    provider: 'claude',
    task: 'Implement auth',
    title: 'Auth',
    cwd: harness.cwd,
  });

  assert.equal(result.run.status, 'awaiting_publish');
  assert.equal(result.artifact, undefined);
});

test('records a full verified SHA after a provider publishes', async () => {
  const harness = await relayHarness({
    githubScenario: 'published',
    providerStatus: 'provider_complete',
  });

  const result = await harness.core.delegate({
    provider: 'claude',
    task: 'Implement auth',
    title: 'Auth',
    cwd: harness.cwd,
  });

  assert.equal(result.run.status, 'verified');
  assert.equal(result.artifact?.sha, 'b'.repeat(40));
  assert.equal(result.artifact?.pullRequest, 143);
});

test('preserves provider truth when GitHub reconciliation fails', async () => {
  const harness = await relayHarness({
    githubScenario: 'error',
    providerStatus: 'provider_complete',
  });

  await assert.rejects(
    harness.core.delegate({
      provider: 'claude',
      task: 'Implement auth',
      title: 'Auth',
      cwd: harness.cwd,
    }),
    (error: unknown) =>
      error instanceof RelayError && error.code === 'process_failed',
  );

  const workItem = harness.store.getCurrentWorkItem(
    harness.store.getProjectByRepo('acme/web')?.id ?? '',
  );
  assert.ok(workItem);
  const status = harness.store.getStatus(workItem.id);
  assert.equal(status.runs[0]?.status, 'provider_complete');
  assert.equal(status.sessions[0]?.providerSessionId, 'claude_session_1');
  assert.equal(status.sessions[0]?.status, 'active');
});

test('builds a handoff from the reconciled SHA without copying the original prompt', async () => {
  const harness = await relayHarness({
    githubScenario: 'published',
    providerStatus: 'provider_complete',
  });
  const original = await harness.core.delegate({
    provider: 'claude',
    task: 'Implement auth with a secret transcript detail',
    title: 'Auth',
    cwd: harness.cwd,
  });

  const result = await harness.core.handoff({
    provider: 'jules',
    instruction: 'Add edge-case tests',
    workItemId: original.workItem.id,
    mode: 'read',
  });

  assert.match(result.prompt, new RegExp(`Source commit: ${'b'.repeat(40)}`));
  assert.match(result.prompt, /Instruction: Add edge-case tests/);
  assert.doesNotMatch(result.prompt, /secret transcript detail/);
});

test('recovers an expired session by starting a replacement from GitHub state', async () => {
  const harness = await relayHarness({
    githubScenario: 'published',
    providerStatus: 'provider_complete',
  });
  const delegated = await harness.core.delegate({
    provider: 'claude',
    task: 'Implement auth',
    title: 'Auth',
    cwd: harness.cwd,
  });
  harness.store.upsertSession({
    workItemId: delegated.workItem.id,
    provider: 'claude',
    providerSessionId: delegated.session.providerSessionId,
    status: 'expired',
  });

  await harness.core.send({
    provider: 'claude',
    message: 'Fix the integration test',
    workItemId: delegated.workItem.id,
    mode: 'read',
  });

  assert.equal(harness.claude.sends.length, 0);
  assert.equal(harness.claude.starts.length, 2);
  assert.match(harness.claude.starts[1]?.prompt ?? '', /previous provider session expired/i);
  assert.match(harness.claude.starts[1]?.prompt ?? '', new RegExp('b'.repeat(40)));
});

test('derives delegation depth from parent runs and rejects depth three', async () => {
  const harness = await relayHarness();
  const depthZero = await harness.core.delegate({
    provider: 'claude',
    task: 'Root',
    title: 'Lineage',
    cwd: harness.cwd,
    mode: 'read',
  });
  const depthOne = await harness.core.delegate({
    provider: 'jules',
    task: 'First handoff',
    workItemId: depthZero.workItem.id,
    parentRunId: depthZero.run.id,
    mode: 'read',
  });
  const depthTwo = await harness.core.delegate({
    provider: 'claude',
    task: 'Second handoff',
    workItemId: depthZero.workItem.id,
    parentRunId: depthOne.run.id,
    mode: 'read',
  });

  assert.equal(depthTwo.run.delegationDepth, 2);
  await assert.rejects(
    harness.core.delegate({
      provider: 'jules',
      task: 'Recursive loop',
      workItemId: depthZero.workItem.id,
      parentRunId: depthTwo.run.id,
      mode: 'read',
    }),
    (error: unknown) =>
      error instanceof RelayError &&
      error.code === 'delegation_depth_exceeded',
  );
});

test('omits prompts from SQLite when prompt storage is disabled', async () => {
  const harness = await relayHarness({ storePrompts: false });
  const result = await harness.core.delegate({
    provider: 'claude',
    task: 'Private instruction',
    title: 'Private',
    cwd: harness.cwd,
    mode: 'read',
  });

  assert.equal(
    harness.store.getStatus(result.workItem.id).runs[0]?.prompt,
    undefined,
  );
});
