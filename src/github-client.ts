import * as z from 'zod/v4';

import { RelayError } from './errors.js';
import { ProcessRunner, type RunOptions } from './process-runner.js';
import type { CheckSummary } from './state-store.js';

const projectSchema = z.object({
  nameWithOwner: z.string().min(3),
  defaultBranchRef: z.object({ name: z.string().min(1) }),
  url: z.url(),
});

const refSchema = z.object({
  ref: z.string(),
  object: z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/i), type: z.string() }),
});

const pullRequestSchema = z.object({
  number: z.number().int().positive(),
  url: z.url(),
  state: z.string(),
  headRefName: z.string(),
  headRefOid: z.string().regex(/^[0-9a-f]{40}$/i),
  baseRefName: z.string(),
  isDraft: z.boolean(),
});

const pullRequestViewSchema = z.object({
  headRefOid: z.string().regex(/^[0-9a-f]{40}$/i),
  isDraft: z.boolean(),
  mergeable: z.string(),
  mergeStateStatus: z.string(),
  reviewDecision: z.string().nullable().optional(),
  statusCheckRollup: z.array(z.unknown()),
});

const checkSchema = z.object({
  name: z.string(),
  state: z.string(),
  bucket: z.string(),
  link: z.string(),
});

export interface DetectedProject {
  repo: string;
  defaultBranch: string;
  url: string;
}

export interface GitHubArtifact {
  status: 'awaiting_publish' | 'published' | 'verified';
  branch: string;
  checks: CheckSummary;
  sha?: string;
  pullRequest?: number;
  pullRequestUrl?: string;
  draft?: boolean;
  mergeable?: boolean;
  mergeStateStatus?: string;
  reviewDecision?: string;
}

export type MergeStrategy = 'merge' | 'rebase' | 'squash';

export interface MergeInput {
  repo: string;
  pullRequest: number;
  expectedSha: string;
  strategy: MergeStrategy;
  approved: boolean;
}

interface GitHubClientOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export class GitHubClient {
  constructor(
    private readonly runner: ProcessRunner,
    private readonly options: GitHubClientOptions = {},
  ) {}

  async detectProject(cwd: string): Promise<DetectedProject> {
    const project = await this.runJson(
      [
        'repo',
        'view',
        '--json',
        'nameWithOwner,defaultBranchRef,url',
      ],
      projectSchema,
      cwd,
    );
    return {
      repo: project.nameWithOwner,
      defaultBranch: project.defaultBranchRef.name,
      url: project.url,
    };
  }

  async reconcile(input: {
    repo: string;
    branch: string;
    pullRequest?: number;
  }): Promise<GitHubArtifact> {
    let reference: z.infer<typeof refSchema>;
    try {
      reference = await this.runJson(
        ['api', `repos/${input.repo}/git/ref/heads/${input.branch}`],
        refSchema,
      );
    } catch (error) {
      if (isNotFound(error)) {
        return {
          status: 'awaiting_publish',
          branch: input.branch,
          checks: 'unknown',
        };
      }
      throw error;
    }

    const pullRequest =
      input.pullRequest === undefined
        ? (
            await this.runJson(
              [
                'pr',
                'list',
                '--repo',
                input.repo,
                '--head',
                input.branch,
                '--state',
                'all',
                '--json',
                'number,url,state,headRefName,headRefOid,baseRefName,isDraft',
              ],
              z.array(pullRequestSchema),
            )
          )[0]
        : undefined;
    const pullRequestNumber = input.pullRequest ?? pullRequest?.number;

    if (pullRequestNumber === undefined) {
      return {
        status: 'published',
        branch: input.branch,
        sha: reference.object.sha,
        checks: 'unknown',
      };
    }

    const view = await this.inspectPullRequest(input.repo, pullRequestNumber);
    const artifact: GitHubArtifact = {
      status: 'verified',
      branch: input.branch,
      sha: reference.object.sha,
      pullRequest: pullRequestNumber,
      checks: view.checks,
      draft: view.data.isDraft,
      mergeable: view.data.mergeable === 'MERGEABLE',
      mergeStateStatus: view.data.mergeStateStatus,
    };
    if (pullRequest?.url !== undefined) artifact.pullRequestUrl = pullRequest.url;
    if (view.data.reviewDecision !== null && view.data.reviewDecision !== undefined) {
      artifact.reviewDecision = view.data.reviewDecision;
    }
    return artifact;
  }

  async merge(input: MergeInput): Promise<void> {
    if (!input.approved) {
      throw new RelayError(
        'merge_not_approved',
        'Merge requires explicit human approval.',
      );
    }
    if (!/^[0-9a-f]{40}$/i.test(input.expectedSha)) {
      throw new RelayError(
        'invalid_argument',
        'Merge approval must be bound to a full commit SHA.',
      );
    }

    const view = await this.inspectPullRequest(input.repo, input.pullRequest);
    if (view.data.headRefOid !== input.expectedSha) {
      throw new RelayError(
        'head_moved',
        `Pull request #${input.pullRequest} moved after approval.`,
        { expectedSha: input.expectedSha, observedSha: view.data.headRefOid },
      );
    }

    const reviewBlocksMerge =
      view.data.reviewDecision === 'CHANGES_REQUESTED' ||
      view.data.reviewDecision === 'REVIEW_REQUIRED';
    const mergeStateBlocks = new Set(['BLOCKED', 'DIRTY', 'UNKNOWN']).has(
      view.data.mergeStateStatus,
    );
    if (
      view.data.isDraft ||
      view.data.mergeable !== 'MERGEABLE' ||
      mergeStateBlocks ||
      reviewBlocksMerge ||
      view.checks !== 'passing'
    ) {
      throw new RelayError(
        'merge_not_ready',
        `Pull request #${input.pullRequest} has not passed every merge gate.`,
        {
          checks: view.checks,
          draft: view.data.isDraft,
          mergeable: view.data.mergeable,
          mergeStateStatus: view.data.mergeStateStatus,
          reviewDecision: view.data.reviewDecision,
        },
      );
    }

    await this.runner.run(
      'gh',
      [
        'pr',
        'merge',
        String(input.pullRequest),
        '--repo',
        input.repo,
        `--${input.strategy}`,
        '--match-head-commit',
        input.expectedSha,
      ],
      this.runOptions(),
    );
  }

  private async inspectPullRequest(repo: string, pullRequest: number) {
    const data = await this.runJson(
      [
        'pr',
        'view',
        String(pullRequest),
        '--repo',
        repo,
        '--json',
        'headRefOid,isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup',
      ],
      pullRequestViewSchema,
    );
    const checks = await this.requiredChecks(repo, pullRequest);
    return { data, checks };
  }

  private async requiredChecks(
    repo: string,
    pullRequest: number,
  ): Promise<CheckSummary> {
    const args = [
      'pr',
      'checks',
      String(pullRequest),
      '--repo',
      repo,
      '--required',
      '--json',
      'name,state,bucket,link',
    ];
    let stdout: string;
    try {
      stdout = (await this.runner.run('gh', args, this.runOptions())).stdout;
    } catch (error) {
      if (!(error instanceof RelayError) || error.code !== 'process_failed') {
        throw error;
      }
      stdout = String(error.details?.stdout ?? '');
      if (stdout === '') throw error;
    }

    const checks = this.parseJson(stdout, z.array(checkSchema));
    if (checks.some((check) => ['fail', 'cancel'].includes(check.bucket))) {
      return 'failing';
    }
    if (checks.some((check) => check.bucket === 'pending')) return 'pending';
    return 'passing';
  }

  private async runJson<T>(
    args: readonly string[],
    schema: z.ZodType<T>,
    cwd?: string,
  ): Promise<T> {
    const result = await this.runner.run('gh', args, this.runOptions(cwd));
    return this.parseJson(result.stdout, schema);
  }

  private parseJson<T>(text: string, schema: z.ZodType<T>): T {
    try {
      return schema.parse(JSON.parse(text));
    } catch (cause) {
      throw new RelayError(
        'provider_output_invalid',
        'GitHub CLI returned malformed structured output.',
        undefined,
        { cause },
      );
    }
  }

  private runOptions(cwd?: string): RunOptions {
    const options: RunOptions = {};
    if (cwd !== undefined) options.cwd = cwd;
    if (this.options.env !== undefined) options.env = this.options.env;
    if (this.options.timeoutMs !== undefined) {
      options.timeoutMs = this.options.timeoutMs;
    }
    return options;
  }
}

function isNotFound(error: unknown): boolean {
  return (
    error instanceof RelayError &&
    error.code === 'process_failed' &&
    /(?:HTTP\s+404|not found)/i.test(String(error.details?.stderr ?? ''))
  );
}
