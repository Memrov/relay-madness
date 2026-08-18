import { mkdir } from 'node:fs/promises';

import * as z from 'zod/v4';

import { RelayError } from '../errors.js';
import type {
  AttachInput,
  AuthStatus,
  CloudProvider,
  InspectRunInput,
  ProviderCapabilities,
  ProviderExecution,
  ProviderInspection,
  ProviderRunStatus,
  SendRunInput,
  StartRunInput,
} from '../provider.js';
import {
  ProcessRunner,
  type InteractiveOptions,
  type RunOptions,
} from '../process-runner.js';

const PROFILE_CONFIG_ARGS = [
  '-c',
  'cli_auth_credentials_store="file"',
  '-c',
  'forced_login_method="chatgpt"',
] as const;
const PROFILE_CREDENTIAL_OVERRIDES = [
  'OPENAI_API_KEY',
  'CODEX_ACCESS_TOKEN',
] as const;

const diffSummarySchema = z.object({
  files_changed: z.number().int().nonnegative(),
  lines_added: z.number().int().nonnegative(),
  lines_removed: z.number().int().nonnegative(),
});

const taskSchema = z.object({
  id: z.string().min(1),
  url: z.url(),
  title: z.string(),
  status: z.string(),
  updated_at: z.iso.datetime(),
  environment_id: z.string().nullable(),
  environment_label: z.string(),
  summary: z.union([z.string(), diffSummarySchema]),
  is_review: z.boolean(),
  attempt_total: z.number().int().nonnegative(),
});

const taskListSchema = z.object({
  tasks: z.array(taskSchema),
  cursor: z.string().nullable().optional(),
});

interface CodexProviderOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export class CodexProvider implements CloudProvider {
  readonly name = 'codex' as const;

  constructor(
    private readonly runner: ProcessRunner,
    private readonly options: CodexProviderOptions = {},
  ) {}

  async capabilities(): Promise<ProviderCapabilities> {
    const available = await this.cloudAvailable();
    return {
      start: available,
      structuredStart: false,
      queueFollowup: false,
      interactiveAttach: available,
      structuredStatus: available,
      events: false,
      selectBranch: true,
      controlledResultBranch: available,
      publishPullRequest: false,
      cancel: false,
      subscriptionAuth: true,
      selectModel: available,
      profileIsolation: available,
      reportsProfileIdentity: false,
    };
  }

  async authStatus(profilePath?: string): Promise<AuthStatus> {
    try {
      const result = await this.runner.run(
        'codex',
        ['login', 'status', ...profileConfigArgs(profilePath)],
        this.runOptions(undefined, profilePath),
      );
      const reportedMethod = result.stdout
        .trim()
        .match(/^Logged in using\s+(.+)$/i)?.[1];
      if (reportedMethod === undefined) {
        throw new RelayError(
          'provider_output_invalid',
          'Codex authentication status did not report a login method.',
        );
      }
      const method = reportedMethod.replace(/^an?\s+/i, '');
      if (method.toLowerCase() !== 'chatgpt') {
        return {
          authenticated: false,
          method,
          detail: 'Codex Cloud requires ChatGPT authentication.',
        };
      }
      return { authenticated: true, method: 'ChatGPT' };
    } catch (error) {
      if (
        error instanceof RelayError &&
        (error.code === 'command_not_found' || error.code === 'process_failed')
      ) {
        return {
          authenticated: false,
          detail:
            error.code === 'command_not_found'
              ? 'Codex CLI is not installed.'
              : 'Codex CLI is not authenticated.',
        };
      }
      throw error;
    }
  }

  async loginProfile(profilePath: string): Promise<AuthStatus> {
    await ensureProfileDirectory(profilePath);
    const current = await this.authStatus(profilePath);
    if (current.authenticated) return current;

    const exitCode = await this.runner.spawnInteractive(
      'codex',
      ['login', ...PROFILE_CONFIG_ARGS],
      this.interactiveOptions(undefined, profilePath),
    );
    if (exitCode !== 0) {
      throw new RelayError(
        'process_failed',
        `Codex profile login exited with ${exitCode}.`,
        { command: 'codex', exitCode },
      );
    }
    return await this.authStatus(profilePath);
  }

  async start(input: StartRunInput): Promise<ProviderExecution> {
    const environmentId = requireEnvironment(input.environmentId);
    const args = [
      'cloud',
      'exec',
      '--env',
      environmentId,
      ...profileConfigArgs(input.profilePath),
    ];
    if (input.model !== undefined) args.push('-c', `model="${validatedModel(input.model)}"`);
    const branch = input.resultBranch ?? input.startingBranch;
    if (branch !== undefined) args.push('--branch', branch);
    args.push(input.prompt);

    const result = await this.runner.run(
      'codex',
      args,
      this.runOptions(input.cwd, input.profilePath),
    );
    return parseSubmission(result.stdout);
  }

  async send(_input: SendRunInput): Promise<ProviderExecution> {
    throw new RelayError(
      'capability_unavailable',
      'Codex cloud does not document a noninteractive follow-up command.',
    );
  }

  async inspect(input: InspectRunInput): Promise<ProviderInspection> {
    const environmentId = requireEnvironment(input.environmentId);
    const result = await this.runner.run(
      'codex',
      [
        'cloud',
        'list',
        '--env',
        environmentId,
        '--json',
        '--limit',
        '20',
        ...profileConfigArgs(input.profilePath),
      ],
      this.runOptions(undefined, input.profilePath),
    );
    const tasks = parseTaskList(result.stdout);
    const task = tasks.find((candidate) => candidate.id === input.providerSessionId);
    if (task === undefined) {
      throw new RelayError(
        'not_found',
        `Codex cloud task ${input.providerSessionId} was not in the recent task list.`,
      );
    }
    return {
      status: mapCodexStatus(task.status),
      url: task.url,
      summary: formatSummary(task.summary),
    };
  }

  async attach(input: AttachInput): Promise<number> {
    return await this.runner.spawnInteractive(
      'codex',
      ['cloud', ...profileConfigArgs(input.profilePath)],
      this.interactiveOptions(input.cwd, input.profilePath),
    );
  }

  private async cloudAvailable(): Promise<boolean> {
    try {
      await this.runner.run('codex', ['cloud', '--help'], this.runOptions());
      return true;
    } catch {
      return false;
    }
  }

  private runOptions(cwd?: string, profilePath?: string): RunOptions {
    const options: RunOptions = {};
    if (cwd !== undefined) options.cwd = cwd;
    if (this.options.env !== undefined || profilePath !== undefined) {
      options.env = {
        ...this.options.env,
        ...(profilePath === undefined
          ? {}
          : {
              CODEX_HOME: profilePath,
              CODEX_SQLITE_HOME: profilePath,
            }),
      };
    }
    if (this.options.timeoutMs !== undefined) {
      options.timeoutMs = this.options.timeoutMs;
    }
    if (profilePath !== undefined) {
      options.unsetEnv = PROFILE_CREDENTIAL_OVERRIDES;
    }
    return options;
  }

  private interactiveOptions(
    cwd: string | undefined,
    profilePath?: string,
  ): InteractiveOptions {
    const options: InteractiveOptions = {};
    if (cwd !== undefined) options.cwd = cwd;
    if (this.options.env !== undefined || profilePath !== undefined) {
      options.env = {
        ...this.options.env,
        ...(profilePath === undefined
          ? {}
          : {
              CODEX_HOME: profilePath,
              CODEX_SQLITE_HOME: profilePath,
            }),
      };
    }
    if (profilePath !== undefined) {
      options.unsetEnv = PROFILE_CREDENTIAL_OVERRIDES;
    }
    return options;
  }
}

function profileConfigArgs(profilePath: string | undefined): readonly string[] {
  return profilePath === undefined ? [] : PROFILE_CONFIG_ARGS;
}

async function ensureProfileDirectory(profilePath: string): Promise<void> {
  try {
    await mkdir(profilePath, { recursive: true, mode: 0o700 });
  } catch (cause) {
    throw new RelayError(
      'invalid_argument',
      `Unable to create Codex profile directory ${profilePath}.`,
      { profilePath },
      { cause },
    );
  }
}

function requireEnvironment(environmentId: string | undefined): string {
  if (environmentId === undefined || environmentId === '') {
    throw new RelayError(
      'configuration_missing',
      'A Codex cloud environment ID is required for this project.',
    );
  }
  return environmentId;
}

function validatedModel(model: string): string {
  if (!/^[A-Za-z0-9._:-]+$/.test(model)) {
    throw new RelayError(
      'invalid_argument',
      'Codex model names may contain only letters, numbers, dots, underscores, colons, and hyphens.',
    );
  }
  return model;
}

function parseSubmission(output: string): ProviderExecution {
  const urlText = output.trim().match(/https:\/\/[^\s]+/)?.[0];
  if (urlText === undefined) {
    throw new RelayError(
      'provider_output_invalid',
      'Codex cloud output did not include a task URL.',
    );
  }
  try {
    const cleanUrl = urlText.replace(/[),.;]+$/, '');
    const providerSessionId = parseCodexTaskUrl(cleanUrl);
    return { providerSessionId, status: 'running', url: cleanUrl };
  } catch (cause) {
    if (cause instanceof RelayError) throw cause;
    throw new RelayError(
      'provider_output_invalid',
      'Codex cloud returned an invalid task URL.',
      undefined,
      { cause },
    );
  }
}

function parseTaskList(output: string): readonly z.infer<typeof taskSchema>[] {
  try {
    return taskListSchema.parse(JSON.parse(output)).tasks.map((task) => {
      parseCodexTaskUrl(task.url, task.id);
      return task;
    });
  } catch (cause) {
    throw new RelayError(
      'provider_output_invalid',
      'Codex cloud list returned malformed JSON.',
      undefined,
      { cause },
    );
  }
}

function parseCodexTaskUrl(value: string, expectedTaskId?: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (cause) {
    throw new RelayError(
      'provider_output_invalid',
      'Codex cloud returned an invalid task URL.',
      undefined,
      { cause },
    );
  }
  const match = /^\/codex\/tasks\/(task_[A-Za-z0-9]+(?:_[A-Za-z0-9]+)*)$/.exec(
    url.pathname,
  );
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'chatgpt.com' ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    match === null
  ) {
    throw new RelayError(
      'provider_output_invalid',
      'Codex cloud returned an invalid task URL.',
    );
  }
  const taskId = match[1]!;
  if (expectedTaskId !== undefined && taskId !== expectedTaskId) {
    throw new RelayError(
      'provider_output_invalid',
      'Codex cloud task URL did not match its task identifier.',
    );
  }
  return taskId;
}

function formatSummary(summary: z.infer<typeof taskSchema>['summary']): string {
  if (typeof summary === 'string') return summary;
  return `${summary.files_changed} files changed, +${summary.lines_added}/-${summary.lines_removed}`;
}

function mapCodexStatus(status: string): ProviderRunStatus {
  const normalized = status.toLowerCase();
  if (['completed', 'succeeded', 'ready'].includes(normalized)) {
    return 'provider_complete';
  }
  if (['failed', 'error'].includes(normalized)) return 'failed';
  if (['cancelled', 'canceled'].includes(normalized)) return 'cancelled';
  if (normalized === 'expired') return 'expired';
  if (['queued', 'pending'].includes(normalized)) return 'queued';
  return 'running';
}
