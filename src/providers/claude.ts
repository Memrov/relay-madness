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
    const helpText = help ?? '';
    const cloud = available && /(?:^|\s)--cloud(?:\s|$)/m.test(helpText);
    const followup =
      cloud &&
      /(?:^|\s)(?:-p|--print)(?:[\s,]|$)/m.test(helpText) &&
      /(?:^|\s)--output-format(?:\s|$)/m.test(helpText);
    const model = cloud && /(?:^|\s)--model(?:\s|$)/m.test(helpText);
    const profileIsolation = cloud && /\bCLAUDE_CONFIG_DIR\b/.test(helpText);
    return {
      start: cloud,
      structuredStart: false,
      queueFollowup: followup,
      interactiveAttach:
        cloud && /attach to an existing cloud session/i.test(helpText),
      structuredStatus: false,
      events: false,
      selectBranch: false,
      controlledResultBranch: false,
      publishPullRequest: false,
      cancel: false,
      subscriptionAuth: available,
      selectModel: model,
      profileIsolation,
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
      [
        ...(input.model === undefined ? [] : ['--model', input.model]),
        '--cloud',
        input.prompt,
      ],
      this.runOptions(input.cwd, input.profilePath),
    );
    return parseClaudeExecution(result.stdout);
  }

  async send(input: SendRunInput): Promise<ProviderExecution> {
    const result = await this.runner.run(
      'claude',
      [
        ...(input.model === undefined ? [] : ['--model', input.model]),
        '-p',
        input.message,
        '--cloud',
        input.providerSessionId,
        '--output-format',
        'json',
      ],
      this.runOptions(input.cwd, input.profilePath),
    );
    return parseClaudeExecution(result.stdout);
  }

  async attach(input: AttachInput): Promise<number> {
    return await this.runner.spawnInteractive(
      'claude',
      ['--cloud', input.providerSessionId],
      this.interactiveOptions(input.cwd, input.profilePath),
    );
  }

  private async probe(args: readonly string[]): Promise<string | undefined> {
    try {
      return (await this.runner.run('claude', args, this.runOptions())).stdout;
    } catch {
      return undefined;
    }
  }

  private runOptions(cwd?: string, profilePath?: string): RunOptions {
    const options: RunOptions = {};
    if (cwd !== undefined) options.cwd = cwd;
    if (this.options.env !== undefined || profilePath !== undefined) {
      options.env = {
        ...this.options.env,
        ...(profilePath === undefined ? {} : { CLAUDE_CONFIG_DIR: profilePath }),
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
        ...(profilePath === undefined ? {} : { CLAUDE_CONFIG_DIR: profilePath }),
      };
    }
    return options;
  }
}

function parseClaudeExecution(output: string): ProviderExecution {
  const trimmed = output.trim();
  let parsed: z.infer<typeof executionSchema> | undefined;
  try {
    parsed = executionSchema.parse(JSON.parse(trimmed));
  } catch {
    // Claude start output is not guaranteed to be JSON.
  }
  const providerSessionId = parsed?.session_id ?? parsed?.sessionId;
  if (providerSessionId !== undefined) {
    validateClaudeSessionId(providerSessionId);
    if (parsed?.url === undefined) {
      return { providerSessionId, status: 'running' };
    }
    parseClaudeSessionIdFromUrl(parsed.url, providerSessionId);
    return { providerSessionId, url: parsed.url, status: 'running' };
  }

  const urlText = trimmed.match(/https:\/\/[^\s]+/)?.[0];
  if (urlText !== undefined) {
    const cleanUrl = urlText.replace(/[),.;]+$/, '');
    const providerSessionId = parseClaudeSessionIdFromUrl(cleanUrl);
    return { providerSessionId, url: cleanUrl, status: 'running' };
  }

  throw new RelayError(
    'provider_output_invalid',
    'Claude cloud output did not include a session identifier.',
  );
}

function parseClaudeSessionIdFromUrl(value: string, expectedSessionId?: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (cause) {
    throw new RelayError(
      'provider_output_invalid',
      'Claude cloud returned an invalid session URL.',
      undefined,
      { cause },
    );
  }
  const match = /^\/code\/(session_[A-Za-z0-9]+)$/.exec(url.pathname);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'claude.ai' ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    match === null
  ) {
    throw new RelayError(
      'provider_output_invalid',
      'Claude cloud returned an invalid session URL.',
    );
  }
  const sessionId = match[1]!;
  validateClaudeSessionId(sessionId);
  if (expectedSessionId !== undefined && sessionId !== expectedSessionId) {
    throw new RelayError(
      'provider_output_invalid',
      'Claude cloud session URL did not match its session identifier.',
    );
  }
  return sessionId;
}

function validateClaudeSessionId(value: string): void {
  if (!/^session_[A-Za-z0-9]+$/.test(value)) {
    throw new RelayError(
      'provider_output_invalid',
      'Claude cloud returned an invalid session identifier.',
    );
  }
}
