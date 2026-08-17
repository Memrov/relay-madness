export type RelayErrorCode =
  | 'account_at_capacity'
  | 'account_unavailable'
  | 'capability_unavailable'
  | 'command_not_found'
  | 'configuration_missing'
  | 'delegation_depth_exceeded'
  | 'head_moved'
  | 'github_state_mismatch'
  | 'invalid_argument'
  | 'invalid_run_transition'
  | 'merge_not_approved'
  | 'merge_not_ready'
  | 'not_found'
  | 'process_failed'
  | 'process_timeout'
  | 'provider_mismatch'
  | 'provider_output_invalid'
  | 'remote_request_failed'
  | 'run_budget_exceeded'
  | 'work_item_locked';

export class RelayError extends Error {
  readonly code: RelayErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: RelayErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'RelayError';
    this.code = code;
    if (details !== undefined) {
      this.details = details;
    }
  }
}

const SENSITIVE_KEY =
  /token|secret|key|authorization|credential|password/i;

export function redact(value: unknown, key = ''): unknown {
  if (key !== '' && SENSITIVE_KEY.test(key)) {
    return '[REDACTED]';
  }

  if (Array.isArray(value)) {
    return value.map((item) => redact(item));
  }

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        redact(entryValue, entryKey),
      ]),
    );
  }

  return value;
}
