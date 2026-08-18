export const SUPPORTED_PROVIDERS = ['claude', 'codex'] as const;
export type ProviderName = (typeof SUPPORTED_PROVIDERS)[number];

export function isSupportedProvider(value: string): value is ProviderName {
  return (SUPPORTED_PROVIDERS as readonly string[]).includes(value);
}
export type MutationMode = 'read' | 'write';

export type ProviderRunStatus =
  | 'queued'
  | 'running'
  | 'launch_uncertain'
  | 'provider_complete'
  | 'awaiting_publish'
  | 'published'
  | 'verified'
  | 'failed'
  | 'cancelled'
  | 'expired';

export interface ProviderCapabilities {
  start: boolean;
  structuredStart: boolean;
  queueFollowup: boolean;
  interactiveAttach: boolean;
  structuredStatus: boolean;
  events: boolean;
  selectBranch: boolean;
  /** The provider can publish writes to the exact Relay-owned result branch. */
  controlledResultBranch: boolean;
  publishPullRequest: boolean;
  cancel: boolean;
  subscriptionAuth: boolean;
  selectModel: boolean;
  profileIsolation: boolean;
}

export interface AuthStatus {
  authenticated: boolean;
  method?: string;
  detail?: string;
  /** Opaque, non-secret digest used to bind a native profile to one account. */
  identityFingerprint?: string;
}

export interface StartRunInput {
  prompt: string;
  cwd: string;
  mode: MutationMode;
  /** Existing branch or ref the provider must use as its input. */
  startingBranch?: string;
  /** Exact Relay-owned branch where a write provider must publish its output. */
  resultBranch?: string;
  environmentId?: string;
  repo?: string;
  source?: string;
  title?: string;
  profilePath?: string;
  model?: string;
}

export interface SendRunInput {
  providerSessionId: string;
  message: string;
  cwd: string;
  environmentId?: string;
  profilePath?: string;
  model?: string;
}

export interface InspectRunInput {
  providerSessionId: string;
  environmentId?: string;
  profilePath?: string;
  model?: string;
}

export interface AttachInput {
  providerSessionId: string;
  cwd: string;
  profilePath?: string;
  model?: string;
}

export interface ProviderArtifact {
  pullRequest?: number;
  pullRequestUrl?: string;
}

export interface ProviderExecution {
  providerSessionId: string;
  status: ProviderRunStatus;
  url?: string;
}

export interface ProviderInspection {
  status: ProviderRunStatus;
  url?: string;
  artifact?: ProviderArtifact;
  summary?: string;
}

export interface CloudProvider {
  readonly name: ProviderName;
  capabilities(): Promise<ProviderCapabilities>;
  authStatus(profilePath?: string): Promise<AuthStatus>;
  loginProfile?(profilePath: string): Promise<AuthStatus>;
  start(input: StartRunInput): Promise<ProviderExecution>;
  send?(input: SendRunInput): Promise<ProviderExecution>;
  inspect?(input: InspectRunInput): Promise<ProviderInspection>;
  attach?(input: AttachInput): Promise<number>;
  cancel?(input: InspectRunInput): Promise<void>;
}
