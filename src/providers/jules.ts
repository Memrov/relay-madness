import * as z from 'zod/v4';

import { RelayError } from '../errors.js';
import type {
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

const sessionStateSchema = z.enum([
  'QUEUED',
  'PLANNING',
  'AWAITING_PLAN_APPROVAL',
  'AWAITING_USER_FEEDBACK',
  'IN_PROGRESS',
  'PAUSED',
  'COMPLETED',
  'FAILED',
]);

const pullRequestOutputSchema = z.object({
  pullRequest: z
    .object({
      url: z.url(),
      title: z.string(),
      description: z.string(),
    })
    .optional(),
});

const sessionSchema = z.object({
  name: z.string().regex(/^sessions\/[^/]+$/),
  id: z.string(),
  prompt: z.string().optional(),
  title: z.string().optional(),
  state: sessionStateSchema,
  url: z.url().optional(),
  createTime: z.iso.datetime(),
  updateTime: z.iso.datetime(),
  outputs: z.array(pullRequestOutputSchema).optional(),
});

const emptySchema = z.object({}).loose();

const activitySchema = z.looseObject({
  name: z.string(),
  id: z.string(),
  originator: z.string(),
  description: z.string(),
  createTime: z.iso.datetime(),
});

const activityListSchema = z.object({
  activities: z.array(activitySchema),
  nextPageToken: z.string().optional(),
});

export type JulesActivity = z.infer<typeof activitySchema>;

interface JulesProviderOptions {
  fetch?: typeof fetch;
  apiKey?: () => string | undefined;
  baseUrl?: string;
}

export class JulesProvider implements CloudProvider {
  readonly name = 'jules' as const;
  private readonly fetchImplementation: typeof fetch;
  private readonly readApiKey: () => string | undefined;
  private readonly baseUrl: string;

  constructor(options: JulesProviderOptions = {}) {
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
    this.readApiKey = options.apiKey ?? (() => process.env.JULES_API_KEY);
    this.baseUrl = ensureTrailingSlash(
      options.baseUrl ?? 'https://jules.googleapis.com/v1alpha/',
    );
  }

  async capabilities(): Promise<ProviderCapabilities> {
    return {
      start: true,
      structuredStart: true,
      queueFollowup: true,
      interactiveAttach: false,
      structuredStatus: true,
      events: true,
      selectBranch: true,
      controlledResultBranch: false,
      publishPullRequest: true,
      cancel: false,
      subscriptionAuth: false,
      selectModel: false,
      profileIsolation: false,
    };
  }

  async authStatus(): Promise<AuthStatus> {
    return this.readApiKey() === undefined
      ? {
          authenticated: false,
          detail: 'JULES_API_KEY is not set.',
        }
      : { authenticated: true, method: 'api-key' };
  }

  async start(input: StartRunInput): Promise<ProviderExecution> {
    if (input.mode === 'write') {
      throw new RelayError(
        'capability_unavailable',
        'Jules cannot publish to a Relay-controlled result branch.',
      );
    }
    const body: Record<string, unknown> = {
      prompt: input.prompt,
      requirePlanApproval: false,
    };
    if (input.title !== undefined) body.title = input.title;
    if (input.source !== undefined) {
      if (input.startingBranch === undefined) {
        throw new RelayError(
          'invalid_argument',
          'A Jules source session requires a starting branch.',
        );
      }
      body.sourceContext = {
        source: input.source,
        githubRepoContext: { startingBranch: input.startingBranch },
      };
    }

    const session = await this.request('sessions', sessionSchema, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    const execution: ProviderExecution = {
      providerSessionId: session.name,
      status: mapJulesState(session.state),
    };
    if (session.url !== undefined) execution.url = session.url;
    return execution;
  }

  async send(input: SendRunInput): Promise<ProviderExecution> {
    const name = resourceName(input.providerSessionId);
    await this.request(`${name}:sendMessage`, emptySchema, {
      method: 'POST',
      body: JSON.stringify({ prompt: input.message }),
    });
    return { providerSessionId: name, status: 'running' };
  }

  async inspect(input: InspectRunInput): Promise<ProviderInspection> {
    const session = await this.request(
      resourceName(input.providerSessionId),
      sessionSchema,
    );
    const inspection: ProviderInspection = {
      status: mapJulesState(session.state),
    };
    if (session.url !== undefined) inspection.url = session.url;

    const pullRequestUrl = session.outputs?.find(
      (output) => output.pullRequest !== undefined,
    )?.pullRequest?.url;
    if (pullRequestUrl !== undefined) {
      const pullRequest = pullRequestNumber(pullRequestUrl);
      inspection.artifact = { pullRequestUrl, pullRequest };
    }
    return inspection;
  }

  async approvePlan(providerSessionId: string): Promise<void> {
    await this.request(
      `${resourceName(providerSessionId)}:approvePlan`,
      emptySchema,
      { method: 'POST', body: '{}' },
    );
  }

  async listActivities(
    providerSessionId: string,
  ): Promise<readonly JulesActivity[]> {
    const response = await this.request(
      `${resourceName(providerSessionId)}/activities?pageSize=100`,
      activityListSchema,
    );
    return response.activities;
  }

  private async request<T>(
    path: string,
    schema: z.ZodType<T>,
    init: RequestInit = {},
  ): Promise<T> {
    const apiKey = this.readApiKey();
    if (apiKey === undefined || apiKey === '') {
      throw new RelayError(
        'configuration_missing',
        'JULES_API_KEY is required for Jules REST operations.',
      );
    }

    let response: Response;
    try {
      response = await this.fetchImplementation(new URL(path, this.baseUrl), {
        ...init,
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': apiKey,
          ...headersToObject(init.headers),
        },
      });
    } catch (cause) {
      throw new RelayError(
        'remote_request_failed',
        'The Jules API request could not be completed.',
        undefined,
        { cause },
      );
    }

    const text = await response.text();
    if (!response.ok) {
      throw new RelayError(
        'remote_request_failed',
        `The Jules API returned HTTP ${response.status}.`,
        { status: response.status },
      );
    }

    try {
      return schema.parse(text === '' ? {} : JSON.parse(text));
    } catch (cause) {
      throw new RelayError(
        'provider_output_invalid',
        'The Jules API returned an unexpected response.',
        undefined,
        { cause },
      );
    }
  }
}

function mapJulesState(state: z.infer<typeof sessionStateSchema>): ProviderRunStatus {
  if (state === 'QUEUED') return 'queued';
  if (state === 'COMPLETED') return 'provider_complete';
  if (state === 'FAILED') return 'failed';
  return 'running';
}

function resourceName(value: string): string {
  return value.startsWith('sessions/') ? value : `sessions/${value}`;
}

function pullRequestNumber(urlText: string): number {
  const value = Number(new URL(urlText).pathname.split('/').filter(Boolean).at(-1));
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RelayError(
      'provider_output_invalid',
      'Jules returned a pull-request URL without a valid number.',
    );
  }
  return value;
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

function headersToObject(headers: HeadersInit | undefined): Record<string, string> {
  if (headers === undefined) return {};
  return Object.fromEntries(new Headers(headers).entries());
}
