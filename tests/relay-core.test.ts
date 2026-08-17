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
  onStart?: (input: StartRunInput) => void;

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
      selectModel: this.name !== 'jules',
      profileIsolation: this.name !== 'jules',
    };
  }

  async authStatus(): Promise<AuthStatus> {
    return { authenticated: true, method: 'fake' };
  }

  async start(input: StartRunInput): Promise<ProviderExecution> {
    this.starts.push(input);
    this.onStart?.(input);
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
  const env: NodeJS.ProcessEnv = {
    PATH: `${fixtureBin}:${process.env.PATH ?? ''}`,
    FAKE_GH_SCENARIO: options.githubScenario ?? 'missing',
    FAKE_COMMAND_LOG: join(root, 'gh-commands.jsonl'),
  };
  const claude = new FakeProvider('claude');
  const codex = new FakeProvider('codex');
  const jules = new FakeProvider('jules');
  for (const provider of [claude, codex, jules]) {
    provider.startStatus = options.providerStatus ?? 'running';
    provider.onStart = (input) => {
      env.FAKE_GH_BRANCH = input.branch;
    };
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
  return {
    core,
    store,
    cwd: root,
    claude,
    codex,
    jules,
    setGithubScenario(scenario: string) {
      env.FAKE_GH_SCENARIO = scenario;
    },
    setGithubBranch(branch: string | undefined) {
      env.FAKE_GH_BRANCH = branch;
    },
  };
}

function addAccount(
  store: StateStore,
  input: {
    id: string;
    provider: ProviderName;
    isDefault?: boolean;
    maxConcurrency?: number;
    model?: string;
  },
): void {
  store.upsertProviderAccount({
    id: input.id,
    provider: input.provider,
    label: input.id,
    profilePath: `/profiles/${input.id}`,
    status: 'ready',
    maxConcurrency: input.maxConcurrency ?? 1,
    isDefault: input.isDefault ?? false,
  });
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
  assert.equal(result.workItem.currentBranch, 'main');
});

test('binds an explicit account and its configured model to provider execution', async () => {
  const harness = await relayHarness({ githubScenario: 'published' });
  const project = await harness.core.initialize({ cwd: harness.cwd });
  addAccount(harness.store, { id: 'codex-a', provider: 'codex' });
  harness.store.setProviderAccountConfig(project.id, 'codex-a', {
    environmentId: 'env-codex-a',
    model: 'gpt-5.6-sol',
  });

  const result = await harness.core.delegate({
    provider: 'codex',
    accountId: 'codex-a',
    task: 'Build it',
    title: 'Account scope',
    cwd: harness.cwd,
    mode: 'read',
  });

  assert.equal(result.session.accountId, 'codex-a');
  assert.equal(result.run.accountId, 'codex-a');
  assert.equal(result.run.model, 'gpt-5.6-sol');
  assert.equal(harness.codex.starts[0]?.profilePath, '/profiles/codex-a');
  assert.equal(harness.codex.starts[0]?.model, 'gpt-5.6-sol');
  assert.equal(harness.codex.starts[0]?.environmentId, 'env-codex-a');
});

test('rejects an explicit account registered to another provider', async () => {
  const harness = await relayHarness();
  await harness.core.initialize({ cwd: harness.cwd });
  addAccount(harness.store, { id: 'claude-a', provider: 'claude' });

  await assert.rejects(
    harness.core.delegate({
      provider: 'codex',
      accountId: 'claude-a',
      task: 'Build it',
      title: 'Provider mismatch',
      cwd: harness.cwd,
    }),
    (error: unknown) =>
      error instanceof RelayError && error.code === 'provider_mismatch',
  );
});

test('uses only the configured default account when an account is omitted', async () => {
  const harness = await relayHarness({ githubScenario: 'published' });
  const project = await harness.core.initialize({ cwd: harness.cwd });
  addAccount(harness.store, { id: 'claude-a', provider: 'claude' });
  addAccount(harness.store, {
    id: 'claude-default',
    provider: 'claude',
    isDefault: true,
  });
  harness.store.setProviderAccountConfig(project.id, 'claude-default', {
    model: 'opus',
  });

  const result = await harness.core.delegate({
    provider: 'claude',
    task: 'Build it',
    title: 'Default account',
    cwd: harness.cwd,
    mode: 'read',
  });

  assert.equal(result.session.accountId, 'claude-default');
  assert.equal(result.run.model, 'opus');
  assert.equal(harness.claude.starts[0]?.profilePath, '/profiles/claude-default');
});

test('scopes provider sessions by account and prevents a follow-up from switching accounts', async () => {
  const harness = await relayHarness({ githubScenario: 'published' });
  await harness.core.initialize({ cwd: harness.cwd });
  addAccount(harness.store, { id: 'claude-a', provider: 'claude' });
  addAccount(harness.store, { id: 'claude-b', provider: 'claude' });
  const first = await harness.core.delegate({
    provider: 'claude',
    accountId: 'claude-a',
    task: 'First',
    title: 'Scoped sessions',
    cwd: harness.cwd,
    mode: 'read',
  });
  const second = await harness.core.delegate({
    provider: 'claude',
    accountId: 'claude-b',
    task: 'Second',
    workItemId: first.workItem.id,
    mode: 'read',
  });

  assert.notEqual(first.session.id, second.session.id);
  assert.equal(first.session.accountId, 'claude-a');
  assert.equal(second.session.accountId, 'claude-b');
});

test('does not let a follow-up select a different account than its active session', async () => {
  const harness = await relayHarness({ githubScenario: 'published' });
  harness.claude.startStatus = 'provider_complete';
  await harness.core.initialize({ cwd: harness.cwd });
  addAccount(harness.store, { id: 'claude-a', provider: 'claude' });
  addAccount(harness.store, { id: 'claude-b', provider: 'claude' });
  const first = await harness.core.delegate({
    provider: 'claude',
    accountId: 'claude-a',
    task: 'First',
    title: 'Sticky follow-up',
    cwd: harness.cwd,
    mode: 'read',
  });
  await assert.rejects(
    harness.core.send({
      provider: 'claude',
      accountId: 'claude-b',
      message: 'Continue',
      workItemId: first.workItem.id,
    }),
    (error: unknown) =>
      error instanceof RelayError && error.code === 'provider_mismatch',
  );
  const continued = await harness.core.send({
    provider: 'claude',
    message: 'Continue on the original account',
    workItemId: first.workItem.id,
  });
  assert.equal(continued.session.accountId, 'claude-a');
  assert.equal(harness.claude.sends.length, 1);
});

test('allows parallel writers only on distinct run branches', async () => {
  const harness = await relayHarness({ githubScenario: 'no-pr' });
  await harness.core.initialize({ cwd: harness.cwd });
  addAccount(harness.store, { id: 'codex-a', provider: 'codex' });
  addAccount(harness.store, { id: 'codex-b', provider: 'codex' });
  const workItem = harness.store.createWorkItem({
    projectId: harness.store.getProjectByRepo('acme/web')!.id,
    title: 'Parallel writers',
    baseBranch: 'main',
    currentBranch: 'relay/work/parallel-writers',
  });

  const [a, b] = await Promise.all([
    harness.core.delegate({
      provider: 'codex',
      accountId: 'codex-a',
      task: 'A',
      workItemId: workItem.id,
      mode: 'write',
    }),
    harness.core.delegate({
      provider: 'codex',
      accountId: 'codex-b',
      task: 'B',
      workItemId: workItem.id,
      mode: 'write',
    }),
  ]);

  assert.notEqual(a.run.expectedBranch, b.run.expectedBranch);
  assert.match(a.run.expectedBranch ?? '', /^relay\/run\//);
  assert.equal(a.run.baseSha, b.run.baseSha);
});

test('releases account capacity only after the provider reaches a terminal state', async () => {
  const harness = await relayHarness({ githubScenario: 'published' });
  await harness.core.initialize({ cwd: harness.cwd });
  addAccount(harness.store, { id: 'claude-a', provider: 'claude' });
  const first = await harness.core.delegate({
    provider: 'claude',
    accountId: 'claude-a',
    task: 'First',
    title: 'Capacity',
    cwd: harness.cwd,
    mode: 'write',
  });

  await assert.rejects(
    harness.core.delegate({
      provider: 'claude',
      accountId: 'claude-a',
      task: 'Second',
      workItemId: first.workItem.id,
      mode: 'write',
    }),
    (error: unknown) =>
      error instanceof RelayError && error.code === 'account_at_capacity',
  );

  harness.claude.startStatus = 'provider_complete';
  await harness.core.status({ workItemId: first.workItem.id });
  await harness.core.delegate({
    provider: 'claude',
    accountId: 'claude-a',
    task: 'Second',
    workItemId: first.workItem.id,
    mode: 'write',
  });
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
    providerStatus: 'provider_complete',
  });
  harness.claude.onStart = (input) => {
    harness.setGithubBranch(input.branch);
    harness.setGithubScenario('published');
  };

  const result = await harness.core.delegate({
    provider: 'claude',
    task: 'Implement auth',
    title: 'Auth',
    cwd: harness.cwd,
  });

  assert.equal(result.run.status, 'verified');
  assert.equal(result.artifact?.sha, 'b'.repeat(40));
  assert.equal(result.artifact?.pullRequest, 143);
  assert.equal(result.artifact?.status, 'verified');
});

test('credits a completed isolated result branch even when its commit equals the base SHA', async () => {
  const harness = await relayHarness({
    githubScenario: 'published',
    providerStatus: 'provider_complete',
  });

  const result = await harness.core.delegate({
    provider: 'claude',
    task: 'Implement auth',
    title: 'Auth',
    cwd: harness.cwd,
    mode: 'write',
  });

  assert.equal(result.run.status, 'verified');
  assert.equal(result.run.baselineSha, 'b'.repeat(40));
  assert.equal(result.run.resultSha, 'b'.repeat(40));
});

test('preserves provider truth when GitHub reconciliation fails', async () => {
  const harness = await relayHarness({
    providerStatus: 'provider_complete',
  });
  harness.claude.onStart = (input) => {
    harness.setGithubBranch(input.branch);
    harness.setGithubScenario('error');
  };

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
  const harness = await relayHarness({ providerStatus: 'provider_complete' });
  harness.claude.onStart = (input) => {
    harness.setGithubBranch(input.branch);
    harness.setGithubScenario('published');
  };
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

test('does not hand off or report a stale artifact after its branch disappears', async () => {
  const harness = await relayHarness({ providerStatus: 'provider_complete' });
  harness.claude.onStart = (input) => {
    harness.setGithubBranch(input.branch);
    harness.setGithubScenario('published');
  };
  const original = await harness.core.delegate({
    provider: 'claude',
    task: 'Implement auth',
    title: 'Auth',
    cwd: harness.cwd,
  });
  harness.setGithubScenario('missing');

  await assert.rejects(
    harness.core.handoff({
      provider: 'jules',
      instruction: 'Review it',
      workItemId: original.workItem.id,
    }),
    (error: unknown) =>
      error instanceof RelayError && error.code === 'not_found',
  );
  const status = await harness.core.status({ workItemId: original.workItem.id });
  assert.equal(status.artifact, undefined);
  assert.equal(status.workItem.currentSha, undefined);
  assert.equal(status.workItem.pullRequest, undefined);
  assert.equal(harness.jules.starts.length, 0);
});

test('reconciles a mutating handoff against its isolated result branch', async () => {
  const harness = await relayHarness({ providerStatus: 'provider_complete' });
  harness.claude.onStart = (input) => {
    harness.setGithubBranch(input.branch);
    harness.setGithubScenario('published');
  };
  const original = await harness.core.delegate({
    provider: 'claude',
    task: 'Implement auth',
    title: 'Auth',
    cwd: harness.cwd,
    mode: 'write',
  });
  const handoff = await harness.core.handoff({
    provider: 'jules',
    instruction: 'Fix the review findings',
    workItemId: original.workItem.id,
    mode: 'write',
  });
  assert.equal(handoff.run.status, 'verified');
  assert.match(handoff.run.expectedBranch ?? '', /^relay\/run\//);

  harness.setGithubScenario('published');
  harness.setGithubBranch(handoff.run.expectedBranch);
  const artifact = await harness.core.reconcile({
    workItemId: original.workItem.id,
  });

  assert.equal(artifact?.branch, handoff.run.expectedBranch);
  assert.equal(artifact?.status, 'verified');
  assert.equal(
    harness.store.getWorkItem(original.workItem.id).currentBranch,
    handoff.run.expectedBranch,
  );
});

test('recovers an expired session by starting a replacement from GitHub state', async () => {
  const harness = await relayHarness({ providerStatus: 'provider_complete' });
  harness.claude.onStart = (input) => {
    harness.setGithubBranch(input.branch);
    harness.setGithubScenario('published');
  };
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

test('persists provider-reported expiration and recovers on the next message', async () => {
  const harness = await relayHarness();
  const delegated = await harness.core.delegate({
    provider: 'claude',
    task: 'Review auth',
    title: 'Auth',
    cwd: harness.cwd,
    mode: 'read',
  });
  harness.claude.startStatus = 'expired';

  await harness.core.status({ workItemId: delegated.workItem.id });
  assert.equal(
    harness.store.getSession(delegated.workItem.id, 'claude')?.status,
    'expired',
  );

  harness.claude.startStatus = 'running';
  await harness.core.send({
    provider: 'claude',
    message: 'Continue the review',
    workItemId: delegated.workItem.id,
  });
  assert.equal(harness.claude.starts.length, 2);
  assert.equal(harness.claude.sends.length, 0);
});

test('releases a completed writer lease even when GitHub reconciliation fails', async () => {
  const harness = await relayHarness();
  const original = await harness.core.delegate({
    provider: 'claude',
    task: 'Implement auth',
    title: 'Auth',
    cwd: harness.cwd,
    mode: 'write',
  });
  harness.claude.startStatus = 'provider_complete';
  harness.setGithubScenario('error');

  await assert.rejects(
    harness.core.status({ workItemId: original.workItem.id }),
    (error: unknown) =>
      error instanceof RelayError && error.code === 'process_failed',
  );

  harness.setGithubScenario('missing');
  await harness.core.delegate({
    provider: 'jules',
    task: 'Continue implementation',
    workItemId: original.workItem.id,
    mode: 'write',
  });
  assert.equal(harness.jules.starts.length, 1);
});

test('starts a replacement writer on a distinct result branch without a WorkItem lease', async () => {
  const harness = await relayHarness();
  const original = await harness.core.delegate({
    provider: 'claude',
    task: 'Implement auth',
    title: 'Auth',
    cwd: harness.cwd,
    mode: 'write',
  });

  const replacement = await harness.core.delegate({
    provider: 'claude',
    task: 'Start over',
    workItemId: original.workItem.id,
    mode: 'write',
  });

  assert.notEqual(replacement.run.expectedBranch, original.run.expectedBranch);
});

test('allows a write follow-up and a different writer on isolated result branches', async () => {
  const harness = await relayHarness();
  const original = await harness.core.delegate({
    provider: 'claude',
    task: 'Implement auth',
    title: 'Auth',
    cwd: harness.cwd,
    mode: 'write',
  });

  await harness.core.send({
    provider: 'claude',
    message: 'Add tests',
    workItemId: original.workItem.id,
    mode: 'write',
  });
  const jules = await harness.core.delegate({
    provider: 'jules',
    task: 'Edit the same branch',
    workItemId: original.workItem.id,
    mode: 'write',
  });
  assert.equal(harness.claude.sends.length, 1);
  assert.equal(harness.jules.starts.length, 1);
  assert.notEqual(jules.run.expectedBranch, original.run.expectedBranch);
});

test('gives readers a pinned commit without instructing them to push', async () => {
  const harness = await relayHarness({ githubScenario: 'published' });

  await harness.core.delegate({
    provider: 'codex',
    task: 'Review auth',
    title: 'Auth review',
    cwd: harness.cwd,
    mode: 'read',
  });

  const prompt = harness.codex.starts[0]?.prompt ?? '';
  assert.match(prompt, new RegExp(`Pinned commit: ${'b'.repeat(40)}`));
  assert.match(prompt, /Do not push or merge/);
  assert.doesNotMatch(prompt, /Push durable code changes/);
});

test('rejects a read result when the pinned branch head moves during inspection', async () => {
  const harness = await relayHarness({
    githubScenario: 'published',
    providerStatus: 'provider_complete',
  });
  harness.codex.onStart = (input) => {
    harness.setGithubBranch(input.branch);
    harness.setGithubScenario('moved');
  };

  await assert.rejects(
    harness.core.delegate({
      provider: 'codex',
      task: 'Review auth',
      title: 'Auth review',
      cwd: harness.cwd,
      mode: 'read',
    }),
    (error: unknown) =>
      error instanceof RelayError && error.code === 'head_moved',
  );
});

test('rejects a read result when its pinned remote branch disappears', async () => {
  const harness = await relayHarness({
    githubScenario: 'published',
    providerStatus: 'provider_complete',
  });
  harness.codex.onStart = () => {
    harness.setGithubScenario('deleted');
  };

  await assert.rejects(
    harness.core.delegate({
      provider: 'codex',
      task: 'Review auth',
      title: 'Pinned deletion',
      cwd: harness.cwd,
      mode: 'read',
    }),
    (error: unknown) =>
      error instanceof RelayError && error.code === 'head_moved',
  );
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
