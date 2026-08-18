import { randomUUID } from 'node:crypto';

import { RelayError } from './errors.js';
import { type GitHubClient, type MergeStrategy } from './github-client.js';
import { buildHandoffPacket, buildRecoveryPrompt } from './handoff.js';
import type {
  AuthStatus,
  CloudProvider,
  MutationMode,
  ProviderCapabilities,
  ProviderExecution,
  ProviderName,
  ProviderRunStatus,
} from './provider.js';
import { SUPPORTED_PROVIDERS } from './provider.js';
import {
  appendSkillPacket,
  type ResolvedSkill,
  type SkillResolver,
} from './skills.js';
import type {
  ArtifactInput,
  ArtifactRecord,
  ProjectRecord,
  ProviderAccountRecord,
  RunRecord,
  RunType,
  SessionRecord,
  StateStore,
  WorkItemRecord,
  WorkItemStatus,
} from './state-store.js';

export interface RelayCoreDependencies {
  store: StateStore;
  github: GitHubClient;
  providers: ReadonlyMap<ProviderName, CloudProvider>;
  skillResolver: SkillResolver;
  storePrompts?: boolean;
  now?: () => Date;
}

export interface InitializeInput {
  cwd: string;
  providerConfigs?: Partial<
    Record<ProviderName, Readonly<Record<string, unknown>>>
  >;
}

export interface DelegateInput {
  provider: ProviderName;
  accountId?: string;
  model?: string;
  task: string;
  title?: string;
  cwd?: string;
  workItemId?: string;
  mode?: MutationMode;
  parentRunId?: string;
  skills?: readonly string[];
}

export interface SendInput {
  provider: ProviderName;
  accountId?: string;
  model?: string;
  message: string;
  workItemId?: string;
  cwd?: string;
  mode?: MutationMode;
  parentRunId?: string;
}

export interface HandoffInput {
  provider: ProviderName;
  accountId?: string;
  model?: string;
  instruction: string;
  workItemId?: string;
  cwd?: string;
  mode?: MutationMode;
  parentRunId?: string;
  skills?: readonly string[];
}

export interface WorkItemSelector {
  workItemId?: string;
  cwd?: string;
}

export interface ChatInput extends WorkItemSelector {
  accountId?: string;
}

export interface MergeRequest extends WorkItemSelector {
  strategy: MergeStrategy;
  approved: boolean;
  pullRequest: number;
  expectedSha: string;
}

export interface ResolveLaunchRequest {
  runId: string;
  confirmed: boolean;
}

export interface RelayRunResult {
  project: ProjectRecord;
  workItem: WorkItemRecord;
  session: SessionRecord;
  run: RunRecord;
  artifact?: ArtifactRecord;
}

export interface RelayStatus extends WorkItemStatus {
  project: ProjectRecord;
}

export interface HandoffResult extends RelayRunResult {
  prompt: string;
}

export interface DoctorProviderReport {
  auth: AuthStatus;
  capabilities: ProviderCapabilities;
}

export interface DoctorReport {
  github: AuthStatus;
  providers: Readonly<Record<ProviderName, DoctorProviderReport>>;
}

interface WorkContext {
  project: ProjectRecord;
  workItem: WorkItemRecord;
}

interface StartExecutionInput {
  provider: ProviderName;
  accountId?: string;
  model?: string;
  prompt: string;
  type: RunType;
  project: ProjectRecord;
  workItem: WorkItemRecord;
  mode: MutationMode;
  parentRunId?: string;
  startBranch: string;
  expectedBranch: string;
  pinnedSha?: string;
  skills: readonly ResolvedSkill[];
}

const ACTIVE_RUN_STATUSES = new Set<ProviderRunStatus>(['queued', 'running']);
const CAPACITY_HOLDING_RUN_STATUSES = new Set<ProviderRunStatus>([
  'queued',
  'running',
  'launch_uncertain',
]);

export class RelayCore {
  private readonly storePrompts: boolean;
  private readonly now: () => Date;

  constructor(private readonly dependencies: RelayCoreDependencies) {
    this.storePrompts = dependencies.storePrompts ?? true;
    this.now = dependencies.now ?? (() => new Date());
  }

  async doctor(): Promise<DoctorReport> {
    const [github, entries] = await Promise.all([
      this.dependencies.github.authStatus(),
      Promise.all(
        SUPPORTED_PROVIDERS.map(async (name) => {
          const provider = this.provider(name);
          return [
            name,
            {
              auth: await provider.authStatus(),
              capabilities: await provider.capabilities(),
            },
          ] as const;
        }),
      ),
    ]);
    return {
      github,
      providers: Object.fromEntries(entries) as DoctorReport['providers'],
    };
  }

  async loginAccount(accountId: string): Promise<ProviderAccountRecord> {
    const account = this.dependencies.store.getProviderAccount(accountId);
    if (account === undefined) {
      throw new RelayError(
        'not_found',
        `Provider account ${accountId} was not found.`,
      );
    }
    const provider = this.provider(account.provider);
    const capabilities = await provider.capabilities();
    if (!capabilities.profileIsolation || provider.loginProfile === undefined) {
      throw new RelayError(
        'capability_unavailable',
        `${account.provider} does not support native profile login.`,
      );
    }
    const auth = await provider.loginProfile(account.profilePath);
    if (!auth.authenticated) {
      this.dependencies.store.markProviderAccountAuthRequired(account.id);
      throw new RelayError(
        'account_unavailable',
        `Provider account ${account.id} is not authenticated.`,
      );
    }
    if (auth.identityFingerprint === undefined) {
      this.dependencies.store.markProviderAccountAuthRequired(account.id);
      throw new RelayError(
        'provider_output_invalid',
        `${account.provider} did not report a verifiable profile identity.`,
      );
    }
    return this.dependencies.store.bindProviderAccountAuth(
      account.id,
      auth.identityFingerprint,
      this.now(),
    );
  }

  async initialize(input: InitializeInput): Promise<ProjectRecord> {
    const detected = await this.dependencies.github.detectProject(input.cwd);
    const project = this.dependencies.store.upsertProject({
      repo: detected.repo,
      defaultBranch: detected.defaultBranch,
      locatorPath: input.cwd,
    });
    if (input.providerConfigs !== undefined) {
      for (const [name, settings] of Object.entries(input.providerConfigs)) {
        if (settings !== undefined) {
          this.dependencies.store.setProviderConfig(
            project.id,
            name as ProviderName,
            settings,
          );
        }
      }
    }
    return this.dependencies.store.getProject(project.id);
  }

  async delegate(input: DelegateInput): Promise<RelayRunResult> {
    const mode = input.mode ?? 'write';
    const context = await this.contextForDelegation(input);
    const skills = await this.resolveSkills(context, input.skills);
    const prompt = buildDelegationPrompt({
      task: input.task,
      project: context.project,
      workItem: context.workItem,
      mode,
    });
    return await this.executeStart({
      provider: input.provider,
      ...(input.accountId === undefined ? {} : { accountId: input.accountId }),
      ...(input.model === undefined ? {} : { model: input.model }),
      prompt,
      type: 'delegation',
      project: context.project,
      workItem: context.workItem,
      mode,
      ...(input.parentRunId === undefined
        ? {}
        : { parentRunId: input.parentRunId }),
      startBranch:
        context.workItem.currentBranch ?? context.workItem.baseBranch,
      expectedBranch:
        context.workItem.currentBranch ?? context.workItem.baseBranch,
      skills,
    });
  }

  async send(input: SendInput): Promise<RelayRunResult> {
    const context = await this.resolveWorkItem(input);
    const route = this.sessionRoute(
      context.workItem.id,
      input.provider,
      input.accountId,
    );
    const selectedAccount = route.account;
    const session = route.session;
    this.assertNoUncertainLaunch(
      context.workItem.id,
      input.provider,
      selectedAccount?.id,
    );
    if (
      session === undefined &&
      input.accountId !== undefined &&
      route.existingScopes > 0
    ) {
      throw new RelayError(
        'provider_mismatch',
        `${input.provider} follow-ups must remain with their original account.`,
      );
    }
    if (session?.status === 'pending') {
      throw new RelayError(
        'work_item_locked',
        `${input.provider} session creation is already in progress for this WorkItem.`,
      );
    }
    if (session === undefined) {
      const mode = input.mode ?? 'read';
      return await this.executeStart({
        provider: input.provider,
        ...(selectedAccount === undefined ? {} : { accountId: selectedAccount.id }),
        ...(input.model === undefined ? {} : { model: input.model }),
        prompt: buildDelegationPrompt({
          task: input.message,
          project: context.project,
          workItem: context.workItem,
          mode,
        }),
        type: 'message',
        project: context.project,
        workItem: context.workItem,
        mode,
        ...(input.parentRunId === undefined
          ? {}
          : { parentRunId: input.parentRunId }),
        startBranch:
          context.workItem.currentBranch ?? context.workItem.baseBranch,
        expectedBranch:
          context.workItem.currentBranch ?? context.workItem.baseBranch,
        skills: [],
      });
    }

    if (session.status === 'expired' || session.status === 'failed') {
      const artifact = await this.reconcile({
        workItemId: context.workItem.id,
      });
      const recoveryPrompt = buildRecoveryPrompt({
        repo: context.project.repo,
        title: context.workItem.title,
        branch:
          context.workItem.currentBranch ?? context.workItem.baseBranch,
        instruction: input.message,
        ...(artifact?.sha === undefined ? {} : { sha: artifact.sha }),
        ...(artifact?.pullRequest === undefined
          ? {}
          : { pullRequest: artifact.pullRequest }),
      });
      await this.assertInstructionSurfaceSafe(
        context,
        artifact?.sha,
        session.skills,
      );
      return await this.executeStart({
        provider: input.provider,
        ...(selectedAccount === undefined ? {} : { accountId: selectedAccount.id }),
        ...(input.model === undefined ? {} : { model: input.model }),
        prompt: recoveryPrompt,
        type: 'message',
        project: context.project,
        workItem: context.workItem,
        mode: input.mode ?? 'read',
        ...(input.parentRunId === undefined
          ? {}
          : { parentRunId: input.parentRunId }),
        startBranch:
          context.workItem.currentBranch ?? context.workItem.baseBranch,
        expectedBranch:
          context.workItem.currentBranch ?? context.workItem.baseBranch,
        skills: session.skills,
      });
    }

    const provider = this.provider(input.provider);
    if (provider.send === undefined) {
      throw new RelayError(
        'capability_unavailable',
        `${input.provider} does not support programmatic follow-up.`,
      );
    }

    const mode = input.mode ?? 'read';
    const lineage = this.lineage(input.parentRunId, input.provider);
    const integrationBranch =
      context.workItem.currentBranch ?? context.workItem.baseBranch;
    const baseSha =
      (await this.dependencies.github.getBranchSha(
        context.project.repo,
        integrationBranch,
      )) ??
      (integrationBranch === context.workItem.baseBranch
        ? undefined
        : await this.dependencies.github.getBranchSha(
            context.project.repo,
            context.workItem.baseBranch,
          ));
    if (mode === 'write' && baseSha === undefined) {
      throw new RelayError(
        'not_found',
        `Integration branch ${integrationBranch} has no remote head.`,
      );
    }
    const runId = randomUUID();
    const expectedBranch =
      mode === 'write'
        ? resultBranch(context.workItem.id, runId)
        : integrationBranch;
    const executionMessage =
      mode === 'read' && baseSha !== undefined
        ? `${input.message}\n\nPinned commit: ${baseSha}\nDo not push or merge.`
        : mode === 'write'
          ? `${input.message}\n\nTarget branch: ${expectedBranch}\nPush durable code changes only to the target GitHub branch. Do not merge.`
          : input.message;
    const account = session.accountId === undefined
      ? undefined
      : this.resolveAccount(input.provider, session.accountId);
    const model = input.model ?? modelFromConfig(
      this.executionConfig(context.project.id, input.provider, account),
    );
    await this.requireCapabilities(provider, {
      operation: 'followup',
      ...(account === undefined ? {} : { account }),
      ...(model === undefined ? {} : { model }),
      mode,
    });
    let run = this.dependencies.store.createRun({
      id: runId,
      sessionId: session.id,
      provider: input.provider,
      type: 'message',
      ...(this.storePrompts ? { prompt: executionMessage } : {}),
      mutationMode: mode,
      expectedBranch,
      ...(baseSha === undefined ? {} : { baselineSha: baseSha, baseSha }),
      ...(mode === 'read' && baseSha !== undefined
        ? { pinnedSha: baseSha }
        : {}),
      ...(account === undefined ? {} : { accountId: account.id }),
      ...(model === undefined ? {} : { model }),
      ...lineage,
    });
    let leaseHeld = false;
    const launchAttemptId = randomUUID();
    let launchPrepared = false;
    let launchCompleted = false;
    try {
      if (account !== undefined) {
        this.dependencies.store.acquireAccountLease(account.id, run.id, this.now());
        leaseHeld = true;
      }
      run = this.dependencies.store.transitionRun(run.id, 'running');
      run = this.dependencies.store.prepareRunLaunch(run.id, launchAttemptId);
      launchPrepared = true;
      const config = this.executionConfig(context.project.id, input.provider, account);
      const execution = await provider.send({
        providerSessionId: session.providerSessionId,
        message: executionMessage,
        cwd: context.project.locatorPath,
        ...optionalString(config, 'environmentId'),
        ...(account === undefined ? {} : { profilePath: account.profilePath }),
        ...(model === undefined ? {} : { model }),
      });
      run = this.dependencies.store.markRunLaunchAccepted(
        run.id,
        launchAttemptId,
      );
      this.dependencies.store.upsertSession({
        workItemId: context.workItem.id,
        provider: input.provider,
        ...(account === undefined ? {} : { accountId: account.id }),
        providerSessionId: session.providerSessionId,
        status: sessionStatusFor(execution.status),
        ...(context.workItem.currentBranch === undefined
          ? {}
          : { branch: context.workItem.currentBranch }),
        ...(execution.url === undefined ? {} : { providerUrl: execution.url }),
      });
      run = this.dependencies.store.completeRunLaunch(run.id, launchAttemptId);
      launchCompleted = true;
      run = this.applyProviderStatus(run, execution);
      const reconciled = await this.reconcileRun(
        context,
        run,
        expectedBranch,
      );
      run = reconciled.run;
      if (
        !CAPACITY_HOLDING_RUN_STATUSES.has(run.status) &&
        leaseHeld &&
        account !== undefined
      ) {
        this.dependencies.store.releaseAccountLease(account.id, run.id);
        leaseHeld = false;
      }
      return resultFor(
        this.dependencies.store,
        context.project,
        context.workItem.id,
        session.id,
        run.id,
        reconciled.artifact,
      );
    } catch (error) {
      if (
        launchPrepared &&
        !launchCompleted &&
        isProviderRejection(error)
      ) {
        run = this.dependencies.store.rejectRunLaunch(run.id, launchAttemptId);
        throw error;
      }
      if (launchPrepared && !launchCompleted) {
        run = this.dependencies.store.markRunLaunchUncertain(
          run.id,
          launchAttemptId,
        );
        throw this.launchUncertainError(run, error);
      }
      if (!launchPrepared) {
        run = this.failRunIfActive(run);
      } else {
        run = this.dependencies.store.getRun(run.id);
      }
      if (
        leaseHeld &&
        !CAPACITY_HOLDING_RUN_STATUSES.has(run.status) &&
        account !== undefined
      ) {
        this.dependencies.store.releaseAccountLease(account.id, run.id);
      }
      if (run.status === 'launch_uncertain') {
        throw this.launchUncertainError(run, error);
      }
      throw error;
    }
  }

  async handoff(input: HandoffInput): Promise<HandoffResult> {
    const context = await this.resolveWorkItem(input);
    const artifact = await this.reconcile({
      workItemId: context.workItem.id,
    });
    if (artifact === undefined) {
      throw new RelayError(
        'not_found',
        `WorkItem ${context.workItem.id} has no current published GitHub artifact to hand off.`,
      );
    }

    const mode = input.mode ?? 'read';
    const skills = await this.resolveSkills(context, input.skills);
    await this.assertInstructionSurfaceSafe(context, artifact.sha, skills);
    const prompt = buildHandoffPacket({
      repo: context.project.repo,
      title: context.workItem.title,
      baseBranch: context.workItem.baseBranch,
      sourceBranch: artifact.branch,
      sourceSha: artifact.sha,
      ...(artifact.pullRequest === undefined
        ? {}
        : { pullRequest: artifact.pullRequest }),
      instruction: input.instruction,
      expectedOutput:
        mode === 'write'
          ? 'Push all changes to the Relay result branch and open or update a pull request. Do not merge.'
          : 'Inspect the pinned commit and report findings. Do not merge.',
    });
    const result = await this.executeStart({
      provider: input.provider,
      ...(input.accountId === undefined ? {} : { accountId: input.accountId }),
      ...(input.model === undefined ? {} : { model: input.model }),
      prompt,
      type: 'handoff',
      project: context.project,
      workItem: context.workItem,
      mode,
      ...(input.parentRunId === undefined
        ? {}
        : { parentRunId: input.parentRunId }),
      startBranch: artifact.branch,
      expectedBranch: artifact.branch,
      ...(mode === 'read' ? { pinnedSha: artifact.sha } : {}),
      skills,
    });
    return { ...result, prompt };
  }

  async reconcile(
    input: WorkItemSelector,
  ): Promise<ArtifactRecord | undefined> {
    const context = await this.resolveWorkItem(input);
    const status = this.dependencies.store.getStatus(context.workItem.id);
    let newestResultArtifact: ArtifactRecord | undefined;
    let unresolvedResultError: unknown;
    for (const run of status.runs.filter(
      (candidate) =>
        candidate.mutationMode === 'write' &&
        ['provider_complete', 'awaiting_publish', 'published'].includes(
          candidate.status,
        ),
    )) {
      try {
        const reconciled = await this.reconcileRun(
          context,
          run,
          run.expectedBranch ?? context.workItem.baseBranch,
        );
        if (reconciled.artifact !== undefined) {
          newestResultArtifact = reconciled.artifact;
        }
      } catch (error) {
        unresolvedResultError ??= error;
      }
    }

    const currentWorkItem = this.dependencies.store.getWorkItem(
      context.workItem.id,
    );
    if (
      currentWorkItem.currentBranch !== undefined &&
      currentWorkItem.pullRequest !== undefined
    ) {
      const observed = await this.dependencies.github.reconcile({
        repo: context.project.repo,
        branch: currentWorkItem.currentBranch,
        expectedBaseBranch: currentWorkItem.baseBranch,
        pullRequest: currentWorkItem.pullRequest,
      });
      return this.persistArtifact(currentWorkItem.id, observed);
    }
    if (newestResultArtifact !== undefined) return newestResultArtifact;
    const newestVerifiedResult = [...status.runs]
      .reverse()
      .find(
        (candidate) =>
          candidate.mutationMode === 'write' &&
          candidate.status === 'verified' &&
          isResultBranch(candidate.expectedBranch),
      );
    if (newestVerifiedResult !== undefined) {
      return (
        await this.reconcileRun(
          context,
          newestVerifiedResult,
          newestVerifiedResult.expectedBranch!,
        )
      ).artifact;
    }

    const unresolvedRead = [...status.runs]
      .reverse()
      .find(
        (candidate) =>
          candidate.mutationMode === 'read' &&
          ['provider_complete', 'awaiting_publish', 'published'].includes(
            candidate.status,
          ),
      );
    if (unresolvedRead !== undefined) {
      return (
        await this.reconcileRun(
          context,
          unresolvedRead,
          unresolvedRead.expectedBranch ?? currentWorkItem.baseBranch,
        )
      ).artifact;
    }

    const observed = await this.dependencies.github.reconcile({
      repo: context.project.repo,
      branch: currentWorkItem.currentBranch ?? currentWorkItem.baseBranch,
      expectedBaseBranch: currentWorkItem.baseBranch,
    });
    const artifact = this.persistArtifact(currentWorkItem.id, observed);
    if (artifact !== undefined) return artifact;
    if (unresolvedResultError !== undefined) throw unresolvedResultError;
    return undefined;
  }

  async status(input: WorkItemSelector): Promise<RelayStatus> {
    const context = await this.resolveWorkItem(input);
    const before = this.dependencies.store.getStatus(context.workItem.id);
    const activeSessions = before.sessions.filter((session) => session.status === 'active');
    let inspectionError: unknown;

    for (const session of activeSessions) {
      const provider = this.provider(session.provider);
      if (provider.inspect === undefined) continue;
      const runs = before.runs.filter(
        (candidate) =>
          candidate.sessionId === session.id && candidate.status === 'running',
      );
      const run = runs.at(-1);
      if (run === undefined) continue;
      const account = session.accountId === undefined
        ? undefined
        : this.resolveAccount(session.provider, session.accountId);
      const config = this.executionConfig(context.project.id, session.provider, account);
      if (account !== undefined) {
        const now = this.now();
        for (const activeRun of runs) {
          this.dependencies.store.heartbeatAccountLease(
            account.id,
            activeRun.id,
            now,
          );
        }
      }
      const inspection = await provider.inspect({
        providerSessionId: session.providerSessionId,
        ...optionalString(config, 'environmentId'),
        ...(account === undefined ? {} : { profilePath: account.profilePath }),
        ...(run.model === undefined ? {} : { model: run.model }),
      });
      const execution: ProviderExecution = {
        providerSessionId: session.providerSessionId,
        status: inspection.status,
        ...(inspection.url === undefined ? {} : { url: inspection.url }),
      };
      this.dependencies.store.upsertSession({
        workItemId: context.workItem.id,
        provider: session.provider,
        ...(account === undefined ? {} : { accountId: account.id }),
        providerSessionId: session.providerSessionId,
        status: sessionStatusFor(execution.status),
        ...(session.branch === undefined ? {} : { branch: session.branch }),
        ...(inspection.url === undefined
          ? session.providerUrl === undefined
            ? {}
            : { providerUrl: session.providerUrl }
          : { providerUrl: inspection.url }),
      });
      const updatedRuns = runs.map((activeRun) =>
        this.applyProviderStatus(activeRun, execution),
      );
      for (const updated of updatedRuns) {
        if (ACTIVE_RUN_STATUSES.has(updated.status)) continue;
        try {
          await this.reconcileRun(
            context,
            updated,
            updated.expectedBranch ??
              context.workItem.currentBranch ??
              context.workItem.baseBranch,
          );
        } catch (error) {
          inspectionError ??= error;
        } finally {
          if (account !== undefined) {
            this.dependencies.store.releaseAccountLease(account.id, updated.id);
          }
        }
      }
    }

    if (inspectionError !== undefined) throw inspectionError;

    const artifact = await this.reconcile({
      workItemId: context.workItem.id,
    });
    const stored = this.dependencies.store.getStatus(context.workItem.id);
    const result: RelayStatus = {
      project: context.project,
      workItem: stored.workItem,
      sessions: stored.sessions,
      runs: stored.runs,
    };
    if (artifact !== undefined) result.artifact = artifact;
    return result;
  }

  async sessions(input: WorkItemSelector): Promise<readonly SessionRecord[]> {
    const context = await this.resolveWorkItem(input);
    return this.dependencies.store.listSessions(context.workItem.id);
  }

  async providers(): Promise<
    Readonly<Record<ProviderName, ProviderCapabilities>>
  > {
    const entries = await Promise.all(
      SUPPORTED_PROVIDERS.map(async (name) => [
        name,
        await this.provider(name).capabilities(),
      ] as const),
    );
    return Object.fromEntries(entries) as Record<
      ProviderName,
      ProviderCapabilities
    >;
  }

  async resolveLaunch(input: ResolveLaunchRequest): Promise<RunRecord> {
    if (!input.confirmed) {
      throw new RelayError(
        'invalid_argument',
        'Uncertain-launch resolution requires explicit operator confirmation.',
      );
    }
    return this.dependencies.store.resolveUncertainLaunch(input.runId);
  }

  async chat(
    providerName: ProviderName,
    input: ChatInput,
  ): Promise<number> {
    const context = await this.resolveWorkItem(input);
    const { account, session } = this.sessionRoute(
      context.workItem.id,
      providerName,
      input.accountId,
    );
    this.assertNoUncertainLaunch(
      context.workItem.id,
      providerName,
      account?.id,
    );
    if (session === undefined) {
      throw new RelayError(
        'not_found',
        `No ${providerName} session exists for this WorkItem.`,
      );
    }
    const provider = this.provider(providerName);
    if (provider.attach === undefined) {
      throw new RelayError(
        'capability_unavailable',
        `${providerName} does not support interactive attachment.`,
      );
    }
    await this.requireCapabilities(provider, {
      operation: 'attach',
      ...(account === undefined ? {} : { account }),
    });
    return await provider.attach({
      providerSessionId: session.providerSessionId,
      cwd: context.project.locatorPath,
      ...(account === undefined ? {} : { profilePath: account.profilePath }),
    });
  }

  async merge(input: MergeRequest): Promise<void> {
    if (!Number.isSafeInteger(input.pullRequest) || input.pullRequest <= 0) {
      throw new RelayError(
        'invalid_argument',
        'Merge approval must be bound to a positive pull-request number.',
      );
    }
    if (!/^[0-9a-f]{40}$/i.test(input.expectedSha)) {
      throw new RelayError(
        'invalid_argument',
        'Merge approval must be bound to a full commit SHA.',
      );
    }
    const context = await this.resolveWorkItem(input);
    const artifact = await this.reconcile({
      workItemId: context.workItem.id,
    });
    if (artifact?.pullRequest === undefined) {
      throw new RelayError(
        'merge_not_ready',
        `WorkItem ${context.workItem.id} has no pull request to merge.`,
      );
    }
    if (artifact.pullRequest !== input.pullRequest) {
      throw new RelayError(
        'github_state_mismatch',
        `The current pull request changed from #${input.pullRequest} to #${artifact.pullRequest} after approval.`,
        {
          expectedPullRequest: input.pullRequest,
          observedPullRequest: artifact.pullRequest,
        },
      );
    }
    if (artifact.sha !== input.expectedSha) {
      throw new RelayError(
        'head_moved',
        `Pull request #${input.pullRequest} moved after approval.`,
        { expectedSha: input.expectedSha, observedSha: artifact.sha },
      );
    }
    await this.dependencies.github.merge({
      repo: context.project.repo,
      pullRequest: input.pullRequest,
      expectedSha: input.expectedSha,
      expectedBaseBranch: context.workItem.baseBranch,
      strategy: input.strategy,
      approved: input.approved,
    });
  }

  private async contextForDelegation(
    input: DelegateInput,
  ): Promise<WorkContext> {
    if (input.workItemId !== undefined) {
      return await this.resolveWorkItem({ workItemId: input.workItemId });
    }
    if (input.cwd === undefined) {
      throw new RelayError(
        'invalid_argument',
        'A working directory is required when creating a WorkItem.',
      );
    }
    const project = await this.initialize({ cwd: input.cwd });
    const id = randomUUID();
    const title = input.title ?? sentenceTitle(input.task);
    const currentBranch =
      (input.mode ?? 'write') === 'read'
        ? project.defaultBranch
        : `relay/work/${slug(title)}-${id.slice(0, 8)}`;
    const workItem = this.dependencies.store.createWorkItem({
      id,
      projectId: project.id,
      title,
      baseBranch: project.defaultBranch,
      currentBranch,
    });
    return { project, workItem };
  }

  private async resolveWorkItem(
    input: WorkItemSelector,
  ): Promise<WorkContext> {
    if (input.workItemId !== undefined && input.workItemId !== 'current') {
      const workItem = this.dependencies.store.getWorkItem(input.workItemId);
      return {
        project: this.dependencies.store.getProject(workItem.projectId),
        workItem,
      };
    }
    if (input.cwd === undefined) {
      throw new RelayError(
        'invalid_argument',
        'A working directory is required to resolve the current WorkItem.',
      );
    }
    const detected = await this.dependencies.github.detectProject(input.cwd);
    const project = this.dependencies.store.getProjectByRepo(detected.repo);
    if (project === undefined) {
      throw new RelayError(
        'not_found',
        `Project ${detected.repo} has not been initialized.`,
      );
    }
    const workItem = this.dependencies.store.getCurrentWorkItem(project.id);
    if (workItem === undefined) {
      throw new RelayError(
        'not_found',
        `Project ${project.repo} has no current WorkItem.`,
      );
    }
    return { project, workItem };
  }

  private async resolveSkills(
    context: WorkContext,
    names: readonly string[] | undefined,
  ): Promise<readonly ResolvedSkill[]> {
    if (names === undefined || names.length === 0) return [];

    let sourceSha = context.workItem.skillSourceSha;
    if (sourceSha === undefined) {
      sourceSha = await this.dependencies.github.getBranchSha(
        context.project.repo,
        context.workItem.baseBranch,
      );
      if (sourceSha === undefined) {
        throw new RelayError(
          'not_found',
          `Base branch ${context.workItem.baseBranch} has no remote head for skill resolution.`,
        );
      }
    }
    const resolved = await this.dependencies.skillResolver.resolve({
      repositoryPath: context.project.locatorPath,
      sourceSha,
      names,
    });
    this.dependencies.store.pinWorkItemSkillSource(
      context.workItem.id,
      sourceSha,
    );
    return resolved;
  }

  private async assertInstructionSurfaceSafe(
    context: WorkContext,
    candidateSha: string | undefined,
    skills: readonly ResolvedSkill[],
  ): Promise<void> {
    const trustedSha = this.dependencies.store.getWorkItem(
      context.workItem.id,
    ).skillSourceSha;
    if (trustedSha === undefined) {
      if (skills.length === 0) return;
      throw new RelayError(
        'state_conflict',
        `WorkItem ${context.workItem.id} has skills without a trusted source commit.`,
        { workItemId: context.workItem.id },
      );
    }
    if (skills.some((skill) => skill.sourceSha !== trustedSha)) {
      throw new RelayError(
        'state_conflict',
        `WorkItem ${context.workItem.id} has inconsistent stored skill coordinates.`,
        { workItemId: context.workItem.id },
      );
    }
    if (candidateSha === undefined) return;
    const changedPaths =
      await this.dependencies.skillResolver.changedInstructionPaths({
        repositoryPath: context.project.locatorPath,
        trustedSha,
        candidateSha,
      });
    if (changedPaths.length > 0) {
      throw new RelayError(
        'instruction_surface_changed',
        'The candidate changes agent instruction surfaces and requires human review before another provider can continue.',
        { changedPaths: [...changedPaths] },
      );
    }
  }

  private async executeStart(
    input: StartExecutionInput,
  ): Promise<RelayRunResult> {
    const provider = this.provider(input.provider);
    const account = this.resolveAccount(input.provider, input.accountId);
    const config = this.executionConfig(input.project.id, input.provider, account);
    const model = input.model ?? modelFromConfig(config);
    await this.requireCapabilities(provider, {
      operation: 'start',
      ...(account === undefined ? {} : { account }),
      ...(model === undefined ? {} : { model }),
      mode: input.mode,
    });
    this.assertNoUncertainLaunch(
      input.workItem.id,
      input.provider,
      account?.id,
    );
    const lineage = this.lineage(input.parentRunId, input.provider);
    const baseSha =
      (await this.dependencies.github.getBranchSha(
        input.project.repo,
        input.startBranch,
      )) ??
      (input.startBranch === input.workItem.baseBranch
        ? undefined
        : await this.dependencies.github.getBranchSha(
            input.project.repo,
            input.workItem.baseBranch,
          ));
    if (input.mode === 'write' && baseSha === undefined) {
      throw new RelayError(
        'not_found',
        `Integration branch ${input.startBranch} has no remote head.`,
      );
    }
    if (
      input.mode === 'read' &&
      input.pinnedSha !== undefined &&
      baseSha !== input.pinnedSha
    ) {
      throw new RelayError(
        'head_moved',
        `Branch ${input.expectedBranch} moved before the delegated review started.`,
        { expectedSha: input.pinnedSha, observedSha: baseSha },
      );
    }
    const pinnedSha =
      input.mode === 'read' ? input.pinnedSha ?? baseSha : undefined;
    const runId = randomUUID();
    const expectedBranch =
      input.mode === 'write'
        ? resultBranch(input.workItem.id, runId)
        : input.expectedBranch;
    const executionPrompt =
      input.mode === 'read' && pinnedSha !== undefined
        ? `${input.prompt}\nPinned commit: ${pinnedSha}`
        : input.mode === 'write'
          ? `${input.prompt}\n\nTarget branch: ${expectedBranch}\nPush durable code changes only to the target GitHub branch. Do not merge.`
          : input.prompt;
    const providerPrompt = appendSkillPacket(executionPrompt, input.skills);
    const pendingSession = this.dependencies.store.upsertSession({
      workItemId: input.workItem.id,
      provider: input.provider,
      ...(account === undefined ? {} : { accountId: account.id }),
      providerSessionId: `pending:${randomUUID()}`,
      status: 'pending',
      branch: expectedBranch,
      skills: input.skills,
    });
    let run: RunRecord;
    try {
      run = this.dependencies.store.createRun({
        id: runId,
        sessionId: pendingSession.id,
        provider: input.provider,
        type: input.type,
        ...(this.storePrompts ? { prompt: providerPrompt } : {}),
        mutationMode: input.mode,
        expectedBranch,
        ...(baseSha === undefined ? {} : { baselineSha: baseSha, baseSha }),
        ...(pinnedSha === undefined ? {} : { pinnedSha }),
        ...(account === undefined ? {} : { accountId: account.id }),
        ...(model === undefined ? {} : { model }),
        ...lineage,
      });
    } catch (error) {
      this.dependencies.store.activateSession(pendingSession.id, {
        providerSessionId: pendingSession.providerSessionId,
        status: 'failed',
        branch: expectedBranch,
      });
      throw error;
    }
    let leaseHeld = false;
    let providerExecution: ProviderExecution | undefined;
    const launchAttemptId = randomUUID();
    let launchPrepared = false;
    let launchCompleted = false;
    try {
      if (account !== undefined) {
        this.dependencies.store.acquireAccountLease(account.id, run.id, this.now());
        leaseHeld = true;
      }
      run = this.dependencies.store.transitionRun(run.id, 'running');
      run = this.dependencies.store.prepareRunLaunch(run.id, launchAttemptId);
      launchPrepared = true;
      const execution = await provider.start({
        prompt: providerPrompt,
        cwd: input.project.locatorPath,
        mode: input.mode,
        startingBranch: input.startBranch,
        ...(input.mode === 'write' ? { resultBranch: expectedBranch } : {}),
        repo: input.project.repo,
        title: input.workItem.title,
        ...optionalString(config, 'environmentId'),
        ...optionalString(config, 'source'),
        ...(account === undefined ? {} : { profilePath: account.profilePath }),
        ...(model === undefined ? {} : { model }),
      });
      providerExecution = execution;
      run = this.dependencies.store.markRunLaunchAccepted(
        run.id,
        launchAttemptId,
      );
      const session = this.dependencies.store.activateSession(
        pendingSession.id,
        {
          providerSessionId: execution.providerSessionId,
          status: sessionStatusFor(execution.status),
          branch: expectedBranch,
          ...(execution.url === undefined ? {} : { providerUrl: execution.url }),
        },
      );
      run = this.dependencies.store.completeRunLaunch(run.id, launchAttemptId);
      launchCompleted = true;
      run = this.applyProviderStatus(run, execution);
      const reconciled = await this.reconcileRun(
        { project: input.project, workItem: input.workItem },
        run,
        expectedBranch,
      );
      run = reconciled.run;
      if (
        !CAPACITY_HOLDING_RUN_STATUSES.has(run.status) &&
        leaseHeld &&
        account !== undefined
      ) {
        this.dependencies.store.releaseAccountLease(account.id, run.id);
        leaseHeld = false;
      }
      return resultFor(
        this.dependencies.store,
        input.project,
        input.workItem.id,
        session.id,
        run.id,
        reconciled.artifact,
      );
    } catch (error) {
      if (
        launchPrepared &&
        !launchCompleted &&
        isProviderRejection(error)
      ) {
        run = this.dependencies.store.rejectRunLaunch(run.id, launchAttemptId);
        throw error;
      }
      if (launchPrepared && !launchCompleted) {
        run = this.dependencies.store.markRunLaunchUncertain(
          run.id,
          launchAttemptId,
        );
        throw this.launchUncertainError(run, error);
      }
      if (!launchPrepared) {
        run = this.failRunIfActive(run);
        this.dependencies.store.activateSession(pendingSession.id, {
          providerSessionId: pendingSession.providerSessionId,
          status: 'failed',
          branch: expectedBranch,
        });
      } else if (providerExecution !== undefined) {
        run = this.dependencies.store.getRun(run.id);
        this.dependencies.store.activateSession(pendingSession.id, {
          providerSessionId: providerExecution.providerSessionId,
          status: sessionStatusFor(providerExecution.status),
          branch: expectedBranch,
          ...(providerExecution.url === undefined
            ? {}
            : { providerUrl: providerExecution.url }),
        });
      }
      if (
        leaseHeld &&
        !CAPACITY_HOLDING_RUN_STATUSES.has(run.status) &&
        account !== undefined
      ) {
        this.dependencies.store.releaseAccountLease(account.id, run.id);
      }
      if (run.status === 'launch_uncertain') {
        throw this.launchUncertainError(run, error);
      }
      throw error;
    }
  }

  private async reconcileRun(
    context: WorkContext,
    originalRun: RunRecord,
    branch: string,
  ): Promise<{ run: RunRecord; artifact?: ArtifactRecord }> {
    let run = this.dependencies.store.getRun(originalRun.id);
    const pullRequest =
      context.workItem.currentBranch === branch
        ? context.workItem.pullRequest
        : undefined;
    const observed = await this.dependencies.github.reconcile({
      repo: context.project.repo,
      branch,
      expectedBaseBranch: context.workItem.baseBranch,
      ...(pullRequest === undefined ? {} : { pullRequest }),
    });

    if (
      run.mutationMode === 'read' &&
      run.pinnedSha !== undefined &&
      observed.sha !== run.pinnedSha
    ) {
      throw new RelayError(
        'head_moved',
        `Branch ${branch} moved while the read-only run was inspecting it.`,
        { expectedSha: run.pinnedSha, observedSha: observed.sha },
      );
    }
    if (run.mutationMode === 'write' && observed.sha !== undefined) {
      run = this.dependencies.store.setRunResultSha(run.id, observed.sha);
      this.dependencies.store.createCandidateForRun(run.id);
    }
    const artifact = this.persistArtifact(context.workItem.id, observed);

    if (observed.status === 'awaiting_publish') {
      if (run.status === 'provider_complete') {
        run = this.dependencies.store.transitionRun(run.id, 'awaiting_publish');
      }
      return { run };
    }
    if (
      run.mutationMode === 'write' &&
      run.baselineSha !== undefined &&
      observed.sha === run.baselineSha &&
      !isResultBranch(run.expectedBranch)
    ) {
      if (run.status === 'provider_complete') {
        run = this.dependencies.store.transitionRun(run.id, 'awaiting_publish');
      }
      return artifact === undefined ? { run } : { run, artifact };
    }
    if (run.status === 'provider_complete' || run.status === 'awaiting_publish') {
      run = this.dependencies.store.transitionRun(run.id, 'published');
    }
    if (observed.status === 'verified' && run.status === 'published') {
      run = this.dependencies.store.transitionRun(run.id, 'verified');
    }
    return artifact === undefined ? { run } : { run, artifact };
  }

  private persistArtifact(
    workItemId: string,
    observed: Awaited<ReturnType<GitHubClient['reconcile']>>,
  ): ArtifactRecord | undefined {
    if (observed.sha === undefined) {
      if (!isResultBranch(observed.branch)) {
        this.dependencies.store.markArtifactMissing(workItemId, observed.branch);
      }
      return undefined;
    }
    const input: ArtifactInput = {
      workItemId,
      branch: observed.branch,
      sha: observed.sha,
      status: observed.status === 'verified' ? 'verified' : 'published',
      checks: observed.checks,
    };
    if (observed.pullRequest !== undefined) {
      input.pullRequest = observed.pullRequest;
    }
    if (observed.mergeable !== undefined) input.mergeable = observed.mergeable;
    if (observed.reviewDecision !== undefined) {
      input.reviewDecision = observed.reviewDecision;
    }
    if (observed.draft !== undefined) input.draft = observed.draft;
    return this.dependencies.store.saveArtifact(input);
  }

  private applyProviderStatus(
    originalRun: RunRecord,
    execution: ProviderExecution,
  ): RunRecord {
    const run = this.dependencies.store.getRun(originalRun.id);
    if (!ACTIVE_RUN_STATUSES.has(run.status)) return run;
    if (execution.status === 'provider_complete') {
      return this.dependencies.store.transitionRun(run.id, 'provider_complete');
    }
    if (execution.status === 'failed') {
      return this.dependencies.store.transitionRun(run.id, 'failed');
    }
    if (execution.status === 'cancelled') {
      return this.dependencies.store.transitionRun(run.id, 'cancelled');
    }
    if (execution.status === 'expired') {
      return this.dependencies.store.transitionRun(run.id, 'expired');
    }
    return run;
  }

  private failRunIfActive(run: RunRecord): RunRecord {
    const current = this.dependencies.store.getRun(run.id);
    return ACTIVE_RUN_STATUSES.has(current.status)
      ? this.dependencies.store.transitionRun(current.id, 'failed')
      : current;
  }

  private lineage(
    parentRunId: string | undefined,
    provider: ProviderName,
  ): {
    correlationId?: string;
    originProvider?: ProviderName;
    delegationDepth?: number;
    parentRunId?: string;
  } {
    if (parentRunId === undefined) return {};
    const parent = this.dependencies.store.getRun(parentRunId);
    const delegationDepth = parent.delegationDepth + 1;
    if (delegationDepth > 2) {
      throw new RelayError(
        'delegation_depth_exceeded',
        'Relay allows at most two provider-to-provider delegation levels.',
      );
    }
    return {
      correlationId: parent.correlationId,
      originProvider: parent.originProvider ?? parent.provider ?? provider,
      delegationDepth,
      parentRunId,
    };
  }

  private provider(name: ProviderName): CloudProvider {
    const provider = this.dependencies.providers.get(name);
    if (provider === undefined) {
      throw new RelayError('not_found', `Provider ${name} is not registered.`);
    }
    return provider;
  }

  private providerConfig(
    projectId: string,
    provider: ProviderName,
  ): Readonly<Record<string, unknown>> {
    return this.dependencies.store.getProviderConfig(projectId, provider) ?? {};
  }

  private resolveAccount(
    provider: ProviderName,
    accountId: string | undefined,
  ): ProviderAccountRecord | undefined {
    const account = accountId === undefined
      ? this.dependencies.store.getDefaultProviderAccount(provider)
      : this.dependencies.store.getProviderAccount(accountId);
    if (accountId !== undefined && account === undefined) {
      throw new RelayError('not_found', `Provider account ${accountId} was not found.`);
    }
    if (account !== undefined && account.provider !== provider) {
      throw new RelayError(
        'provider_mismatch',
        `Provider account ${account.id} is registered to ${account.provider}, not ${provider}.`,
      );
    }
    return account;
  }

  private executionConfig(
    projectId: string,
    provider: ProviderName,
    account: ProviderAccountRecord | undefined,
  ): Readonly<Record<string, unknown>> {
    const providerConfig = this.providerConfig(projectId, provider);
    if (account === undefined) return providerConfig;
    return {
      ...providerConfig,
      ...(this.dependencies.store.getProviderAccountConfig(projectId, account.id) ?? {}),
    };
  }

  private sessionRoute(
    workItemId: string,
    provider: ProviderName,
    accountId: string | undefined,
  ): {
    account: ProviderAccountRecord | undefined;
    session: SessionRecord | undefined;
    existingScopes: number;
  } {
    const providerSessions = this.dependencies.store
      .listSessions(workItemId)
      .filter(
        (candidate) =>
          candidate.provider === provider && candidate.status !== 'complete',
      );
    const usableSessions = providerSessions.filter((candidate) =>
      candidate.status === 'active' || candidate.status === 'pending'
    );
    const routeSessions = usableSessions.length > 0
      ? usableSessions
      : providerSessions;
    const routeScopes = [
      ...new Set(routeSessions.map((candidate) => candidate.accountId ?? null)),
    ];
    if (accountId === undefined && routeScopes.length > 1) {
      throw new RelayError(
        'invalid_argument',
        `Multiple ${provider} account sessions exist for this WorkItem; select one with --account.`,
      );
    }
    const account = accountId !== undefined
      ? this.resolveAccount(provider, accountId)
      : routeScopes.length === 1
        ? routeScopes[0] === null
          ? undefined
          : this.resolveAccount(provider, routeScopes[0])
        : this.resolveAccount(provider, undefined);
    const stored = this.dependencies.store.getSession(
      workItemId,
      provider,
      account?.id,
    );
    return {
      account,
      session: stored?.status === 'complete' ? undefined : stored,
      existingScopes: new Set(
        providerSessions.map((candidate) => candidate.accountId ?? null),
      ).size,
    };
  }

  private async requireCapabilities(
    provider: CloudProvider,
    requirements: {
      operation: 'start' | 'followup' | 'attach';
      account?: ProviderAccountRecord;
      model?: string;
      mode?: MutationMode;
    },
  ): Promise<void> {
    const capabilities = await provider.capabilities();
    const unavailable = (message: string): never => {
      throw new RelayError('capability_unavailable', message);
    };
    if (requirements.operation === 'start' && !capabilities.start) {
      unavailable(`${provider.name} does not support cloud starts.`);
    }
    if (requirements.operation === 'followup' && !capabilities.queueFollowup) {
      unavailable(`${provider.name} does not support programmatic follow-up.`);
    }
    if (requirements.operation === 'attach' && !capabilities.interactiveAttach) {
      unavailable(`${provider.name} does not support interactive attachment.`);
    }
    if (requirements.account !== undefined && !capabilities.profileIsolation) {
      unavailable(`${provider.name} cannot isolate a selected account profile.`);
    }
    if (
      requirements.account !== undefined &&
      provider.loginProfile !== undefined
    ) {
      await this.requireAccountIdentity(provider, requirements.account);
    }
    if (requirements.model !== undefined && !capabilities.selectModel) {
      unavailable(`${provider.name} does not support explicit model selection.`);
    }
    if (requirements.mode === 'write' && !capabilities.controlledResultBranch) {
      unavailable(
        `${provider.name} cannot publish to a Relay-controlled result branch.`,
      );
    }
  }

  private async requireAccountIdentity(
    provider: CloudProvider,
    account: ProviderAccountRecord,
  ): Promise<void> {
    if (account.status !== 'ready' && account.status !== 'auth_required') return;
    if (account.authFingerprint === undefined) {
      this.dependencies.store.markProviderAccountAuthRequired(account.id);
      throw new RelayError(
        'account_unavailable',
        `Provider account ${account.id} needs native login before it can run.`,
      );
    }
    const auth = await provider.authStatus(account.profilePath);
    if (!auth.authenticated) {
      this.dependencies.store.markProviderAccountAuthRequired(account.id);
      throw new RelayError(
        'account_unavailable',
        `Provider account ${account.id} is no longer authenticated.`,
      );
    }
    if (auth.identityFingerprint === undefined) {
      this.dependencies.store.markProviderAccountAuthRequired(account.id);
      throw new RelayError(
        'provider_output_invalid',
        `${provider.name} did not report a verifiable profile identity.`,
      );
    }
    if (auth.identityFingerprint !== account.authFingerprint) {
      this.dependencies.store.markProviderAccountAuthRequired(account.id);
      throw new RelayError(
        'provider_mismatch',
        `Provider profile for account ${account.id} is authenticated as another identity.`,
      );
    }
    if (account.status === 'auth_required') {
      this.dependencies.store.bindProviderAccountAuth(
        account.id,
        auth.identityFingerprint,
        this.now(),
      );
    }
  }

  private assertNoUncertainLaunch(
    workItemId: string,
    provider: ProviderName,
    accountId: string | undefined,
  ): void {
    const uncertain = this.dependencies.store
      .getStatus(workItemId)
      .runs.find(
        (run) =>
          run.provider === provider &&
          run.status === 'launch_uncertain' &&
          run.accountId === accountId,
      );
    if (uncertain !== undefined) {
      throw new RelayError(
        'launch_uncertain',
        `Run ${uncertain.id} may have been accepted remotely; inspect the provider and resolve it explicitly before retrying.`,
        { runId: uncertain.id, launchAttemptId: uncertain.launchAttemptId },
      );
    }
  }

  private launchUncertainError(run: RunRecord, cause: unknown): RelayError {
    return new RelayError(
      'launch_uncertain',
      `Run ${run.id} may have been accepted remotely; inspect the provider and resolve it explicitly before retrying.`,
      {
        runId: run.id,
        launchAttemptId: run.launchAttemptId,
      },
      { cause },
    );
  }
}

function isProviderRejection(error: unknown): error is RelayError {
  return error instanceof RelayError && error.code === 'provider_rejected';
}

function resultFor(
  store: StateStore,
  project: ProjectRecord,
  workItemId: string,
  sessionId: string,
  runId: string,
  artifact?: ArtifactRecord,
): RelayRunResult {
  const status = store.getStatus(workItemId);
  const session = status.sessions.find((candidate) => candidate.id === sessionId);
  if (session === undefined) {
    throw new RelayError('not_found', `Session ${sessionId} was not found.`);
  }
  const run = store.getRun(runId);
  const result: RelayRunResult = {
    project,
    workItem: store.getWorkItem(workItemId),
    session,
    run,
  };
  if (artifact !== undefined) result.artifact = artifact;
  return result;
}

function buildDelegationPrompt(input: {
  task: string;
  project: ProjectRecord;
  workItem: WorkItemRecord;
  mode: MutationMode;
}): string {
  const lines = [
    input.task,
    '',
    `Repository: ${input.project.repo}`,
    `Base branch: ${input.workItem.baseBranch}`,
  ];
  if (input.mode === 'write') {
    lines.push('Prepare a durable code change for Relay publication.');
  } else {
    lines.push(
      `Inspect branch: ${input.workItem.currentBranch ?? input.workItem.baseBranch}`,
      'Inspect and report findings. Do not push or merge.',
    );
  }
  return lines.join('\n');
}

function sessionStatusFor(
  status: ProviderRunStatus,
): SessionRecord['status'] {
  if (status === 'expired') return 'expired';
  if (status === 'failed' || status === 'cancelled') return 'failed';
  return 'active';
}

function optionalString(
  config: Readonly<Record<string, unknown>>,
  key: string,
): Record<string, string> {
  const value = config[key];
  return typeof value === 'string' && value !== '' ? { [key]: value } : {};
}

function modelFromConfig(config: Readonly<Record<string, unknown>>): string | undefined {
  const model = config.model;
  return typeof model === 'string' && model !== '' ? model : undefined;
}

function resultBranch(workItemId: string, runId: string): string {
  return `relay/run/${workItemId.slice(0, 8)}/${runId.slice(0, 8)}`;
}

function isResultBranch(branch: string | undefined): boolean {
  return branch?.startsWith('relay/run/') ?? false;
}

function slug(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return normalized === '' ? 'work' : normalized;
}

function sentenceTitle(value: string): string {
  const normalized = value.trim().replace(/\s+/g, ' ');
  return normalized.length <= 60 ? normalized : `${normalized.slice(0, 57)}...`;
}
