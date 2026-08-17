import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RelayError } from './errors.js';
import { ProcessRunner, type ProcessResult } from './process-runner.js';
import type {
  CandidateRecord,
  CandidateStatus,
  CheckSummary,
  StateStore,
} from './state-store.js';

export interface LandingGitHub {
  getCommitChecks(repo: string, sha: string): Promise<CheckSummary>;
  getBranchSha(repo: string, branch: string): Promise<string | undefined>;
  ensurePullRequest(input: {
    repo: string;
    head: string;
    base: string;
    title: string;
    body: string;
  }): Promise<{ number: number; url: string }>;
}

export interface LandingResult {
  status: CandidateStatus;
  runId: string;
  stagingBranch?: string;
  stagingSha?: string;
  landedSha?: string;
  conflictFiles?: readonly string[];
}

export interface LandingCoordinatorDependencies {
  store: StateStore;
  github: LandingGitHub;
  runner?: ProcessRunner;
}

export class LandingCoordinator {
  private readonly runner: ProcessRunner;

  constructor(private readonly dependencies: LandingCoordinatorDependencies) {
    this.runner = dependencies.runner ?? new ProcessRunner();
  }

  async land(runId: string): Promise<LandingResult> {
    const candidate = this.dependencies.store.getCandidate(runId);
    if (candidate === undefined) {
      throw new RelayError('not_found', `Candidate ${runId} was not found.`);
    }
    if (candidate.status === 'landed' || candidate.status === 'discarded') {
      return resultFor(candidate);
    }

    this.dependencies.store.acquireLandingLease(candidate.workItemId, runId);
    try {
      const current = this.dependencies.store.getCandidate(runId);
      if (current === undefined) {
        throw new RelayError('not_found', `Candidate ${runId} was not found.`);
      }
      if (current.status === 'landed' || current.status === 'discarded') {
        return resultFor(current);
      }
      return current.status === 'staged'
        ? await this.finish(current)
        : await this.prepare(current);
    } finally {
      this.dependencies.store.releaseLandingLease(candidate.workItemId, runId);
    }
  }

  private async prepare(candidate: CandidateRecord): Promise<LandingResult> {
    const { project, workItem } = this.context(candidate);
    const integrationBranch = candidate.integrationBranch;
    if (!isSafeIntegrationBranch(integrationBranch, workItem.baseBranch)) {
      return this.status(candidate.runId, 'stale');
    }
    const sourceHead = await this.remoteSha(
      project.locatorPath,
      candidate.sourceBranch,
    );
    if (sourceHead !== candidate.sourceSha) {
      return this.status(candidate.runId, 'stale');
    }
    const observedIntegrationHead = await this.remoteSha(
      project.locatorPath,
      integrationBranch,
    );
    const integrationRefExisted = observedIntegrationHead !== undefined;
    const integrationHead =
      observedIntegrationHead ??
      (await this.remoteSha(project.locatorPath, workItem.baseBranch));
    if (integrationHead === undefined) {
      return this.status(candidate.runId, 'stale');
    }

    await this.fetchCommit(project.locatorPath, candidate.sourceSha);
    await this.fetchCommit(project.locatorPath, integrationHead);
    if (
      !(await this.isCommit(project.locatorPath, candidate.sourceSha)) ||
      !(await this.isCommit(project.locatorPath, candidate.baseSha)) ||
      !(await this.isAncestor(
        project.locatorPath,
        candidate.baseSha,
        candidate.sourceSha,
      ))
    ) {
      return this.status(candidate.runId, 'stale');
    }

    const preflight = await this.preflightMerge(
      project.locatorPath,
      integrationHead,
      candidate.sourceSha,
    );
    if (preflight.conflictFiles !== undefined) {
      return this.status(candidate.runId, 'conflict', {
        conflictFiles: preflight.conflictFiles,
      });
    }

    const stagingBranch = stageBranch(candidate.runId, integrationHead);
    const existingStage = await this.remoteSha(project.locatorPath, stagingBranch);
    if (existingStage !== undefined) {
      await this.fetchCommit(project.locatorPath, existingStage);
      if (
        await this.isRecoverableStage(
          project.locatorPath,
          candidate,
          existingStage,
          integrationHead,
          preflight.treeSha,
        )
      ) {
        return resultFor(
          this.dependencies.store.recordCandidateStage(candidate.runId, {
            stagingBranch,
            stagingSha: existingStage,
            integrationBaseSha: integrationHead,
            integrationRefExisted,
          }),
        );
      }
      return this.status(candidate.runId, 'stale');
    }

    const temporaryRoot = mkdtempSync(join(tmpdir(), 'relay-stage-'));
    const worktreePath = join(temporaryRoot, 'worktree');
    let worktreeAdded = false;
    try {
      await this.git(
        project.locatorPath,
        'worktree',
        'add',
        '--detach',
        worktreePath,
        integrationHead,
      );
      worktreeAdded = true;
      await this.git(worktreePath, 'merge', '--squash', candidate.sourceSha);
      await this.git(
        worktreePath,
        '-c',
        'user.name=Relay',
        '-c',
        'user.email=relay@localhost',
        'commit',
        '-m',
        candidateCommitSubject(candidate.runId),
        '-m',
        candidateCommitTrailers(candidate),
      );
      const stagingSha = (
        await this.git(worktreePath, 'rev-parse', 'HEAD')
      ).stdout.trim();
      await this.git(
        worktreePath,
        'push',
        'origin',
        `HEAD:refs/heads/${stagingBranch}`,
      );
      const observedStage = await this.remoteSha(
        project.locatorPath,
        stagingBranch,
      );
      if (observedStage !== stagingSha) {
        return this.status(candidate.runId, 'stale');
      }
      return resultFor(
        this.dependencies.store.recordCandidateStage(candidate.runId, {
          stagingBranch,
          stagingSha,
          integrationBaseSha: integrationHead,
          integrationRefExisted,
        }),
      );
    } finally {
      if (worktreeAdded) {
        await this.cleanTemporaryWorktree(project.locatorPath, worktreePath);
      }
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }

  private async finish(candidate: CandidateRecord): Promise<LandingResult> {
    const { project, workItem } = this.context(candidate);
    const integrationBranch = candidate.integrationBranch;
    if (
      !isSafeIntegrationBranch(integrationBranch, workItem.baseBranch) ||
      candidate.stagingBranch === undefined ||
      candidate.stagingSha === undefined ||
      candidate.integrationBaseSha === undefined ||
      candidate.integrationRefExisted === undefined
    ) {
      return this.status(candidate.runId, 'stale');
    }

    const checks = await this.dependencies.github.getCommitChecks(
      project.repo,
      candidate.stagingSha,
    );
    if (checks === 'pending' || checks === 'unknown') return resultFor(candidate);
    if (checks === 'failing') {
      return this.status(candidate.runId, 'checks_failed');
    }

    const [integrationHead, stageHead, baseHead] = await Promise.all([
      this.remoteSha(project.locatorPath, integrationBranch),
      this.remoteSha(project.locatorPath, candidate.stagingBranch),
      candidate.integrationRefExisted
        ? Promise.resolve(undefined)
        : this.remoteSha(project.locatorPath, workItem.baseBranch),
    ]);
    if (stageHead !== candidate.stagingSha) {
      return this.status(candidate.runId, 'stale');
    }
    const integrationIsExpected = candidate.integrationRefExisted
      ? integrationHead === candidate.integrationBaseSha ||
        integrationHead === candidate.stagingSha
      : (integrationHead === undefined &&
          baseHead === candidate.integrationBaseSha) ||
        integrationHead === candidate.stagingSha;
    if (!integrationIsExpected) {
      return this.status(candidate.runId, 'stale');
    }

    if (integrationHead !== candidate.stagingSha) {
      await this.fetchCommit(project.locatorPath, candidate.stagingSha);
      try {
        await this.git(
          project.locatorPath,
          'push',
          'origin',
          `${candidate.stagingSha}:refs/heads/${integrationBranch}`,
        );
      } catch (error) {
        const racedHead = await this.remoteSha(
          project.locatorPath,
          integrationBranch,
        );
        if (racedHead !== candidate.stagingSha) {
          return this.status(candidate.runId, 'stale');
        }
      }
    }

    const pullRequest = await this.dependencies.github.ensurePullRequest({
      repo: project.repo,
      head: integrationBranch,
      base: workItem.baseBranch,
      title: workItem.title,
      body: [
        'Prepared by Relay from an immutable staged candidate.',
        '',
        `Run: ${candidate.runId}`,
        `Source: ${candidate.sourceBranch} @ ${candidate.sourceSha}`,
      ].join('\n'),
    });
    const observed = await this.dependencies.github.getBranchSha(
      project.repo,
      integrationBranch,
    );
    if (observed !== candidate.stagingSha) {
      return this.status(candidate.runId, 'stale');
    }
    this.dependencies.store.saveArtifact({
      workItemId: workItem.id,
      branch: integrationBranch,
      sha: candidate.stagingSha,
      status: 'verified',
      pullRequest: pullRequest.number,
      checks: 'passing',
    });
    return this.status(candidate.runId, 'landed', {
      landedSha: candidate.stagingSha,
    });
  }

  private context(candidate: CandidateRecord) {
    const workItem = this.dependencies.store.getWorkItem(candidate.workItemId);
    const project = this.dependencies.store.getProject(workItem.projectId);
    return { project, workItem };
  }

  private status(
    runId: string,
    status: Exclude<CandidateStatus, 'ready' | 'staged'>,
    input: { landedSha?: string; conflictFiles?: readonly string[] } = {},
  ): LandingResult {
    return resultFor(
      this.dependencies.store.setCandidateStatus(runId, status, input),
    );
  }

  private async remoteSha(
    repositoryPath: string,
    branch: string,
  ): Promise<string | undefined> {
    const result = await this.git(
      repositoryPath,
      'ls-remote',
      '--heads',
      'origin',
      `refs/heads/${branch}`,
    );
    const line = result.stdout.trim();
    if (line === '') return undefined;
    const [sha, reference] = line.split(/\s+/, 2);
    if (!isFullSha(sha) || reference !== `refs/heads/${branch}`) {
      throw new RelayError(
        'provider_output_invalid',
        `Git returned an invalid remote ref for ${branch}.`,
      );
    }
    return sha;
  }

  private async fetchCommit(repositoryPath: string, sha: string): Promise<void> {
    await this.git(repositoryPath, 'fetch', '--no-tags', 'origin', sha);
  }

  private async isCommit(repositoryPath: string, sha: string): Promise<boolean> {
    try {
      await this.git(repositoryPath, 'cat-file', '-e', `${sha}^{commit}`);
      return true;
    } catch (error) {
      if (isGitFailure(error)) return false;
      throw error;
    }
  }

  private async isAncestor(
    repositoryPath: string,
    ancestor: string,
    descendant: string,
  ): Promise<boolean> {
    try {
      await this.git(
        repositoryPath,
        'merge-base',
        '--is-ancestor',
        ancestor,
        descendant,
      );
      return true;
    } catch (error) {
      if (isGitFailure(error)) return false;
      throw error;
    }
  }

  private async preflightMerge(
    repositoryPath: string,
    integrationSha: string,
    sourceSha: string,
  ): Promise<{
    treeSha: string;
    conflictFiles?: readonly string[];
  }> {
    try {
      const result = await this.git(
        repositoryPath,
        'merge-tree',
        '--write-tree',
        '--name-only',
        '--no-messages',
        '-z',
        integrationSha,
        sourceSha,
      );
      const treeSha = result.stdout.split('\0', 1)[0];
      if (!isFullSha(treeSha)) {
        throw new RelayError(
          'provider_output_invalid',
          'Git returned an invalid preflight merge tree.',
        );
      }
      return { treeSha };
    } catch (error) {
      if (!isGitFailure(error)) throw error;
      const fields = String(error.details?.stdout ?? '').split('\0');
      const tree = fields.shift();
      const files = fields.filter((path) => path !== '');
      if (!isFullSha(tree)) throw error;
      if (files.length === 0) throw error;
      return { treeSha: tree, conflictFiles: [...new Set(files)].sort() };
    }
  }

  private async isRecoverableStage(
    repositoryPath: string,
    candidate: CandidateRecord,
    stagingSha: string,
    integrationBaseSha: string,
    expectedTreeSha: string,
  ): Promise<boolean> {
    if (!(await this.isCommit(repositoryPath, stagingSha))) return false;
    const [parents, tree, message] = await Promise.all([
      this.git(repositoryPath, 'show', '-s', '--format=%P', stagingSha),
      this.git(repositoryPath, 'show', '-s', '--format=%T', stagingSha),
      this.git(repositoryPath, 'show', '-s', '--format=%B', stagingSha),
    ]);
    return (
      parents.stdout.trim() === integrationBaseSha &&
      tree.stdout.trim() === expectedTreeSha &&
      message.stdout.trimEnd() === candidateCommitMessage(candidate)
    );
  }

  private async cleanTemporaryWorktree(
    repositoryPath: string,
    worktreePath: string,
  ): Promise<void> {
    if (existsSync(worktreePath)) {
      await this.git(worktreePath, 'reset', '--merge', 'HEAD');
      await this.git(worktreePath, 'clean', '-fd');
      await this.git(repositoryPath, 'worktree', 'remove', worktreePath);
    }
    await this.git(repositoryPath, 'worktree', 'prune');
  }

  private async git(
    cwd: string,
    ...args: readonly string[]
  ): Promise<ProcessResult> {
    return await this.runner.run('git', args, { cwd, timeoutMs: 120_000 });
  }
}

function resultFor(candidate: CandidateRecord): LandingResult {
  const result: LandingResult = {
    status: candidate.status,
    runId: candidate.runId,
  };
  if (candidate.stagingBranch !== undefined) {
    result.stagingBranch = candidate.stagingBranch;
  }
  if (candidate.stagingSha !== undefined) result.stagingSha = candidate.stagingSha;
  if (candidate.landedSha !== undefined) result.landedSha = candidate.landedSha;
  if (candidate.conflictFiles.length > 0) {
    result.conflictFiles = candidate.conflictFiles;
  }
  return result;
}

function stageBranch(runId: string, integrationSha: string): string {
  const prefix = runId.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 12);
  return `relay/stage/${prefix || 'candidate'}-${integrationSha.slice(0, 8)}`;
}

function candidateCommitSubject(runId: string): string {
  return `Relay candidate ${runId}`;
}

function candidateCommitTrailers(candidate: CandidateRecord): string {
  return [
    `Relay-Run: ${candidate.runId}`,
    `Relay-Source-SHA: ${candidate.sourceSha}`,
    `Relay-Base-SHA: ${candidate.baseSha}`,
  ].join('\n');
}

function candidateCommitMessage(candidate: CandidateRecord): string {
  return `${candidateCommitSubject(candidate.runId)}\n\n${candidateCommitTrailers(candidate)}`;
}

function isSafeIntegrationBranch(branch: string, baseBranch: string): boolean {
  return (
    branch.startsWith('relay/work/') &&
    branch.length > 'relay/work/'.length &&
    branch !== baseBranch
  );
}

function isFullSha(value: string | undefined): value is string {
  return value !== undefined && /^[0-9a-f]{40}$/i.test(value);
}

function isGitFailure(error: unknown): error is RelayError {
  return error instanceof RelayError && error.code === 'process_failed';
}
