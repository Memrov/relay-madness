import { createHash } from 'node:crypto';

import * as z from 'zod/v4';

import { RelayError } from '../errors.js';
import type {
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
  email: z.string().optional(),
  orgId: z.string().optional(),
  orgName: z.string().optional(),
});

const followupSchema = z.object({
  ok: z.literal(true),
  session_id: z.string().min(1),
  url: z.url(),
});

const rejectionSchema = z.object({
  ok: z.literal(false),
  session_id: z.string().min(1),
  error: z.string().min(1),
});

const CLAUDE_SESSION_ID = /^(?:session_|cse_)[A-Za-z0-9_-]{1,184}$/;
const PROFILE_CREDENTIAL_OVERRIDES = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_PROFILE',
  'ANTHROPIC_FEDERATION_RULE_ID',
  'ANTHROPIC_ORGANIZATION_ID',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_REFRESH_TOKEN',
  'CLAUDE_CODE_OAUTH_SCOPES',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_MANTLE',
] as const;

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
    const queueFollowup =
      cloud &&
      /(?:^|\s)(?:-p|--print)(?:[\s,]|$)/m.test(helpText) &&
      /(?:^|\s)--output-format(?:\s|$)/m.test(helpText);
    const model = cloud && /(?:^|\s)--model(?:\s|$)/m.test(helpText);
    const profileIsolation = cloud;
    return {
      start: cloud,
      structuredStart: false,
      queueFollowup,
      interactiveAttach: false,
      structuredStatus: false,
      events: false,
      selectBranch: false,
      controlledResultBranch: false,
      publishPullRequest: false,
      cancel: false,
      subscriptionAuth: available,
      selectModel: model,
      profileIsolation,
      reportsProfileIdentity: true,
    };
  }

  async authStatus(profilePath?: string): Promise<AuthStatus> {
    try {
      const result = await this.runner.run(
        'claude',
        ['auth', 'status'],
        this.runOptions(undefined, profilePath),
      );
      const auth = authSchema.parse(JSON.parse(result.stdout));
      const status: AuthStatus = { authenticated: auth.loggedIn };
      if (auth.authMethod !== undefined) status.method = auth.authMethod;
      const identityFingerprint = profilePath === undefined
        ? undefined
        : claudeIdentityFingerprint(auth);
      if (identityFingerprint !== undefined) {
        status.identityFingerprint = identityFingerprint;
      }
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

  async loginProfile(profilePath: string): Promise<AuthStatus> {
    const current = await this.authStatus(profilePath);
    if (current.authenticated) return current;

    const exitCode = await this.runner.spawnInteractive(
      'claude',
      ['auth', 'login'],
      {
        env: this.profileEnvironment(profilePath),
        unsetEnv: PROFILE_CREDENTIAL_OVERRIDES,
      },
    );
    if (exitCode !== 0) {
      throw new RelayError(
        'process_failed',
        `Claude profile login exited with ${exitCode}.`,
        { command: 'claude', exitCode },
      );
    }
    return await this.authStatus(profilePath);
  }

  async start(input: StartRunInput): Promise<ProviderExecution> {
    const result = await this.runner.run(
      'claude',
      [
        ...(input.model === undefined ? [] : ['--model', input.model]),
        '--cloud',
        input.prompt,
      ],
      this.runOptions(input.cwd, input.profilePath, true),
    );
    return parseClaudeExecution(result.stdout);
  }

  async send(input: SendRunInput): Promise<ProviderExecution> {
    validateClaudeSessionId(input.providerSessionId);
    try {
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
      return parseClaudeFollowup(result.stdout, input.providerSessionId);
    } catch (error) {
      const rejection = parseClaudeRejection(error, input.providerSessionId);
      if (rejection !== undefined) throw rejection;
      throw error;
    }
  }

  private async probe(args: readonly string[]): Promise<string | undefined> {
    try {
      return (await this.runner.run('claude', args, this.runOptions())).stdout;
    } catch {
      return undefined;
    }
  }

  private runOptions(
    cwd?: string,
    profilePath?: string,
    pty = false,
  ): RunOptions {
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
    if (profilePath !== undefined) {
      options.unsetEnv = PROFILE_CREDENTIAL_OVERRIDES;
    }
    if (pty) options.pty = true;
    return options;
  }

  private profileEnvironment(profilePath: string): NodeJS.ProcessEnv {
    return {
      ...this.options.env,
      CLAUDE_CONFIG_DIR: profilePath,
    };
  }
}

function claudeIdentityFingerprint(
  auth: z.infer<typeof authSchema>,
): string | undefined {
  if (!auth.loggedIn || auth.email === undefined || auth.orgId === undefined) {
    return undefined;
  }
  return createHash('sha256')
    .update(`${auth.orgId}\n${auth.email.trim().toLowerCase()}`)
    .digest('hex');
}

function parseClaudeRejection(
  error: unknown,
  expectedSessionId: string,
): RelayError | undefined {
  if (!(error instanceof RelayError) || error.code !== 'process_failed') {
    return undefined;
  }
  const stdout = error.details?.stdout;
  if (typeof stdout !== 'string') return undefined;
  try {
    const rejection = rejectionSchema.parse(JSON.parse(stdout));
    validateClaudeSessionId(rejection.session_id);
    if (rejection.session_id !== expectedSessionId) return undefined;
    return new RelayError(
      'provider_rejected',
      'Claude rejected the cloud follow-up before accepting it.',
      { provider: 'claude', sessionId: expectedSessionId },
      { cause: error },
    );
  } catch {
    return undefined;
  }
}

function parseClaudeFollowup(
  output: string,
  expectedSessionId: string,
): ProviderExecution {
  let parsed: z.infer<typeof followupSchema>;
  try {
    parsed = followupSchema.parse(JSON.parse(output));
  } catch (cause) {
    throw new RelayError(
      'provider_output_invalid',
      'Claude cloud follow-up did not return a successful JSON acknowledgement.',
      undefined,
      { cause },
    );
  }
  validateClaudeSessionId(parsed.session_id);
  const urlSessionId = parseClaudeSessionIdFromUrl(parsed.url);
  if (
    parsed.session_id !== expectedSessionId ||
    urlSessionId !== expectedSessionId
  ) {
    throw new RelayError(
      'provider_output_invalid',
      'Claude cloud follow-up did not match the requested session.',
    );
  }
  return {
    providerSessionId: expectedSessionId,
    url: claudeSessionUrl(expectedSessionId),
    status: 'running',
  };
}

function parseClaudeExecution(output: string): ProviderExecution {
  for (const match of output.matchAll(/https:\/\/[^\s]+/g)) {
    const candidate = match[0].replace(/[),.;]+$/, '');
    try {
      const providerSessionId = parseClaudeSessionIdFromUrl(candidate);
      return {
        providerSessionId,
        url: claudeSessionUrl(providerSessionId),
        status: 'running',
      };
    } catch (error) {
      if (
        !(error instanceof RelayError) ||
        error.code !== 'provider_output_invalid'
      ) {
        throw error;
      }
    }
  }

  throw new RelayError(
    'provider_output_invalid',
    'Claude cloud output did not include a session identifier.',
  );
}

function parseClaudeSessionIdFromUrl(value: string): string {
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
  const match = /^\/code\/([^/]+)$/.exec(url.pathname);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'claude.ai' ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== '' ||
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
  return sessionId;
}

function claudeSessionUrl(sessionId: string): string {
  return `https://claude.ai/code/${sessionId}`;
}

function validateClaudeSessionId(value: string): void {
  if (!CLAUDE_SESSION_ID.test(value)) {
    throw new RelayError(
      'provider_output_invalid',
      'Claude cloud returned an invalid session identifier.',
    );
  }
}
