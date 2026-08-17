import * as z from 'zod/v4';

import { RelayError } from './errors.js';
import { ProcessRunner, type RunOptions } from './process-runner.js';
import type { AuthStatus } from './provider.js';
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
  number: z.number().int().positive(),
  url: z.url(),
  state: z.string(),
  headRefName: z.string(),
  headRefOid: z.string().regex(/^[0-9a-f]{40}$/i),
  baseRefName: z.string(),
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

const commitChecksSchema = z.object({
  total_count: z.number().int().nonnegative(),
  check_runs: z.array(
    z.object({
      name: z.string(),
      status: z.string(),
      conclusion: z.string().nullable(),
      html_url: z.url(),
    }),
  ),
});

const createdPullRequestSchema = z.object({
  number: z.number().int().positive(),
  html_url: z.url(),
  state: z.string(),
  head: z.object({
    ref: z.string(),
    sha: z.string().regex(/^[0-9a-f]{40}$/i),
  }),
  base: z.object({ ref: z.string() }),
  draft: z.boolean(),
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
  expectedBaseBranch: string;
  strategy: MergeStrategy;
  approved: boolean;
}

export interface EnsurePullRequestInput {
  repo: string;
  head: string;
  base: string;
  title: string;
  body: string;
}

export interface PullRequestIdentity {
  number: number;
  url: string;
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

  async authStatus(): Promise<AuthStatus> {
    try {
      await this.runner.run(
        'gh',
        ['auth', 'status', '--active'],
        this.runOptions(),
      );
      return { authenticated: true, method: 'gh CLI' };
    } catch (error) {
      if (
        error instanceof RelayError &&
        (error.code === 'command_not_found' || error.code === 'process_failed')
      ) {
        return {
          authenticated: false,
          detail:
            error.code === 'command_not_found'
              ? 'GitHub CLI is not installed.'
              : 'GitHub CLI is not authenticated.',
        };
      }
      throw error;
    }
  }

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

  async getBranchSha(repo: string, branch: string): Promise<string | undefined> {
    try {
      const reference = await this.runJson(
        ['api', `repos/${repo}/git/ref/heads/${branch}`],
        refSchema,
      );
      return reference.object.sha;
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  async reconcile(input: {
    repo: string;
    branch: string;
    expectedBaseBranch: string;
    pullRequest?: number;
  }): Promise<GitHubArtifact> {
    const branchSha = await this.getBranchSha(input.repo, input.branch);
    if (branchSha === undefined) {
      return {
        status: 'awaiting_publish',
        branch: input.branch,
        checks: 'unknown',
      };
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
                'open',
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
        sha: branchSha,
        checks: 'unknown',
      };
    }

    const view = await this.inspectPullRequest(input.repo, pullRequestNumber);
    if (view.data.state !== 'OPEN') {
      throw new RelayError(
        'github_state_mismatch',
        `Pull request #${pullRequestNumber} is not open.`,
      );
    }
    if (view.data.headRefName !== input.branch) {
      throw new RelayError(
        'github_state_mismatch',
        `Pull request #${pullRequestNumber} does not belong to branch ${input.branch}.`,
        {
          expectedBranch: input.branch,
          observedBranch: view.data.headRefName,
        },
      );
    }
    if (view.data.headRefOid !== branchSha) {
      throw new RelayError(
        'github_state_mismatch',
        `Pull request #${pullRequestNumber} does not match the expected branch SHA.`,
        { branchSha, pullRequestSha: view.data.headRefOid },
      );
    }
    this.validatePullRequestBase(
      pullRequestNumber,
      view.data.baseRefName,
      input.expectedBaseBranch,
    );
    const artifact: GitHubArtifact = {
      status: 'verified',
      branch: input.branch,
      sha: view.data.headRefOid,
      pullRequest: pullRequestNumber,
      checks: view.checks,
      draft: view.data.isDraft,
      mergeable: view.data.mergeable === 'MERGEABLE',
      mergeStateStatus: view.data.mergeStateStatus,
    };
    artifact.pullRequestUrl = view.data.url;
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
    this.validatePullRequestBase(
      input.pullRequest,
      view.data.baseRefName,
      input.expectedBaseBranch,
    );
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
      view.data.state !== 'OPEN' ||
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
          state: view.data.state,
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

  async getCommitChecks(repo: string, sha: string): Promise<CheckSummary> {
    if (!/^[0-9a-f]{40}$/i.test(sha)) {
      throw new RelayError(
        'invalid_argument',
        'Commit checks require a full 40-character SHA.',
      );
    }
    const result = await this.runJson(
      ['api', `repos/${repo}/commits/${sha}/check-runs`],
      commitChecksSchema,
    );
    if (result.total_count === 0 || result.check_runs.length === 0) {
      return 'unknown';
    }
    const successful = new Set(['success', 'neutral', 'skipped']);
    if (
      result.check_runs.some(
        (check) =>
          check.status === 'completed' &&
          (check.conclusion === null ||
            !successful.has(check.conclusion.toLowerCase())),
      )
    ) {
      return 'failing';
    }
    if (result.check_runs.some((check) => check.status !== 'completed')) {
      return 'pending';
    }
    return 'passing';
  }

  async ensurePullRequest(
    input: EnsurePullRequestInput,
  ): Promise<PullRequestIdentity> {
    const existing = await this.runJson(
      [
        'pr',
        'list',
        '--repo',
        input.repo,
        '--head',
        input.head,
        '--state',
        'open',
        '--json',
        'number,url,state,headRefName,headRefOid,baseRefName,isDraft',
      ],
      z.array(pullRequestSchema),
    );
    if (existing.length > 1) {
      throw new RelayError(
        'github_state_mismatch',
        `Integration branch ${input.head} has more than one open pull request.`,
      );
    }
    const current = existing[0];
    if (current !== undefined) {
      if (current.headRefName !== input.head) {
        throw new RelayError(
          'github_state_mismatch',
          `Pull request #${current.number} does not belong to branch ${input.head}.`,
        );
      }
      this.validatePullRequestBase(current.number, current.baseRefName, input.base);
      return { number: current.number, url: current.url };
    }

    const created = await this.runJson(
      [
        'api',
        `repos/${input.repo}/pulls`,
        '--method',
        'POST',
        '--field',
        `head=${input.head}`,
        '--field',
        `base=${input.base}`,
        '--field',
        `title=${input.title}`,
        '--field',
        `body=${input.body}`,
      ],
      createdPullRequestSchema,
    );
    if (created.head.ref !== input.head || created.base.ref !== input.base) {
      throw new RelayError(
        'github_state_mismatch',
        'GitHub created a pull request with unexpected branches.',
        {
          expectedHead: input.head,
          observedHead: created.head.ref,
          expectedBase: input.base,
          observedBase: created.base.ref,
        },
      );
    }
    return { number: created.number, url: created.html_url };
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
        'number,url,state,headRefName,headRefOid,baseRefName,isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup',
      ],
      pullRequestViewSchema,
    );
    const checks = await this.requiredChecks(repo, pullRequest);
    return { data, checks };
  }

  private validatePullRequestBase(
    pullRequest: number,
    observed: string,
    expected: string,
  ): void {
    if (observed !== expected) {
      throw new RelayError(
        'github_state_mismatch',
        `Pull request #${pullRequest} targets ${observed}, not WorkItem base ${expected}.`,
        { expectedBaseBranch: expected, observedBaseBranch: observed },
      );
    }
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
