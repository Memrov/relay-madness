import * as z from 'zod/v4';

import { RelayError } from '../errors.js';
import type {
  AttachInput,
  AuthStatus,
  CloudProvider,
  ProviderCapabilities,
  ProviderExecution,
  SendRunInput,
  StartRunInput,
} from '../provider.js';
import { ProcessRunner, type RunOptions } from '../process-runner.js';

const authSchema = z.object({
  loggedIn: z.boolean(),
  authMethod: z.string().optional(),
  apiProvider: z.string().optional(),
});

const executionSchema = z.object({
  ok: z.boolean().optional(),
  session_id: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  url: z.url().optional(),
});

interface ClaudeProviderOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export class ClaudeProvider implements CloudProvider {
  readonly name = 'claude' as const;

  constructor(
    private readonly runner: ProcessRunner,
    private readonly options: ClaudeProviderOptions = {},
  ) {}

  async capabilities(): Promise<ProviderCapabilities> {
    const [version, help] = await Promise.all([
      this.probe(['--version']),
      this.probe(['--help']),
    ]);
    const available = version !== undefined;
    return {
      start: available,
      structuredStart: false,
      queueFollowup: available,
      interactiveAttach:
        available && /attach to an existing cloud session/i.test(help ?? ''),
      structuredStatus: false,
      events: false,
      selectBranch: false,
      publishPullRequest: false,
      cancel: false,
      subscriptionAuth: true,
    };
  }

  async authStatus(): Promise<AuthStatus> {
    try {
      const result = await this.runner.run(
        'claude',
        ['auth', 'status'],
        this.runOptions(),
      );
      const auth = authSchema.parse(JSON.parse(result.stdout));
      const status: AuthStatus = { authenticated: auth.loggedIn };
      if (auth.authMethod !== undefined) status.method = auth.authMethod;
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
              ? 'Claude CLI is not installed.'
              : 'Claude CLI is not authenticated.',
        };
      }
      throw new RelayError(
        'provider_output_invalid',
        'Claude authentication status was not valid JSON.',
        undefined,
        { cause: error },
      );
    }
  }

  async start(input: StartRunInput): Promise<ProviderExecution> {
    const result = await this.runner.run(
      'claude',
      ['--cloud', input.prompt],
      this.runOptions(input.cwd),
    );
    return parseClaudeExecution(result.stdout);
  }

  async send(input: SendRunInput): Promise<ProviderExecution> {
    const result = await this.runner.run(
      'claude',
      [
        '-p',
        input.message,
        '--cloud',
        input.providerSessionId,
        '--output-format',
        'json',
      ],
      this.runOptions(input.cwd),
    );
    return parseClaudeExecution(result.stdout);
  }

  async attach(input: AttachInput): Promise<number> {
    return await this.runner.spawnInteractive(
      'claude',
      ['--cloud', input.providerSessionId],
      this.interactiveOptions(input.cwd),
    );
  }

  private async probe(args: readonly string[]): Promise<string | undefined> {
    try {
      return (await this.runner.run('claude', args, this.runOptions())).stdout;
    } catch {
      return undefined;
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

  private interactiveOptions(cwd: string) {
    const options: { cwd: string; env?: NodeJS.ProcessEnv } = { cwd };
    if (this.options.env !== undefined) options.env = this.options.env;
    return options;
  }
}

function parseClaudeExecution(output: string): ProviderExecution {
  const trimmed = output.trim();
  try {
    const parsed = executionSchema.parse(JSON.parse(trimmed));
    const providerSessionId = parsed.session_id ?? parsed.sessionId;
    if (providerSessionId !== undefined) {
      const execution: ProviderExecution = {
        providerSessionId,
        status: 'running',
      };
      if (parsed.url !== undefined) execution.url = parsed.url;
      return execution;
    }
  } catch {
    // Claude start output is not guaranteed to be JSON.
  }

  const urlText = trimmed.match(/https:\/\/[^\s]+/)?.[0];
  if (urlText !== undefined) {
    const cleanUrl = urlText.replace(/[),.;]+$/, '');
    try {
      const url = new URL(cleanUrl);
      const providerSessionId = url.pathname.split('/').filter(Boolean).at(-1);
      if (providerSessionId !== undefined && providerSessionId !== '') {
        return { providerSessionId, url: cleanUrl, status: 'running' };
      }
    } catch {
      // Fall through to the typed error below.
    }
  }

  throw new RelayError(
    'provider_output_invalid',
    'Claude cloud output did not include a session identifier.',
  );
}
