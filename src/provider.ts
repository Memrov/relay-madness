export type ProviderName = 'claude' | 'codex' | 'jules';
export type MutationMode = 'read' | 'write';

export type ProviderRunStatus =
  | 'queued'
  | 'running'
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
}

export interface StartRunInput {
  prompt: string;
  cwd: string;
  mode: MutationMode;
  branch?: string;
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
  authStatus(): Promise<AuthStatus>;
  start(input: StartRunInput): Promise<ProviderExecution>;
  send?(input: SendRunInput): Promise<ProviderExecution>;
  inspect?(input: InspectRunInput): Promise<ProviderInspection>;
  attach?(input: AttachInput): Promise<number>;
  cancel?(input: InspectRunInput): Promise<void>;
}
