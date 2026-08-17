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
import { ProcessRunner, type RunOptions } from '../process-runner.js';

const taskSchema = z.object({
  id: z.string().min(1),
  url: z.url(),
  title: z.string(),
  status: z.string(),
  updated_at: z.iso.datetime(),
  environment_id: z.string(),
  environment_label: z.string(),
  summary: z.string(),
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
      publishPullRequest: false,
      cancel: false,
      subscriptionAuth: true,
      selectModel: available,
      profileIsolation: available,
    };
  }

  async authStatus(): Promise<AuthStatus> {
    try {
      const result = await this.runner.run(
        'codex',
        ['login', 'status'],
        this.runOptions(),
      );
      const method = result.stdout.trim().match(/Logged in using\s+(.+)$/i)?.[1];
      const status: AuthStatus = { authenticated: true };
      if (method !== undefined) status.method = method;
      return status;
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

  async start(input: StartRunInput): Promise<ProviderExecution> {
    const environmentId = requireEnvironment(input.environmentId);
    const args = ['cloud', 'exec', '--env', environmentId];
    if (input.model !== undefined) args.push('-c', `model="${validatedModel(input.model)}"`);
    if (input.branch !== undefined) args.push('--branch', input.branch);
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
      ['cloud', 'list', '--env', environmentId, '--json', '--limit', '20'],
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
      summary: task.summary,
    };
  }

  async attach(input: AttachInput): Promise<number> {
    return await this.runner.spawnInteractive(
      'codex',
      ['cloud'],
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
        ...(profilePath === undefined ? {} : { CODEX_HOME: profilePath }),
      };
    }
    if (this.options.timeoutMs !== undefined) {
      options.timeoutMs = this.options.timeoutMs;
    }
    return options;
  }

  private interactiveOptions(cwd: string, profilePath?: string) {
    const options: { cwd: string; env?: NodeJS.ProcessEnv } = { cwd };
    if (this.options.env !== undefined || profilePath !== undefined) {
      options.env = {
        ...this.options.env,
        ...(profilePath === undefined ? {} : { CODEX_HOME: profilePath }),
      };
    }
    return options;
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
    const url = new URL(cleanUrl);
    const providerSessionId = url.pathname.split('/').filter(Boolean).at(-1);
    if (providerSessionId === undefined || providerSessionId === '') throw new Error();
    return { providerSessionId, status: 'running', url: cleanUrl };
  } catch (cause) {
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
    return taskListSchema.parse(JSON.parse(output)).tasks;
  } catch (cause) {
    throw new RelayError(
      'provider_output_invalid',
      'Codex cloud list returned malformed JSON.',
      undefined,
      { cause },
    );
  }
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
