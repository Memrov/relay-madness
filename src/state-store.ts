import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import Database from 'better-sqlite3';

import { RelayError } from './errors.js';
import type {
  MutationMode,
  ProviderName,
  ProviderRunStatus,
} from './provider.js';

export interface ProjectInput {
  repo: string;
  defaultBranch: string;
  locatorPath: string;
}

export interface ProjectRecord extends ProjectInput {
  id: string;
  currentWorkItemId?: string;
  createdAt: string;
  updatedAt: string;
}

export type ProviderAccountStatus =
  | 'ready'
  | 'disabled'
  | 'auth_required'
  | 'cooldown';

export interface ProviderAccountInput {
  id: string;
  provider: ProviderName;
  label: string;
  profilePath: string;
  status: ProviderAccountStatus;
  maxConcurrency: number;
  isDefault: boolean;
}

export interface ProviderAccountRecord extends ProviderAccountInput {
  lastUsedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface UsageSnapshotInput {
  accountId: string;
  period: 'weekly';
  model: string;
  remainingPercent: number;
  resetsAt?: string;
  source: 'manual' | 'provider';
  observedAt: string;
}

export interface UsageSnapshotRecord extends UsageSnapshotInput {
  id: string;
}

export interface AccountLeaseRecord {
  accountId: string;
  runId: string;
  acquiredAt: string;
  expiresAt: string;
}

export interface WorkItemInput {
  id?: string;
  projectId: string;
  title: string;
  baseBranch: string;
  currentBranch?: string;
}

export interface WorkItemRecord {
  id: string;
  projectId: string;
  title: string;
  baseBranch: string;
  currentBranch?: string;
  currentSha?: string;
  pullRequest?: number;
  status: 'in_progress' | 'complete' | 'failed' | 'cancelled';
  createdAt: string;
  updatedAt: string;
}

export interface SessionInput {
  workItemId: string;
  provider: ProviderName;
  providerSessionId: string;
  providerUrl?: string;
  status: 'pending' | 'active' | 'complete' | 'failed' | 'expired';
  branch?: string;
}

export interface SessionRecord extends SessionInput {
  id: string;
  lastActivityAt: string;
}

export type RunType =
  | 'delegation'
  | 'message'
  | 'handoff'
  | 'inspection'
  | 'publication';

export interface RunInput {
  sessionId: string;
  provider: ProviderName;
  type: RunType;
  prompt?: string;
  mutationMode: MutationMode;
  correlationId?: string;
  originProvider?: ProviderName;
  delegationDepth?: number;
  parentRunId?: string;
  expectedBranch?: string;
  baselineSha?: string;
  pinnedSha?: string;
}

export interface RunRecord extends RunInput {
  id: string;
  workItemId: string;
  status: ProviderRunStatus;
  correlationId: string;
  delegationDepth: number;
  startedAt: string;
  finishedAt?: string;
}

export type CheckSummary = 'passing' | 'failing' | 'pending' | 'unknown';

export interface ArtifactInput {
  workItemId: string;
  branch: string;
  sha: string;
  status: 'published' | 'verified';
  pullRequest?: number;
  checks: CheckSummary;
  mergeable?: boolean;
  reviewDecision?: string;
  draft?: boolean;
}

export interface ArtifactRecord extends ArtifactInput {
  id: string;
  observedAt: string;
}

export interface WorkItemStatus {
  workItem: WorkItemRecord;
  sessions: readonly SessionRecord[];
  runs: readonly RunRecord[];
  artifact?: ArtifactRecord;
}

type SqlRow = Record<string, unknown>;

const SENSITIVE_SETTING_SEGMENTS = new Set([
  'authorization',
  'authorizations',
  'cookie',
  'cookies',
  'credential',
  'credentials',
  'key',
  'keys',
  'keychain',
  'keychains',
  'password',
  'passwords',
  'secret',
  'secrets',
  'token',
  'tokens',
]);

const SENSITIVE_SETTING_COMPOUND_ALIASES = new Set([
  'apikey',
  'apikeys',
  'accesskey',
  'accesskeys',
  'accesstoken',
  'accesstokens',
]);

const ENVIRONMENT_REFERENCE_SEGMENTS = new Set(['id', 'identifier']);

const RUN_TRANSITIONS: Readonly<
  Record<ProviderRunStatus, ReadonlySet<ProviderRunStatus>>
> = {
  queued: new Set(['running', 'failed', 'cancelled']),
  running: new Set([
    'provider_complete',
    'failed',
    'cancelled',
    'expired',
  ]),
  provider_complete: new Set(['awaiting_publish', 'published', 'failed']),
  awaiting_publish: new Set(['published', 'failed', 'cancelled']),
  published: new Set(['verified', 'failed']),
  verified: new Set(),
  failed: new Set(),
  cancelled: new Set(),
  expired: new Set(),
};

const FINISHED_RUN_STATUSES = new Set<ProviderRunStatus>([
  'verified',
  'failed',
  'cancelled',
  'expired',
]);

export class StateStore {
  private constructor(private readonly database: Database.Database) {}

  static open(databasePath: string): StateStore {
    const parent = dirname(databasePath);
    if (!existsSync(parent)) {
      mkdirSync(parent, { recursive: true, mode: 0o700 });
      chmodSync(parent, 0o700);
    }

    const database = new Database(databasePath);
    chmodSync(databasePath, 0o600);
    database.pragma('foreign_keys = ON');
    database.pragma('journal_mode = WAL');

    const store = new StateStore(database);
    store.migrate();
    return store;
  }

  close(): void {
    this.database.close();
  }

  upsertProject(input: ProjectInput): ProjectRecord {
    const now = new Date().toISOString();
    this.database
      .prepare(
        `INSERT INTO projects (
          id, repo, default_branch, locator_path, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(repo) DO UPDATE SET
          default_branch = excluded.default_branch,
          locator_path = excluded.locator_path,
          updated_at = excluded.updated_at`,
      )
      .run(
        randomUUID(),
        input.repo,
        input.defaultBranch,
        input.locatorPath,
        now,
        now,
      );

    return this.projectFromRow(
      this.requiredRow(
        this.database.prepare('SELECT * FROM projects WHERE repo = ?').get(input.repo),
        `Project ${input.repo} was not persisted.`,
      ),
    );
  }

  setProviderConfig(
    projectId: string,
    provider: ProviderName,
    settings: Readonly<Record<string, unknown>>,
  ): void {
    if (containsSensitiveSetting(settings)) {
      throw new RelayError(
        'invalid_argument',
        'Provider settings may contain references, but not credentials.',
      );
    }

    this.database
      .prepare(
        `INSERT INTO provider_configs (project_id, provider, settings_json)
         VALUES (?, ?, ?)
         ON CONFLICT(project_id, provider) DO UPDATE SET
           settings_json = excluded.settings_json`,
      )
      .run(projectId, provider, JSON.stringify(settings));
  }

  getProviderConfig(
    projectId: string,
    provider: ProviderName,
  ): Readonly<Record<string, unknown>> | undefined {
    const row = this.database
      .prepare(
        'SELECT settings_json FROM provider_configs WHERE project_id = ? AND provider = ?',
      )
      .get(projectId, provider) as SqlRow | undefined;
    if (row === undefined) return undefined;
    return JSON.parse(String(row.settings_json)) as Record<string, unknown>;
  }

  upsertProviderAccount(input: ProviderAccountInput): ProviderAccountRecord {
    this.validateProviderAccount(input);
    return this.database.transaction(() => {
      const existing = this.database
        .prepare('SELECT provider FROM provider_accounts WHERE id = ?')
        .get(input.id) as SqlRow | undefined;
      if (existing !== undefined && existing.provider !== input.provider) {
        throw new RelayError(
          'provider_mismatch',
          `Provider account ${input.id} is already registered to ${existing.provider}.`,
        );
      }

      const now = new Date().toISOString();
      if (input.isDefault) {
        this.database
          .prepare(
            'UPDATE provider_accounts SET is_default = 0, updated_at = ? WHERE provider = ?',
          )
          .run(now, input.provider);
      }
      this.database
        .prepare(
          `INSERT INTO provider_accounts (
            id, provider, label, profile_path, status, max_concurrency,
            is_default, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            label = excluded.label,
            profile_path = excluded.profile_path,
            status = excluded.status,
            max_concurrency = excluded.max_concurrency,
            is_default = excluded.is_default,
            updated_at = excluded.updated_at`,
        )
        .run(
          input.id,
          input.provider,
          input.label,
          input.profilePath,
          input.status,
          input.maxConcurrency,
          Number(input.isDefault),
          now,
          now,
        );
      return this.getRequiredProviderAccount(input.id);
    }).immediate();
  }

  getProviderAccount(id: string): ProviderAccountRecord | undefined {
    const row = this.database
      .prepare('SELECT * FROM provider_accounts WHERE id = ?')
      .get(id) as SqlRow | undefined;
    return row === undefined ? undefined : this.providerAccountFromRow(row);
  }

  getDefaultProviderAccount(
    provider: ProviderName,
  ): ProviderAccountRecord | undefined {
    const row = this.database
      .prepare(
        'SELECT * FROM provider_accounts WHERE provider = ? AND is_default = 1',
      )
      .get(provider) as SqlRow | undefined;
    return row === undefined ? undefined : this.providerAccountFromRow(row);
  }

  listProviderAccounts(provider?: ProviderName): readonly ProviderAccountRecord[] {
    const rows = provider === undefined
      ? (this.database
          .prepare('SELECT * FROM provider_accounts ORDER BY provider, created_at, id')
          .all() as SqlRow[])
      : (this.database
          .prepare(
            'SELECT * FROM provider_accounts WHERE provider = ? ORDER BY created_at, id',
          )
          .all(provider) as SqlRow[]);
    return rows.map((row) => this.providerAccountFromRow(row));
  }

  setProviderAccountConfig(
    projectId: string,
    accountId: string,
    settings: Readonly<Record<string, unknown>>,
  ): void {
    if (containsSensitiveSetting(settings)) {
      throw new RelayError(
        'invalid_argument',
        'Provider account settings may contain references, but not credentials.',
      );
    }
    this.getProject(projectId);
    this.getRequiredProviderAccount(accountId);
    this.database
      .prepare(
        `INSERT INTO provider_account_configs (project_id, account_id, settings_json)
         VALUES (?, ?, ?)
         ON CONFLICT(project_id, account_id) DO UPDATE SET
           settings_json = excluded.settings_json`,
      )
      .run(projectId, accountId, JSON.stringify(settings));
  }

  getProviderAccountConfig(
    projectId: string,
    accountId: string,
  ): Readonly<Record<string, unknown>> | undefined {
    const row = this.database
      .prepare(
        `SELECT settings_json FROM provider_account_configs
         WHERE project_id = ? AND account_id = ?`,
      )
      .get(projectId, accountId) as SqlRow | undefined;
    if (row === undefined) return undefined;
    return JSON.parse(String(row.settings_json)) as Record<string, unknown>;
  }

  recordUsageSnapshot(input: UsageSnapshotInput): UsageSnapshotRecord {
    this.validateUsageSnapshot(input);
    this.getRequiredProviderAccount(input.accountId);
    const record: UsageSnapshotRecord = { id: randomUUID(), ...input };
    this.database
      .prepare(
        `INSERT INTO usage_snapshots (
          id, account_id, period, model, remaining_percent, resets_at, source,
          observed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.accountId,
        record.period,
        record.model,
        record.remainingPercent,
        record.resetsAt ?? null,
        record.source,
        record.observedAt,
      );
    return record;
  }

  listLatestUsage(accountId: string): readonly UsageSnapshotRecord[] {
    const rows = this.database
      .prepare(
        `SELECT snapshot.*
         FROM usage_snapshots AS snapshot
         WHERE snapshot.account_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM usage_snapshots AS newer
             WHERE newer.account_id = snapshot.account_id
               AND newer.period = snapshot.period
               AND newer.model = snapshot.model
               AND (
                 newer.observed_at > snapshot.observed_at
                 OR (newer.observed_at = snapshot.observed_at AND newer.id > snapshot.id)
               )
           )
         ORDER BY snapshot.observed_at DESC, snapshot.id DESC`,
      )
      .all(accountId) as SqlRow[];
    return rows.map((row) => this.usageSnapshotFromRow(row));
  }

  acquireAccountLease(
    accountId: string,
    runId: string,
    now = new Date(),
  ): AccountLeaseRecord {
    if (!isValidDate(now)) {
      throw new RelayError('invalid_argument', 'Lease time must be a valid date.');
    }
    return this.database.transaction(() => {
      const account = this.getRequiredProviderAccount(accountId);
      if (account.status !== 'ready') {
        throw new RelayError(
          'account_unavailable',
          `Provider account ${accountId} is ${account.status}.`,
        );
      }
      const acquiredAt = now.toISOString();
      const expiresAt = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
      this.database
        .prepare('DELETE FROM account_leases WHERE account_id = ? AND expires_at <= ?')
        .run(accountId, acquiredAt);
      const existing = this.database
        .prepare(
          'SELECT * FROM account_leases WHERE account_id = ? AND run_id = ?',
        )
        .get(accountId, runId) as SqlRow | undefined;
      if (existing !== undefined) {
        this.database
          .prepare(
            `UPDATE account_leases SET acquired_at = ?, expires_at = ?
             WHERE account_id = ? AND run_id = ?`,
          )
          .run(acquiredAt, expiresAt, accountId, runId);
      } else {
        const activeLeases = this.database
          .prepare('SELECT COUNT(*) AS count FROM account_leases WHERE account_id = ?')
          .get(accountId) as SqlRow;
        if (Number(activeLeases.count) >= account.maxConcurrency) {
          throw new RelayError(
            'account_at_capacity',
            `Provider account ${accountId} is at capacity.`,
          );
        }
        this.database
          .prepare(
            `INSERT INTO account_leases (account_id, run_id, acquired_at, expires_at)
             VALUES (?, ?, ?, ?)`,
          )
          .run(accountId, runId, acquiredAt, expiresAt);
      }
      this.database
        .prepare('UPDATE provider_accounts SET last_used_at = ?, updated_at = ? WHERE id = ?')
        .run(acquiredAt, acquiredAt, accountId);
      return { accountId, runId, acquiredAt, expiresAt };
    }).immediate();
  }

  releaseAccountLease(accountId: string, runId: string): void {
    this.database
      .prepare('DELETE FROM account_leases WHERE account_id = ? AND run_id = ?')
      .run(accountId, runId);
  }

  createWorkItem(input: WorkItemInput): WorkItemRecord {
    return this.database.transaction(() => {
      const id = input.id ?? randomUUID();
      const now = new Date().toISOString();
      this.database
        .prepare(
          `INSERT INTO work_items (
            id, project_id, title, base_branch, current_branch, status,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'in_progress', ?, ?)`,
        )
        .run(
          id,
          input.projectId,
          input.title,
          input.baseBranch,
          input.currentBranch ?? null,
          now,
          now,
        );
      this.database
        .prepare(
          'UPDATE projects SET current_work_item_id = ?, updated_at = ? WHERE id = ?',
        )
        .run(id, now, input.projectId);
      return this.getWorkItem(id);
    })();
  }

  getWorkItem(id: string): WorkItemRecord {
    return this.workItemFromRow(
      this.requiredRow(
        this.database.prepare('SELECT * FROM work_items WHERE id = ?').get(id),
        `WorkItem ${id} was not found.`,
      ),
    );
  }

  getProject(id: string): ProjectRecord {
    return this.projectFromRow(
      this.requiredRow(
        this.database.prepare('SELECT * FROM projects WHERE id = ?').get(id),
        `Project ${id} was not found.`,
      ),
    );
  }

  getProjectByRepo(repo: string): ProjectRecord | undefined {
    const row = this.database
      .prepare('SELECT * FROM projects WHERE repo = ?')
      .get(repo) as SqlRow | undefined;
    return row === undefined ? undefined : this.projectFromRow(row);
  }

  getCurrentWorkItem(projectId: string): WorkItemRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT work_items.*
         FROM projects
         JOIN work_items ON work_items.id = projects.current_work_item_id
         WHERE projects.id = ?`,
      )
      .get(projectId) as SqlRow | undefined;
    return row === undefined ? undefined : this.workItemFromRow(row);
  }

  upsertSession(input: SessionInput): SessionRecord {
    const now = new Date().toISOString();
    this.database.transaction(() => {
      if (input.status === 'active') {
        this.database
          .prepare(
            `UPDATE provider_sessions SET status = 'expired'
             WHERE work_item_id = ? AND provider = ?
               AND provider_session_id <> ? AND status = 'active'`,
          )
          .run(input.workItemId, input.provider, input.providerSessionId);
      }
      this.database
        .prepare(
          `INSERT INTO provider_sessions (
            id, work_item_id, provider, provider_session_id, provider_url,
            status, branch, last_activity_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(work_item_id, provider, provider_session_id) DO UPDATE SET
            provider_url = excluded.provider_url,
            status = excluded.status,
            branch = excluded.branch,
            last_activity_at = excluded.last_activity_at`,
        )
        .run(
          randomUUID(),
          input.workItemId,
          input.provider,
          input.providerSessionId,
          input.providerUrl ?? null,
          input.status,
          input.branch ?? null,
          now,
        );
    })();
    return this.sessionFromRow(
      this.requiredRow(
        this.database
          .prepare(
            `SELECT * FROM provider_sessions
             WHERE work_item_id = ? AND provider = ? AND provider_session_id = ?`,
          )
          .get(input.workItemId, input.provider, input.providerSessionId),
        `Session for ${input.provider} was not persisted.`,
      ),
    );
  }

  getSession(
    workItemId: string,
    provider: ProviderName,
  ): SessionRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM provider_sessions WHERE work_item_id = ? AND provider = ?
         ORDER BY CASE status
           WHEN 'active' THEN 0
           WHEN 'pending' THEN 1
           ELSE 2
         END, last_activity_at DESC, rowid DESC LIMIT 1`,
      )
      .get(workItemId, provider) as SqlRow | undefined;
    return row === undefined ? undefined : this.sessionFromRow(row);
  }

  activateSession(
    id: string,
    input: {
      providerSessionId: string;
      providerUrl?: string;
      status: SessionRecord['status'];
      branch?: string;
    },
  ): SessionRecord {
    return this.database.transaction(() => {
      const current = this.requiredRow(
        this.database
          .prepare('SELECT work_item_id, provider FROM provider_sessions WHERE id = ?')
          .get(id),
        `Session ${id} was not found.`,
      );
      const now = new Date().toISOString();
      if (input.status === 'active') {
        this.database
          .prepare(
            `UPDATE provider_sessions SET status = 'expired'
             WHERE work_item_id = ? AND provider = ? AND id <> ?
               AND status = 'active'`,
          )
          .run(current.work_item_id, current.provider, id);
      }
      this.database
        .prepare(
          `UPDATE provider_sessions SET provider_session_id = ?, provider_url = ?,
             status = ?, branch = ?, last_activity_at = ? WHERE id = ?`,
        )
        .run(
          input.providerSessionId,
          input.providerUrl ?? null,
          input.status,
          input.branch ?? null,
          now,
          id,
        );
      return this.sessionFromRow(
        this.requiredRow(
          this.database
            .prepare('SELECT * FROM provider_sessions WHERE id = ?')
            .get(id),
          `Session ${id} was not found after activation.`,
        ),
      );
    })();
  }

  listSessions(workItemId: string): readonly SessionRecord[] {
    return (
      this.database
        .prepare(
          'SELECT * FROM provider_sessions WHERE work_item_id = ? ORDER BY last_activity_at',
        )
        .all(workItemId) as SqlRow[]
    ).map((row) => this.sessionFromRow(row));
  }

  createRun(input: RunInput): RunRecord {
    return this.database.transaction(() => {
      const session = this.requiredRow(
        this.database
          .prepare('SELECT work_item_id FROM provider_sessions WHERE id = ?')
          .get(input.sessionId),
        `Session ${input.sessionId} was not found.`,
      );
      const workItemId = String(session.work_item_id);
      if (this.countRuns(workItemId) >= 20) {
        throw new RelayError(
          'run_budget_exceeded',
          `WorkItem ${workItemId} has reached its 20-run budget.`,
        );
      }
      if (input.mutationMode === 'read') {
        const row = this.database
          .prepare(
            `SELECT COUNT(*) AS count FROM provider_runs
             WHERE work_item_id = ? AND mutation_mode = 'read'
               AND status IN ('queued', 'running')`,
          )
          .get(workItemId) as { count: number };
        if (row.count >= 3) {
          throw new RelayError(
            'work_item_locked',
            `WorkItem ${workItemId} already has three active read-only runs.`,
          );
        }
      }

      const id = randomUUID();
      const now = new Date().toISOString();
      const correlationId = input.correlationId ?? id;
      this.database
        .prepare(
          `INSERT INTO provider_runs (
            id, session_id, work_item_id, provider, type, prompt, status,
            mutation_mode, correlation_id, origin_provider, delegation_depth,
            parent_run_id, expected_branch, baseline_sha, pinned_sha, started_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.sessionId,
          workItemId,
          input.provider,
          input.type,
          input.prompt ?? null,
          input.mutationMode,
          correlationId,
          input.originProvider ?? null,
          input.delegationDepth ?? 0,
          input.parentRunId ?? null,
          input.expectedBranch ?? null,
          input.baselineSha ?? null,
          input.pinnedSha ?? null,
          now,
        );
      return this.getRun(id);
    }).immediate();
  }

  transitionRun(id: string, status: ProviderRunStatus): RunRecord {
    return this.database.transaction(() => {
      const current = this.getRun(id);
      if (!RUN_TRANSITIONS[current.status].has(status)) {
        throw new RelayError(
          'invalid_run_transition',
          `Run ${id} cannot move from ${current.status} to ${status}.`,
        );
      }
      const finishedAt = FINISHED_RUN_STATUSES.has(status)
        ? new Date().toISOString()
        : null;
      this.database
        .prepare(
          'UPDATE provider_runs SET status = ?, finished_at = ? WHERE id = ?',
        )
        .run(status, finishedAt, id);
      return this.getRun(id);
    })();
  }

  countRuns(workItemId: string): number {
    const row = this.database
      .prepare('SELECT COUNT(*) AS count FROM provider_runs WHERE work_item_id = ?')
      .get(workItemId) as { count: number };
    return row.count;
  }

  acquireMutationLease(workItemId: string, runId: string, now = new Date()): void {
    this.database.transaction(() => {
      const nowText = now.toISOString();
      this.database
        .prepare('DELETE FROM work_item_leases WHERE expires_at <= ?')
        .run(nowText);
      const existing = this.database
        .prepare(
          `SELECT leases.run_id, owner.session_id
           FROM work_item_leases AS leases
           JOIN provider_runs AS owner ON owner.id = leases.run_id
           WHERE leases.work_item_id = ?`,
        )
        .get(workItemId) as
        | { run_id: string; session_id: string }
        | undefined;
      const candidate = this.requiredRow(
        this.database
          .prepare('SELECT session_id FROM provider_runs WHERE id = ?')
          .get(runId),
        `Run ${runId} was not found.`,
      );
      if (
        existing !== undefined &&
        existing.run_id !== runId &&
        existing.session_id !== String(candidate.session_id)
      ) {
        throw new RelayError(
          'work_item_locked',
          `WorkItem ${workItemId} already has an active writer.`,
        );
      }
      const expiresAt = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
      this.database
        .prepare(
          `INSERT INTO work_item_leases (work_item_id, run_id, acquired_at, expires_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(work_item_id) DO UPDATE SET
             run_id = excluded.run_id,
             acquired_at = excluded.acquired_at,
             expires_at = excluded.expires_at`,
        )
        .run(workItemId, runId, nowText, expiresAt);
    }).immediate();
  }

  releaseMutationLease(workItemId: string, runId: string): void {
    this.database
      .prepare(
        'DELETE FROM work_item_leases WHERE work_item_id = ? AND run_id = ?',
      )
      .run(workItemId, runId);
  }

  saveArtifact(input: ArtifactInput): ArtifactRecord {
    if (!/^[0-9a-f]{40}$/i.test(input.sha)) {
      throw new RelayError(
        'invalid_argument',
        'Artifact SHA must contain exactly 40 hexadecimal characters.',
      );
    }

    return this.database.transaction(() => {
      const id = randomUUID();
      const observedAt = new Date().toISOString();
      this.database
        .prepare(
          `INSERT INTO artifact_snapshots (
            id, work_item_id, branch, sha, verification_status, pull_request, checks, mergeable,
            review_decision, draft, observed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.workItemId,
          input.branch,
          input.sha,
          input.status,
          input.pullRequest ?? null,
          input.checks,
          input.mergeable === undefined ? null : Number(input.mergeable),
          input.reviewDecision ?? null,
          input.draft === undefined ? null : Number(input.draft),
          observedAt,
        );
      this.database
        .prepare(
          `UPDATE work_items SET current_branch = ?, current_sha = ?,
             pull_request = ?, updated_at = ? WHERE id = ?`,
        )
        .run(
          input.branch,
          input.sha,
          input.pullRequest ?? null,
          observedAt,
          input.workItemId,
        );
      return this.artifactFromRow(
        this.requiredRow(
          this.database
            .prepare('SELECT * FROM artifact_snapshots WHERE id = ?')
            .get(id),
          `Artifact ${id} was not persisted.`,
        ),
      );
    })();
  }

  getLatestArtifact(workItemId: string): ArtifactRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM artifact_snapshots WHERE work_item_id = ?
         ORDER BY observed_at DESC, rowid DESC LIMIT 1`,
      )
      .get(workItemId) as SqlRow | undefined;
    return row === undefined ? undefined : this.artifactFromRow(row);
  }

  markArtifactMissing(workItemId: string, branch: string): WorkItemRecord {
    const result = this.database
      .prepare(
        `UPDATE work_items SET current_branch = ?, current_sha = NULL,
           pull_request = NULL, updated_at = ? WHERE id = ?`,
      )
      .run(branch, new Date().toISOString(), workItemId);
    if (result.changes !== 1) {
      throw new RelayError('not_found', `WorkItem ${workItemId} was not found.`);
    }
    return this.getWorkItem(workItemId);
  }

  getStatus(workItemId: string): WorkItemStatus {
    const artifact = this.getLatestArtifact(workItemId);
    const status: WorkItemStatus = {
      workItem: this.getWorkItem(workItemId),
      sessions: this.listSessions(workItemId),
      runs: (
        this.database
          .prepare(
            'SELECT * FROM provider_runs WHERE work_item_id = ? ORDER BY started_at',
          )
          .all(workItemId) as SqlRow[]
      ).map((row) => this.runFromRow(row)),
    };
    return artifact === undefined ? status : { ...status, artifact };
  }

  getRun(id: string): RunRecord {
    return this.runFromRow(
      this.requiredRow(
        this.database.prepare('SELECT * FROM provider_runs WHERE id = ?').get(id),
        `Run ${id} was not found.`,
      ),
    );
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      )
    `);
    const applied = new Set(
      (
        this.database
          .prepare('SELECT version FROM schema_migrations')
          .all() as Array<{ version: number }>
      ).map(({ version }) => version),
    );
    if (!applied.has(1)) {
      this.database.transaction(() => {
        this.database.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        repo TEXT NOT NULL UNIQUE,
        default_branch TEXT NOT NULL,
        locator_path TEXT NOT NULL,
        current_work_item_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS work_items (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        base_branch TEXT NOT NULL,
        current_branch TEXT,
        current_sha TEXT,
        pull_request INTEGER,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS provider_configs (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        settings_json TEXT NOT NULL,
        PRIMARY KEY (project_id, provider)
      );
      CREATE TABLE IF NOT EXISTS provider_sessions (
        id TEXT PRIMARY KEY,
        work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        provider_session_id TEXT NOT NULL,
        provider_url TEXT,
        status TEXT NOT NULL,
        branch TEXT,
        last_activity_at TEXT NOT NULL,
        UNIQUE (work_item_id, provider, provider_session_id)
      );
      CREATE TABLE IF NOT EXISTS provider_runs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES provider_sessions(id) ON DELETE CASCADE,
        work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        type TEXT NOT NULL,
        prompt TEXT,
        status TEXT NOT NULL,
        mutation_mode TEXT NOT NULL,
        correlation_id TEXT NOT NULL,
        origin_provider TEXT,
        delegation_depth INTEGER NOT NULL,
        parent_run_id TEXT REFERENCES provider_runs(id),
        started_at TEXT NOT NULL,
        finished_at TEXT
      );
      CREATE TABLE IF NOT EXISTS artifact_snapshots (
        id TEXT PRIMARY KEY,
        work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
        branch TEXT NOT NULL,
        sha TEXT NOT NULL,
        pull_request INTEGER,
        checks TEXT NOT NULL,
        mergeable INTEGER,
        review_decision TEXT,
        draft INTEGER,
        observed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS work_item_leases (
        work_item_id TEXT PRIMARY KEY REFERENCES work_items(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL REFERENCES provider_runs(id) ON DELETE CASCADE,
        acquired_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
        `);
        this.recordMigration(1);
      }).immediate();
    }
    if (!applied.has(2)) {
      this.database.transaction(() => {
        this.database.exec(`
          ALTER TABLE provider_runs ADD COLUMN expected_branch TEXT;
          ALTER TABLE provider_runs ADD COLUMN baseline_sha TEXT;
          ALTER TABLE provider_runs ADD COLUMN pinned_sha TEXT;
          ALTER TABLE artifact_snapshots ADD COLUMN verification_status TEXT NOT NULL DEFAULT 'published';
        `);
        this.recordMigration(2);
      }).immediate();
    }
    if (!applied.has(3)) {
      this.database.transaction(() => {
        this.database.exec(`
          CREATE TABLE provider_accounts (
            id TEXT PRIMARY KEY,
            provider TEXT NOT NULL,
            label TEXT NOT NULL,
            profile_path TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('ready','disabled','auth_required','cooldown')),
            max_concurrency INTEGER NOT NULL CHECK(max_concurrency > 0),
            is_default INTEGER NOT NULL CHECK(is_default IN (0,1)),
            last_used_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE UNIQUE INDEX provider_accounts_one_default
            ON provider_accounts(provider) WHERE is_default = 1;
          CREATE TABLE provider_account_configs (
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            account_id TEXT NOT NULL REFERENCES provider_accounts(id) ON DELETE CASCADE,
            settings_json TEXT NOT NULL,
            PRIMARY KEY(project_id, account_id)
          );
          CREATE TABLE account_leases (
            account_id TEXT NOT NULL REFERENCES provider_accounts(id) ON DELETE CASCADE,
            run_id TEXT NOT NULL,
            acquired_at TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            PRIMARY KEY(account_id, run_id)
          );
          CREATE TABLE usage_snapshots (
            id TEXT PRIMARY KEY,
            account_id TEXT NOT NULL REFERENCES provider_accounts(id) ON DELETE CASCADE,
            period TEXT NOT NULL CHECK(period = 'weekly'),
            model TEXT NOT NULL,
            remaining_percent REAL NOT NULL CHECK(remaining_percent >= 0 AND remaining_percent <= 100),
            resets_at TEXT,
            source TEXT NOT NULL CHECK(source IN ('manual','provider')),
            observed_at TEXT NOT NULL
          );
        `);
        this.recordMigration(3);
      }).immediate();
    }
  }

  private recordMigration(version: number): void {
    this.database
      .prepare(
        'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
      )
      .run(version, new Date().toISOString());
  }

  private requiredRow(row: unknown, message: string): SqlRow {
    if (row === undefined) {
      throw new RelayError('not_found', message);
    }
    return row as SqlRow;
  }

  private projectFromRow(row: SqlRow): ProjectRecord {
    const base = {
      id: String(row.id),
      repo: String(row.repo),
      defaultBranch: String(row.default_branch),
      locatorPath: String(row.locator_path),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
    return row.current_work_item_id === null
      ? base
      : { ...base, currentWorkItemId: String(row.current_work_item_id) };
  }

  private getRequiredProviderAccount(id: string): ProviderAccountRecord {
    const account = this.getProviderAccount(id);
    if (account === undefined) {
      throw new RelayError('not_found', `Provider account ${id} was not found.`);
    }
    return account;
  }

  private validateProviderAccount(input: ProviderAccountInput): void {
    if (
      input.id.length === 0 ||
      input.label.length === 0 ||
      input.profilePath.length === 0 ||
      !Number.isInteger(input.maxConcurrency) ||
      input.maxConcurrency <= 0
    ) {
      throw new RelayError('invalid_argument', 'Provider account fields are invalid.');
    }
  }

  private validateUsageSnapshot(input: UsageSnapshotInput): void {
    if (
      input.period !== 'weekly' ||
      (input.source !== 'manual' && input.source !== 'provider') ||
      input.model.length === 0 ||
      !Number.isFinite(input.remainingPercent) ||
      input.remainingPercent < 0 ||
      input.remainingPercent > 100 ||
      !isIsoTimestamp(input.observedAt) ||
      (input.resetsAt !== undefined && !isIsoTimestamp(input.resetsAt))
    ) {
      throw new RelayError('invalid_argument', 'Usage snapshot fields are invalid.');
    }
  }

  private providerAccountFromRow(row: SqlRow): ProviderAccountRecord {
    const record: ProviderAccountRecord = {
      id: String(row.id),
      provider: String(row.provider) as ProviderName,
      label: String(row.label),
      profilePath: String(row.profile_path),
      status: String(row.status) as ProviderAccountStatus,
      maxConcurrency: Number(row.max_concurrency),
      isDefault: Boolean(row.is_default),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
    if (row.last_used_at !== null) record.lastUsedAt = String(row.last_used_at);
    return record;
  }

  private usageSnapshotFromRow(row: SqlRow): UsageSnapshotRecord {
    const record: UsageSnapshotRecord = {
      id: String(row.id),
      accountId: String(row.account_id),
      period: String(row.period) as 'weekly',
      model: String(row.model),
      remainingPercent: Number(row.remaining_percent),
      source: String(row.source) as UsageSnapshotRecord['source'],
      observedAt: String(row.observed_at),
    };
    if (row.resets_at !== null) record.resetsAt = String(row.resets_at);
    return record;
  }

  private workItemFromRow(row: SqlRow): WorkItemRecord {
    const record: WorkItemRecord = {
      id: String(row.id),
      projectId: String(row.project_id),
      title: String(row.title),
      baseBranch: String(row.base_branch),
      status: String(row.status) as WorkItemRecord['status'],
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
    if (row.current_branch !== null) record.currentBranch = String(row.current_branch);
    if (row.current_sha !== null) record.currentSha = String(row.current_sha);
    if (row.pull_request !== null) record.pullRequest = Number(row.pull_request);
    return record;
  }

  private sessionFromRow(row: SqlRow): SessionRecord {
    const record: SessionRecord = {
      id: String(row.id),
      workItemId: String(row.work_item_id),
      provider: String(row.provider) as ProviderName,
      providerSessionId: String(row.provider_session_id),
      status: String(row.status) as SessionRecord['status'],
      lastActivityAt: String(row.last_activity_at),
    };
    if (row.provider_url !== null) record.providerUrl = String(row.provider_url);
    if (row.branch !== null) record.branch = String(row.branch);
    return record;
  }

  private runFromRow(row: SqlRow): RunRecord {
    const record: RunRecord = {
      id: String(row.id),
      sessionId: String(row.session_id),
      workItemId: String(row.work_item_id),
      provider: String(row.provider) as ProviderName,
      type: String(row.type) as RunType,
      mutationMode: String(row.mutation_mode) as MutationMode,
      status: String(row.status) as ProviderRunStatus,
      correlationId: String(row.correlation_id),
      delegationDepth: Number(row.delegation_depth),
      startedAt: String(row.started_at),
    };
    if (row.prompt !== null) record.prompt = String(row.prompt);
    if (row.origin_provider !== null) {
      record.originProvider = String(row.origin_provider) as ProviderName;
    }
    if (row.parent_run_id !== null) record.parentRunId = String(row.parent_run_id);
    if (row.expected_branch !== null) {
      record.expectedBranch = String(row.expected_branch);
    }
    if (row.baseline_sha !== null) record.baselineSha = String(row.baseline_sha);
    if (row.pinned_sha !== null) record.pinnedSha = String(row.pinned_sha);
    if (row.finished_at !== null) record.finishedAt = String(row.finished_at);
    return record;
  }

  private artifactFromRow(row: SqlRow): ArtifactRecord {
    const record: ArtifactRecord = {
      id: String(row.id),
      workItemId: String(row.work_item_id),
      branch: String(row.branch),
      sha: String(row.sha),
      status: String(row.verification_status) as ArtifactRecord['status'],
      checks: String(row.checks) as CheckSummary,
      observedAt: String(row.observed_at),
    };
    if (row.pull_request !== null) record.pullRequest = Number(row.pull_request);
    if (row.mergeable !== null) record.mergeable = Boolean(row.mergeable);
    if (row.review_decision !== null) {
      record.reviewDecision = String(row.review_decision);
    }
    if (row.draft !== null) record.draft = Boolean(row.draft);
    return record;
  }
}

function containsSensitiveSetting(value: unknown, key = ''): boolean {
  if (key !== '' && isSensitiveSettingKey(key)) return true;
  if (Array.isArray(value)) {
    return value.some((entry) => containsSensitiveSetting(entry));
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).some(([entryKey, entryValue]) =>
      containsSensitiveSetting(entryValue, entryKey),
    );
  }
  return false;
}

function isSensitiveSettingKey(key: string): boolean {
  const segments = normalizedKeySegments(key);
  return (
    segments.some((segment) => SENSITIVE_SETTING_SEGMENTS.has(segment)) ||
    SENSITIVE_SETTING_COMPOUND_ALIASES.has(segments.join('')) ||
    segments.some(
      (segment, index) =>
        (segment === 'environment' || segment === 'env') &&
        !(
          index === segments.length - 2 &&
          ENVIRONMENT_REFERENCE_SEGMENTS.has(segments[index + 1] ?? '')
        ),
    )
  );
}

function normalizedKeySegments(key: string): readonly string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((segment) => segment !== '');
}

function isValidDate(value: Date): boolean {
  return Number.isFinite(value.getTime());
}

function isIsoTimestamp(value: string): boolean {
  const parsed = new Date(value);
  return isValidDate(parsed) && parsed.toISOString() === value;
}
