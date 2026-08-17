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
import type {
  ArtifactInput,
  ArtifactRecord,
  ProjectRecord,
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
  storePrompts?: boolean;
}

export interface InitializeInput {
  cwd: string;
  providerConfigs?: Partial<
    Record<ProviderName, Readonly<Record<string, unknown>>>
  >;
}

export interface DelegateInput {
  provider: ProviderName;
  task: string;
  title?: string;
  cwd?: string;
  workItemId?: string;
  mode?: MutationMode;
  parentRunId?: string;
}

export interface SendInput {
  provider: ProviderName;
  message: string;
  workItemId?: string;
  cwd?: string;
  mode?: MutationMode;
  parentRunId?: string;
}

export interface HandoffInput {
  provider: ProviderName;
  instruction: string;
  workItemId?: string;
  cwd?: string;
  mode?: MutationMode;
  parentRunId?: string;
}

export interface WorkItemSelector {
  workItemId?: string;
  cwd?: string;
}

export interface MergeRequest extends WorkItemSelector {
  strategy: MergeStrategy;
  approved: boolean;
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
  prompt: string;
  type: RunType;
  project: ProjectRecord;
  workItem: WorkItemRecord;
  mode: MutationMode;
  parentRunId?: string;
  startBranch: string;
  expectedBranch: string;
  pinnedSha?: string;
}

const ACTIVE_RUN_STATUSES = new Set(['queued', 'running']);

export class RelayCore {
  private readonly storePrompts: boolean;

  constructor(private readonly dependencies: RelayCoreDependencies) {
    this.storePrompts = dependencies.storePrompts ?? true;
  }

  async doctor(): Promise<DoctorReport> {
    const [github, entries] = await Promise.all([
      this.dependencies.github.authStatus(),
      Promise.all(
        (['claude', 'codex', 'jules'] as const).map(async (name) => {
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
    const prompt = buildDelegationPrompt({
      task: input.task,
      project: context.project,
      workItem: context.workItem,
      mode,
    });
    return await this.executeStart({
      provider: input.provider,
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
    });
  }

  async send(input: SendInput): Promise<RelayRunResult> {
    const context = await this.resolveWorkItem(input);
    const session = this.dependencies.store.getSession(
      context.workItem.id,
      input.provider,
    );
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
      return await this.executeStart({
        provider: input.provider,
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
    const expectedBranch =
      context.workItem.currentBranch ?? context.workItem.baseBranch;
    const baselineSha = await this.dependencies.github.getBranchSha(
      context.project.repo,
      expectedBranch,
    );
    const executionMessage =
      mode === 'read' && baselineSha !== undefined
        ? `${input.message}\n\nPinned commit: ${baselineSha}\nDo not push or merge.`
        : input.message;
    let run = this.dependencies.store.createRun({
      sessionId: session.id,
      provider: input.provider,
      type: 'message',
      ...(this.storePrompts ? { prompt: executionMessage } : {}),
      mutationMode: mode,
      expectedBranch,
      ...(baselineSha === undefined ? {} : { baselineSha }),
      ...(mode === 'read' && baselineSha !== undefined
        ? { pinnedSha: baselineSha }
        : {}),
      ...lineage,
    });
    let leaseHeld = false;
    let providerAccepted = false;
    try {
      if (mode === 'write') {
        this.dependencies.store.acquireMutationLease(
          context.workItem.id,
          run.id,
        );
        leaseHeld = true;
      }
      run = this.dependencies.store.transitionRun(run.id, 'running');
      const config = this.providerConfig(context.project.id, input.provider);
      const execution = await provider.send({
        providerSessionId: session.providerSessionId,
        message: executionMessage,
        cwd: context.project.locatorPath,
        ...optionalString(config, 'environmentId'),
      });
      providerAccepted = true;
      this.dependencies.store.upsertSession({
        workItemId: context.workItem.id,
        provider: input.provider,
        providerSessionId: session.providerSessionId,
        status: sessionStatusFor(execution.status),
        ...(context.workItem.currentBranch === undefined
          ? {}
          : { branch: context.workItem.currentBranch }),
        ...(execution.url === undefined ? {} : { providerUrl: execution.url }),
      });
      run = this.applyProviderStatus(run, execution);
      const reconciled = await this.reconcileRun(
        context,
        run,
        expectedBranch,
      );
      run = reconciled.run;
      if (!ACTIVE_RUN_STATUSES.has(run.status) && leaseHeld) {
        this.dependencies.store.releaseMutationLease(
          context.workItem.id,
          run.id,
        );
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
      if (!providerAccepted) {
        run = this.failRunIfActive(run);
      } else {
        run = this.dependencies.store.getRun(run.id);
      }
      if (leaseHeld && !ACTIVE_RUN_STATUSES.has(run.status)) {
        this.dependencies.store.releaseMutationLease(
          context.workItem.id,
          run.id,
        );
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
    const targetBranch =
      mode === 'write'
        ? `relay/${slug(context.workItem.title)}-${input.provider}-${context.workItem.id.slice(0, 8)}`
        : undefined;
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
      ...(targetBranch === undefined ? {} : { targetBranch }),
      expectedOutput:
        mode === 'write'
          ? 'Push all changes to the target branch and open or update a pull request. Do not merge.'
          : 'Inspect the pinned commit and report findings. Do not merge.',
    });
    const result = await this.executeStart({
      provider: input.provider,
      prompt,
      type: 'handoff',
      project: context.project,
      workItem: context.workItem,
      mode,
      ...(input.parentRunId === undefined
        ? {}
        : { parentRunId: input.parentRunId }),
      startBranch: artifact.branch,
      expectedBranch: targetBranch ?? artifact.branch,
      ...(mode === 'read' ? { pinnedSha: artifact.sha } : {}),
    });
    return { ...result, prompt };
  }

  async reconcile(
    input: WorkItemSelector,
  ): Promise<ArtifactRecord | undefined> {
    const context = await this.resolveWorkItem(input);
    const status = this.dependencies.store.getStatus(context.workItem.id);
    const run = [...status.runs]
      .reverse()
      .find((candidate) =>
        ['provider_complete', 'awaiting_publish', 'published'].includes(
          candidate.status,
        ),
      );
    const branch =
      run?.expectedBranch ??
      context.workItem.currentBranch ??
      context.workItem.baseBranch;
    if (run === undefined) {
      const observed = await this.dependencies.github.reconcile({
        repo: context.project.repo,
        branch,
        ...(context.workItem.pullRequest === undefined
          ? {}
          : { pullRequest: context.workItem.pullRequest }),
      });
      return this.persistArtifact(context.workItem.id, observed);
    }
    return (await this.reconcileRun(context, run, branch)).artifact;
  }

  async status(input: WorkItemSelector): Promise<RelayStatus> {
    const context = await this.resolveWorkItem(input);
    const before = this.dependencies.store.getStatus(context.workItem.id);
    const currentByProvider = new Map<ProviderName, SessionRecord>();
    for (const name of ['claude', 'codex', 'jules'] as const) {
      const session = this.dependencies.store.getSession(
        context.workItem.id,
        name,
      );
      if (session !== undefined) currentByProvider.set(name, session);
    }

    for (const [name, session] of currentByProvider) {
      if (session.status !== 'active') continue;
      const provider = this.provider(name);
      if (provider.inspect === undefined) continue;
      const run = [...before.runs]
        .reverse()
        .find(
          (candidate) =>
            candidate.provider === name && ACTIVE_RUN_STATUSES.has(candidate.status),
        );
      if (run === undefined) continue;
      const config = this.providerConfig(context.project.id, name);
      const inspection = await provider.inspect({
        providerSessionId: session.providerSessionId,
        ...optionalString(config, 'environmentId'),
      });
      const execution: ProviderExecution = {
        providerSessionId: session.providerSessionId,
        status: inspection.status,
        ...(inspection.url === undefined ? {} : { url: inspection.url }),
      };
      this.dependencies.store.upsertSession({
        workItemId: context.workItem.id,
        provider: name,
        providerSessionId: session.providerSessionId,
        status: sessionStatusFor(execution.status),
        ...(session.branch === undefined ? {} : { branch: session.branch }),
        ...(inspection.url === undefined
          ? session.providerUrl === undefined
            ? {}
            : { providerUrl: session.providerUrl }
          : { providerUrl: inspection.url }),
      });
      const updated = this.applyProviderStatus(run, execution);
      if (ACTIVE_RUN_STATUSES.has(updated.status)) {
        if (updated.mutationMode === 'write') {
          this.dependencies.store.acquireMutationLease(
            context.workItem.id,
            updated.id,
          );
        }
      } else {
        try {
          await this.reconcileRun(
            context,
            updated,
            updated.expectedBranch ??
              context.workItem.currentBranch ??
              context.workItem.baseBranch,
          );
        } finally {
          if (updated.mutationMode === 'write') {
            this.dependencies.store.releaseMutationLease(
              context.workItem.id,
              updated.id,
            );
          }
        }
      }
    }

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
      (['claude', 'codex', 'jules'] as const).map(async (name) => [
        name,
        await this.provider(name).capabilities(),
      ] as const),
    );
    return Object.fromEntries(entries) as Record<
      ProviderName,
      ProviderCapabilities
    >;
  }

  async chat(
    providerName: ProviderName,
    input: WorkItemSelector,
  ): Promise<number> {
    const context = await this.resolveWorkItem(input);
    const session = this.dependencies.store.getSession(
      context.workItem.id,
      providerName,
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
    return await provider.attach({
      providerSessionId: session.providerSessionId,
      cwd: context.project.locatorPath,
    });
  }

  async merge(input: MergeRequest): Promise<void> {
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
    await this.dependencies.github.merge({
      repo: context.project.repo,
      pullRequest: artifact.pullRequest,
      expectedSha: artifact.sha,
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
        : `relay/${slug(title)}-${id.slice(0, 8)}`;
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

  private async executeStart(
    input: StartExecutionInput,
  ): Promise<RelayRunResult> {
    const provider = this.provider(input.provider);
    const lineage = this.lineage(input.parentRunId, input.provider);
    const baselineSha = await this.dependencies.github.getBranchSha(
      input.project.repo,
      input.expectedBranch,
    );
    if (
      input.mode === 'read' &&
      input.pinnedSha !== undefined &&
      baselineSha !== input.pinnedSha
    ) {
      throw new RelayError(
        'head_moved',
        `Branch ${input.expectedBranch} moved before the delegated review started.`,
        { expectedSha: input.pinnedSha, observedSha: baselineSha },
      );
    }
    const pinnedSha =
      input.mode === 'read' ? input.pinnedSha ?? baselineSha : undefined;
    const executionPrompt =
      input.mode === 'read' && pinnedSha !== undefined
        ? `${input.prompt}\nPinned commit: ${pinnedSha}`
        : input.prompt;
    const pendingSession = this.dependencies.store.upsertSession({
      workItemId: input.workItem.id,
      provider: input.provider,
      providerSessionId: `pending:${randomUUID()}`,
      status: 'pending',
      branch: input.expectedBranch,
    });
    let run: RunRecord;
    try {
      run = this.dependencies.store.createRun({
        sessionId: pendingSession.id,
        provider: input.provider,
        type: input.type,
        ...(this.storePrompts ? { prompt: executionPrompt } : {}),
        mutationMode: input.mode,
        expectedBranch: input.expectedBranch,
        ...(baselineSha === undefined ? {} : { baselineSha }),
        ...(pinnedSha === undefined ? {} : { pinnedSha }),
        ...lineage,
      });
    } catch (error) {
      this.dependencies.store.activateSession(pendingSession.id, {
        providerSessionId: pendingSession.providerSessionId,
        status: 'failed',
        branch: input.expectedBranch,
      });
      throw error;
    }
    let leaseHeld = false;
    let providerExecution: ProviderExecution | undefined;
    try {
      if (input.mode === 'write') {
        this.dependencies.store.acquireMutationLease(
          input.workItem.id,
          run.id,
        );
        leaseHeld = true;
      }
      run = this.dependencies.store.transitionRun(run.id, 'running');
      const config = this.providerConfig(input.project.id, input.provider);
      const execution = await provider.start({
        prompt: executionPrompt,
        cwd: input.project.locatorPath,
        mode: input.mode,
        branch: input.startBranch,
        repo: input.project.repo,
        title: input.workItem.title,
        ...optionalString(config, 'environmentId'),
        ...optionalString(config, 'source'),
      });
      providerExecution = execution;
      const session = this.dependencies.store.activateSession(
        pendingSession.id,
        {
          providerSessionId: execution.providerSessionId,
          status: sessionStatusFor(execution.status),
          branch: input.expectedBranch,
          ...(execution.url === undefined ? {} : { providerUrl: execution.url }),
        },
      );
      run = this.applyProviderStatus(run, execution);
      const reconciled = await this.reconcileRun(
        { project: input.project, workItem: input.workItem },
        run,
        input.expectedBranch,
      );
      run = reconciled.run;
      if (!ACTIVE_RUN_STATUSES.has(run.status) && leaseHeld) {
        this.dependencies.store.releaseMutationLease(
          input.workItem.id,
          run.id,
        );
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
      if (providerExecution === undefined) {
        run = this.failRunIfActive(run);
        this.dependencies.store.activateSession(pendingSession.id, {
          providerSessionId: pendingSession.providerSessionId,
          status: 'failed',
          branch: input.expectedBranch,
        });
      } else {
        run = this.dependencies.store.getRun(run.id);
        this.dependencies.store.activateSession(pendingSession.id, {
          providerSessionId: providerExecution.providerSessionId,
          status: sessionStatusFor(providerExecution.status),
          branch: input.expectedBranch,
          ...(providerExecution.url === undefined
            ? {}
            : { providerUrl: providerExecution.url }),
        });
      }
      if (leaseHeld && !ACTIVE_RUN_STATUSES.has(run.status)) {
        this.dependencies.store.releaseMutationLease(
          input.workItem.id,
          run.id,
        );
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
      ...(pullRequest === undefined ? {} : { pullRequest }),
    });
    const artifact = this.persistArtifact(context.workItem.id, observed);

    if (
      run.mutationMode === 'read' &&
      run.pinnedSha !== undefined &&
      observed.sha !== undefined &&
      observed.sha !== run.pinnedSha
    ) {
      throw new RelayError(
        'head_moved',
        `Branch ${branch} moved while the read-only run was inspecting it.`,
        { expectedSha: run.pinnedSha, observedSha: observed.sha },
      );
    }

    if (observed.status === 'awaiting_publish') {
      if (run.status === 'provider_complete') {
        run = this.dependencies.store.transitionRun(run.id, 'awaiting_publish');
      }
      return { run };
    }
    if (
      run.mutationMode === 'write' &&
      run.baselineSha !== undefined &&
      observed.sha === run.baselineSha
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
      this.dependencies.store.markArtifactMissing(workItemId, observed.branch);
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
    lines.push(
      `Target branch: ${input.workItem.currentBranch ?? input.workItem.baseBranch}`,
      'Push durable code changes to the target GitHub branch. Do not merge.',
    );
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
