import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import Database from 'better-sqlite3';

import { RelayError } from './errors.js';
import {
  parseResolvedSkills,
  serializeResolvedSkills,
  type ResolvedSkill,
} from './skills.js';
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
  integrationBranch: string;
  skillSourceSha?: string;
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
  accountId?: string;
  providerSessionId: string;
  providerUrl?: string;
  status: 'pending' | 'active' | 'complete' | 'failed' | 'expired';
  branch?: string;
  skills?: readonly ResolvedSkill[];
}

export interface SessionRecord extends Omit<SessionInput, 'skills'> {
  id: string;
  skills: readonly ResolvedSkill[];
  lastActivityAt: string;
}

export type RunType =
  | 'delegation'
  | 'message'
  | 'handoff'
  | 'inspection'
  | 'publication';

export interface RunInput {
  id?: string;
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
  accountId?: string;
  model?: string;
  baseSha?: string;
  resultSha?: string;
}

export interface RunRecord extends RunInput {
  id: string;
  workItemId: string;
  status: ProviderRunStatus;
  correlationId: string;
  delegationDepth: number;
  startedAt: string;
  finishedAt?: string;
  launchAttemptId?: string;
  launchState?: 'prepared' | 'accepted' | 'uncertain';
  skills: readonly ResolvedSkill[];
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

export type CandidateStatus =
  | 'ready'
  | 'staged'
  | 'landed'
  | 'conflict'
  | 'checks_failed'
  | 'stale'
  | 'discarded';

export interface CandidateRecord {
  id: string;
  runId: string;
  workItemId: string;
  status: CandidateStatus;
  sourceBranch: string;
  sourceSha: string;
  baseSha: string;
  integrationBranch: string;
  stagingBranch?: string;
  stagingSha?: string;
  integrationBaseSha?: string;
  integrationRefExisted?: boolean;
  landedSha?: string;
  conflictFiles: readonly string[];
  createdAt: string;
  updatedAt: string;
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

const LAUNCH_UNCERTAIN_STATUS: ProviderRunStatus = 'launch_uncertain';
const ACTIVE_LAUNCH_OWNERS = new Set<string>();

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
    'launch_uncertain',
  ]),
  provider_complete: new Set(['awaiting_publish', 'published', 'failed']),
  awaiting_publish: new Set(['published', 'failed', 'cancelled']),
  published: new Set(['verified', 'failed']),
  verified: new Set(),
  failed: new Set(),
  cancelled: new Set(),
  expired: new Set(),
  launch_uncertain: new Set(['cancelled']),
};

const FINISHED_RUN_STATUSES = new Set<ProviderRunStatus>([
  'verified',
  'failed',
  'cancelled',
  'expired',
]);

export class StateStore {
  private readonly launchOwnerId = randomUUID();

  private constructor(private readonly database: Database.Database) {
    ACTIVE_LAUNCH_OWNERS.add(this.launchOwnerId);
  }

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
    store.recoverInterruptedLaunches();
    return store;
  }

  close(): void {
    try {
      this.quarantineOwnedLaunches(this.launchOwnerId);
    } finally {
      ACTIVE_LAUNCH_OWNERS.delete(this.launchOwnerId);
      this.database.close();
    }
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

  countActiveAccountLeases(accountId: string, now = new Date()): number {
    if (!isValidDate(now)) {
      throw new RelayError('invalid_argument', 'Lease time must be a valid date.');
    }
    const row = this.database
      .prepare(
        `SELECT COUNT(*) AS count
         FROM account_leases AS lease
         JOIN provider_runs AS run ON run.id = lease.run_id
         WHERE lease.account_id = ?
           AND (
             lease.expires_at > ?
             OR run.status = 'launch_uncertain'
             OR run.launch_state IN ('prepared', 'accepted')
           )`,
      )
      .get(accountId, now.toISOString()) as SqlRow;
    return Number(row.count);
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
      this.requireAccountLeaseRunOwner(accountId, runId);
      const acquiredAt = now.toISOString();
      const expiresAt = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
      this.database
        .prepare(
          `DELETE FROM account_leases
           WHERE account_id = ? AND expires_at <= ?
             AND run_id NOT IN (
               SELECT id FROM provider_runs
               WHERE status = 'launch_uncertain'
                  OR launch_state IN ('prepared', 'accepted')
             )`,
        )
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

  heartbeatAccountLease(
    accountId: string,
    runId: string,
    now = new Date(),
  ): AccountLeaseRecord {
    if (!isValidDate(now)) {
      throw new RelayError('invalid_argument', 'Lease time must be a valid date.');
    }
    return this.database.transaction(() => {
      this.requireAccountLeaseRunOwner(accountId, runId, { active: true });
      const acquiredAt = now.toISOString();
      const existing = this.database
        .prepare(
          `SELECT * FROM account_leases
           WHERE account_id = ? AND run_id = ? AND expires_at > ?`,
        )
        .get(accountId, runId, acquiredAt) as SqlRow | undefined;
      if (existing === undefined) {
        throw new RelayError(
          'not_found',
          `Run ${runId} does not hold an active lease for account ${accountId}.`,
        );
      }
      const expiresAt = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
      this.database
        .prepare(
          `UPDATE account_leases SET acquired_at = ?, expires_at = ?
           WHERE account_id = ? AND run_id = ?`,
        )
        .run(acquiredAt, expiresAt, accountId, runId);
      return { accountId, runId, acquiredAt, expiresAt };
    }).immediate();
  }

  createWorkItem(input: WorkItemInput): WorkItemRecord {
    return this.database.transaction(() => {
      const id = input.id ?? randomUUID();
      const now = new Date().toISOString();
      const integrationBranch = isDedicatedIntegrationBranch(
        input.currentBranch,
        input.baseBranch,
      )
        ? input.currentBranch
        : integrationBranchFor(id, input.baseBranch);
      const currentBranch = isRelayCandidateBranch(input.currentBranch)
        ? integrationBranch
        : input.currentBranch;
      this.database
        .prepare(
          `INSERT INTO work_items (
            id, project_id, title, base_branch, integration_branch,
            current_branch, status,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'in_progress', ?, ?)`,
        )
        .run(
          id,
          input.projectId,
          input.title,
          input.baseBranch,
          integrationBranch,
          currentBranch ?? null,
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

  pinWorkItemSkillSource(id: string, sourceSha: string): WorkItemRecord {
    if (!/^[0-9a-f]{40}$/i.test(sourceSha)) {
      throw new RelayError(
        'invalid_argument',
        'Skill source SHA must contain exactly 40 hexadecimal characters.',
      );
    }
    const normalizedSha = sourceSha.toLowerCase();
    return this.database.transaction(() => {
      const row = this.requiredRow(
        this.database
          .prepare('SELECT skill_source_sha FROM work_items WHERE id = ?')
          .get(id),
        `WorkItem ${id} was not found.`,
      );
      const existing = nullableString(row.skill_source_sha);
      if (existing !== undefined && existing !== normalizedSha) {
        throw new RelayError(
          'state_conflict',
          `WorkItem ${id} is already pinned to another skill source commit.`,
          { workItemId: id, skillSourceSha: existing },
        );
      }
      if (existing === undefined) {
        this.database
          .prepare(
            'UPDATE work_items SET skill_source_sha = ?, updated_at = ? WHERE id = ?',
          )
          .run(normalizedSha, new Date().toISOString(), id);
      }
      return this.getWorkItem(id);
    }).immediate();
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
             WHERE work_item_id = ? AND provider = ? AND account_id IS ?
               AND provider_session_id <> ? AND status = 'active'`,
          )
          .run(
            input.workItemId,
            input.provider,
            input.accountId ?? null,
            input.providerSessionId,
          );
      }
      const existing = this.database
        .prepare(
          `SELECT id, skills_json FROM provider_sessions
           WHERE work_item_id = ? AND provider = ? AND account_id IS ?
             AND provider_session_id = ?`,
        )
        .get(
          input.workItemId,
          input.provider,
          input.accountId ?? null,
          input.providerSessionId,
        ) as SqlRow | undefined;
      if (existing === undefined) {
        const skillsJson = serializeResolvedSkills(input.skills ?? []);
        this.database
          .prepare(
            `INSERT INTO provider_sessions (
              id, work_item_id, provider, account_id, provider_session_id, provider_url,
              status, branch, skills_json, last_activity_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            randomUUID(),
            input.workItemId,
            input.provider,
            input.accountId ?? null,
            input.providerSessionId,
            input.providerUrl ?? null,
            input.status,
            input.branch ?? null,
            skillsJson,
            now,
          );
      } else {
        if (
          input.skills !== undefined &&
          serializeResolvedSkills(input.skills) !== String(existing.skills_json)
        ) {
          throw new RelayError(
            'state_conflict',
            'A provider session skill selection cannot be changed.',
            { sessionId: String(existing.id) },
          );
        }
        this.database
          .prepare(
            `UPDATE provider_sessions SET provider_url = ?, status = ?, branch = ?,
             last_activity_at = ? WHERE id = ?`,
          )
          .run(
            input.providerUrl ?? null,
            input.status,
            input.branch ?? null,
            now,
            existing.id,
          );
      }
    })();
    return this.sessionFromRow(
      this.requiredRow(
        this.database
          .prepare(
            `SELECT * FROM provider_sessions
             WHERE work_item_id = ? AND provider = ? AND account_id IS ?
               AND provider_session_id = ?`,
          )
          .get(
            input.workItemId,
            input.provider,
            input.accountId ?? null,
            input.providerSessionId,
          ),
        `Session for ${input.provider} was not persisted.`,
      ),
    );
  }

  getSession(
    workItemId: string,
    provider: ProviderName,
    accountId?: string,
  ): SessionRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM provider_sessions WHERE work_item_id = ? AND provider = ?
           AND account_id IS ?
         ORDER BY CASE status
           WHEN 'active' THEN 0
           WHEN 'pending' THEN 1
           ELSE 2
         END, last_activity_at DESC, rowid DESC LIMIT 1`,
      )
      .get(workItemId, provider, accountId ?? null) as SqlRow | undefined;
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
        .prepare('SELECT work_item_id, provider, account_id FROM provider_sessions WHERE id = ?')
          .get(id),
        `Session ${id} was not found.`,
      );
      const now = new Date().toISOString();
      if (input.status === 'active') {
        this.database
          .prepare(
            `UPDATE provider_sessions SET status = 'expired'
             WHERE work_item_id = ? AND provider = ? AND account_id IS ? AND id <> ?
               AND status = 'active'`,
          )
          .run(current.work_item_id, current.provider, current.account_id, id);
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
          .prepare(
            `SELECT work_item_id, provider, account_id, skills_json
             FROM provider_sessions WHERE id = ?`,
          )
          .get(input.sessionId),
        `Session ${input.sessionId} was not found.`,
      );
      const workItemId = String(session.work_item_id);
      const provider = String(session.provider) as ProviderName;
      const accountId = nullableString(session.account_id);
      const skillsJson = String(session.skills_json);
      parseResolvedSkills(skillsJson);
      if (input.provider !== provider) {
        throw new RelayError(
          'provider_mismatch',
          `Run provider ${input.provider} does not match session provider ${provider}.`,
        );
      }
      if (input.accountId !== undefined && input.accountId !== accountId) {
        throw new RelayError(
          'provider_mismatch',
          `Run account ${input.accountId} does not match its session account.`,
        );
      }
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

      const id = input.id ?? randomUUID();
      const now = new Date().toISOString();
      const correlationId = input.correlationId ?? id;
      this.database
        .prepare(
          `INSERT INTO provider_runs (
            id, session_id, work_item_id, provider, type, prompt, status,
            mutation_mode, correlation_id, origin_provider, delegation_depth,
            parent_run_id, expected_branch, baseline_sha, pinned_sha, account_id,
            model, base_sha, result_sha, skills_json, started_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.sessionId,
          workItemId,
          provider,
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
          accountId ?? null,
          input.model ?? null,
          input.baseSha ?? null,
          input.resultSha ?? null,
          skillsJson,
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

  setRunResultSha(id: string, resultSha: string): RunRecord {
    if (!/^[0-9a-f]{40}$/i.test(resultSha)) {
      throw new RelayError(
        'invalid_argument',
        'Run result SHA must contain exactly 40 hexadecimal characters.',
      );
    }
    this.database
      .prepare('UPDATE provider_runs SET result_sha = ? WHERE id = ?')
      .run(resultSha, id);
    return this.getRun(id);
  }

  prepareRunLaunch(id: string, attemptId: string = randomUUID()): RunRecord {
    if (attemptId.trim() === '') {
      throw new RelayError('invalid_argument', 'Launch attempt ID is required.');
    }
    return this.setRunLaunchState(id, 'prepared', attemptId);
  }

  markRunLaunchAccepted(id: string, attemptId: string): RunRecord {
    return this.setRunLaunchState(id, 'accepted', attemptId);
  }

  completeRunLaunch(id: string, attemptId: string): RunRecord {
    return this.database.transaction(() => {
      const run = this.getRun(id);
      const owner = this.database
        .prepare('SELECT launch_owner_id FROM provider_runs WHERE id = ?')
        .get(id) as SqlRow;
      if (
        run.launchAttemptId !== attemptId ||
        run.launchState !== 'accepted' ||
        nullableString(owner.launch_owner_id) !== this.launchOwnerId
      ) {
        throw new RelayError(
          'invalid_run_transition',
          `Run ${id} does not have the accepted launch attempt ${attemptId}.`,
        );
      }
      this.database
        .prepare(
          `UPDATE provider_runs
           SET launch_state = NULL, launch_owner_id = NULL, launch_owner_pid = NULL
           WHERE id = ?`,
        )
        .run(id);
      return this.getRun(id);
    }).immediate();
  }

  markRunLaunchUncertain(id: string, attemptId?: string): RunRecord {
    return this.database.transaction(() => {
      const run = this.getRun(id);
      if (String(run.status) !== LAUNCH_UNCERTAIN_STATUS) {
        if (!RUN_TRANSITIONS[run.status].has(LAUNCH_UNCERTAIN_STATUS)) {
          throw new RelayError(
            'invalid_run_transition',
            `Run ${id} cannot be quarantined from ${run.status}.`,
          );
        }
        this.database
          .prepare(
            `UPDATE provider_runs SET status = 'launch_uncertain',
             launch_state = 'uncertain', launch_attempt_id = ?,
             launch_owner_id = NULL, launch_owner_pid = NULL, finished_at = NULL
             WHERE id = ?`,
          )
          .run(attemptId ?? run.launchAttemptId ?? randomUUID(), id);
      }
      return this.getRun(id);
    }).immediate();
  }

  resolveUncertainLaunch(id: string): RunRecord {
    return this.database.transaction(() => {
      const run = this.getRun(id);
      if (run.status !== 'launch_uncertain') {
        throw new RelayError(
          'invalid_run_transition',
          `Run ${id} is not awaiting uncertain-launch resolution.`,
        );
      }
      const now = new Date().toISOString();
      const siblings = this.database
        .prepare(
          `SELECT id, status, launch_attempt_id
           FROM provider_runs
           WHERE session_id = ? AND id <> ? AND status IN ('queued', 'running')`,
        )
        .all(run.sessionId, id) as SqlRow[];
      const quarantineSibling = this.database.prepare(
        `UPDATE provider_runs SET status = 'launch_uncertain',
         launch_state = 'uncertain', launch_attempt_id = ?,
         launch_owner_id = NULL, launch_owner_pid = NULL, finished_at = NULL
         WHERE id = ?`,
      );
      const cancelSibling = this.database.prepare(
        `UPDATE provider_runs SET status = 'cancelled', finished_at = ?
         WHERE id = ?`,
      );
      const releaseSiblingLease = this.database.prepare(
        'DELETE FROM account_leases WHERE run_id = ?',
      );
      for (const sibling of siblings) {
        const siblingId = String(sibling.id);
        if (sibling.status === 'running') {
          quarantineSibling.run(
            nullableString(sibling.launch_attempt_id) ?? randomUUID(),
            siblingId,
          );
        } else {
          cancelSibling.run(now, siblingId);
          releaseSiblingLease.run(siblingId);
        }
      }
      this.database
        .prepare(
          `UPDATE provider_runs SET status = 'cancelled', finished_at = ?
           WHERE id = ?`,
        )
        .run(now, id);
      this.database
        .prepare(
          `UPDATE provider_sessions SET status = 'failed', last_activity_at = ?
           WHERE id = ? AND status IN ('pending', 'active')`,
        )
        .run(now, run.sessionId);
      this.database
        .prepare('DELETE FROM account_leases WHERE run_id = ?')
        .run(id);
      return this.getRun(id);
    }).immediate();
  }

  recoverInterruptedLaunches(): number {
    return this.database.transaction(() => {
      const owners = this.database
        .prepare(
          `SELECT launch_owner_id, launch_owner_pid
           FROM provider_runs
           WHERE status IN ('queued', 'running')
             AND launch_state IN ('prepared', 'accepted')
           GROUP BY launch_owner_id, launch_owner_pid`,
        )
        .all() as SqlRow[];
      let recovered = 0;
      for (const owner of owners) {
        const ownerId = nullableString(owner.launch_owner_id);
        const ownerPid = nullableInteger(owner.launch_owner_pid);
        if (ownerId !== undefined && ACTIVE_LAUNCH_OWNERS.has(ownerId)) continue;
        if (
          ownerPid !== undefined &&
          ownerPid !== process.pid &&
          isProcessAlive(ownerPid)
        ) {
          continue;
        }
        recovered += this.quarantineOwnedLaunches(ownerId).changes;
      }
      return recovered;
    }).immediate();
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

  createCandidateForRun(runId: string): CandidateRecord | undefined {
    return this.database.transaction(() => {
      const existing = this.getCandidate(runId);
      if (existing !== undefined) return existing;
      const row = this.requiredRow(
        this.database
          .prepare(
            `SELECT provider_runs.id, provider_runs.work_item_id,
                    provider_runs.mutation_mode, provider_runs.expected_branch,
                    provider_runs.base_sha, provider_runs.result_sha,
                    work_items.base_branch, work_items.integration_branch
             FROM provider_runs
             JOIN work_items ON work_items.id = provider_runs.work_item_id
             WHERE provider_runs.id = ?`,
          )
          .get(runId),
        `Run ${runId} was not found.`,
      );
      const sourceBranch = nullableString(row.expected_branch);
      const baseSha = nullableString(row.base_sha);
      const sourceSha = nullableString(row.result_sha);
      const integrationBranch = nullableString(row.integration_branch);
      if (
        row.mutation_mode !== 'write' ||
        sourceBranch === undefined ||
        !sourceBranch.startsWith('relay/run/') ||
        baseSha === undefined ||
        sourceSha === undefined ||
        !isFullSha(baseSha) ||
        !isFullSha(sourceSha) ||
        baseSha === sourceSha ||
        !isDedicatedIntegrationBranch(
          integrationBranch,
          String(row.base_branch),
        )
      ) {
        return undefined;
      }

      const now = new Date().toISOString();
      this.database
        .prepare(
          `INSERT INTO candidates (
            run_id, work_item_id, status, source_branch, source_sha, base_sha,
            integration_branch, conflict_paths_json, created_at, updated_at
          ) VALUES (?, ?, 'ready', ?, ?, ?, ?, '[]', ?, ?)`,
        )
        .run(
          runId,
          row.work_item_id,
          sourceBranch,
          sourceSha,
          baseSha,
          integrationBranch,
          now,
          now,
        );
      return this.getCandidate(runId);
    }).immediate();
  }

  getCandidate(runId: string): CandidateRecord | undefined {
    const row = this.database
      .prepare('SELECT * FROM candidates WHERE run_id = ?')
      .get(runId) as SqlRow | undefined;
    return row === undefined ? undefined : this.candidateFromRow(row);
  }

  recordCandidateStage(
    runId: string,
    input: {
      stagingBranch: string;
      stagingSha: string;
      integrationBaseSha: string;
      integrationRefExisted: boolean;
    },
  ): CandidateRecord {
    if (
      !isFullSha(input.stagingSha) ||
      !isFullSha(input.integrationBaseSha) ||
      input.stagingBranch.length === 0
    ) {
      throw new RelayError('invalid_argument', 'Candidate staging fields are invalid.');
    }
    const result = this.database
      .prepare(
        `UPDATE candidates SET status = 'staged', staging_branch = ?,
           staging_sha = ?, integration_base_sha = ?, integration_ref_existed = ?,
           landed_sha = NULL,
           conflict_paths_json = '[]', updated_at = ? WHERE run_id = ?`,
      )
      .run(
        input.stagingBranch,
        input.stagingSha,
        input.integrationBaseSha,
        Number(input.integrationRefExisted),
        new Date().toISOString(),
        runId,
      );
    if (result.changes !== 1) {
      throw new RelayError('not_found', `Candidate ${runId} was not found.`);
    }
    return this.getCandidate(runId)!;
  }

  setCandidateStatus(
    runId: string,
    status: Exclude<CandidateStatus, 'ready' | 'staged'>,
    input: { landedSha?: string; conflictFiles?: readonly string[] } = {},
  ): CandidateRecord {
    if (input.landedSha !== undefined && !isFullSha(input.landedSha)) {
      throw new RelayError(
        'invalid_argument',
        'Candidate landed SHA must contain exactly 40 hexadecimal characters.',
      );
    }
    const result = this.database
      .prepare(
        `UPDATE candidates SET status = ?, landed_sha = ?,
           conflict_paths_json = ?, updated_at = ? WHERE run_id = ?`,
      )
      .run(
        status,
        input.landedSha ?? null,
        JSON.stringify(input.conflictFiles ?? []),
        new Date().toISOString(),
        runId,
      );
    if (result.changes !== 1) {
      throw new RelayError('not_found', `Candidate ${runId} was not found.`);
    }
    return this.getCandidate(runId)!;
  }

  acquireLandingLease(
    workItemId: string,
    runId: string,
    now = new Date(),
  ): void {
    if (!isValidDate(now)) {
      throw new RelayError('invalid_argument', 'Lease time must be a valid date.');
    }
    this.database.transaction(() => {
      const nowText = now.toISOString();
      this.database
        .prepare('DELETE FROM landing_leases WHERE expires_at <= ?')
        .run(nowText);
      const existing = this.database
        .prepare('SELECT run_id FROM landing_leases WHERE work_item_id = ?')
        .get(workItemId) as { run_id: string } | undefined;
      if (existing !== undefined) {
        throw new RelayError(
          'work_item_locked',
          `WorkItem ${workItemId} already has an active landing attempt.`,
        );
      }
      const expiresAt = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
      this.database
        .prepare(
          `INSERT INTO landing_leases (work_item_id, run_id, acquired_at, expires_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(workItemId, runId, nowText, expiresAt);
    }).immediate();
  }

  releaseLandingLease(workItemId: string, runId: string): void {
    this.database
      .prepare(
        'DELETE FROM landing_leases WHERE work_item_id = ? AND run_id = ?',
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
      if (!input.branch.startsWith('relay/run/')) {
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
      }
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
    if (!applied.has(4)) {
      this.database.pragma('foreign_keys = OFF');
      try {
        this.database.transaction(() => {
          this.database.exec(`
          CREATE TABLE provider_sessions_scoped (
            id TEXT PRIMARY KEY,
            work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
            provider TEXT NOT NULL,
            account_id TEXT REFERENCES provider_accounts(id),
            provider_session_id TEXT NOT NULL,
            provider_url TEXT,
            status TEXT NOT NULL,
            branch TEXT,
            last_activity_at TEXT NOT NULL,
            UNIQUE (work_item_id, provider, account_id, provider_session_id)
          );
          INSERT INTO provider_sessions_scoped (
            id, work_item_id, provider, provider_session_id, provider_url,
            status, branch, last_activity_at
          )
          SELECT id, work_item_id, provider, provider_session_id, provider_url,
                 status, branch, last_activity_at
          FROM provider_sessions;
          CREATE TABLE provider_runs_scoped (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL REFERENCES provider_sessions_scoped(id) ON DELETE CASCADE,
            work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
            provider TEXT NOT NULL,
            type TEXT NOT NULL,
            prompt TEXT,
            status TEXT NOT NULL,
            mutation_mode TEXT NOT NULL,
            correlation_id TEXT NOT NULL,
            origin_provider TEXT,
            delegation_depth INTEGER NOT NULL,
            parent_run_id TEXT REFERENCES provider_runs_scoped(id),
            expected_branch TEXT,
            baseline_sha TEXT,
            pinned_sha TEXT,
            account_id TEXT REFERENCES provider_accounts(id),
            model TEXT,
            base_sha TEXT,
            result_sha TEXT,
            started_at TEXT NOT NULL,
            finished_at TEXT
          );
          INSERT INTO provider_runs_scoped (
            id, session_id, work_item_id, provider, type, prompt, status,
            mutation_mode, correlation_id, origin_provider, delegation_depth,
            parent_run_id, expected_branch, baseline_sha, pinned_sha, started_at,
            finished_at
          )
          SELECT id, session_id, work_item_id, provider, type, prompt, status,
                 mutation_mode, correlation_id, origin_provider, delegation_depth,
                 parent_run_id, expected_branch, baseline_sha, pinned_sha, started_at,
                 finished_at
          FROM provider_runs;
          DROP TABLE provider_runs;
          DROP TABLE provider_sessions;
          ALTER TABLE provider_sessions_scoped RENAME TO provider_sessions;
          ALTER TABLE provider_runs_scoped RENAME TO provider_runs;
          CREATE INDEX provider_sessions_account_scope
            ON provider_sessions(work_item_id, provider, account_id, last_activity_at);
        `);
          this.recordMigration(4);
        }).immediate();
      } finally {
        this.database.pragma('foreign_keys = ON');
      }
      const violations = this.database.pragma('foreign_key_check') as unknown[];
      if (violations.length > 0) {
        throw new Error('Migration 4 left foreign-key violations.');
      }
    }
    if (!applied.has(5)) {
      this.database.transaction(() => {
        this.database.exec(`
          CREATE TABLE candidates (
            run_id TEXT PRIMARY KEY REFERENCES provider_runs(id) ON DELETE CASCADE,
            work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
            status TEXT NOT NULL CHECK(status IN (
              'ready','staged','landed','conflict','checks_failed','stale','discarded'
            )),
            source_branch TEXT NOT NULL,
            source_sha TEXT NOT NULL,
            base_sha TEXT NOT NULL,
            staging_branch TEXT,
            staging_sha TEXT,
            integration_base_sha TEXT,
            integration_ref_existed INTEGER CHECK(integration_ref_existed IN (0,1)),
            landed_sha TEXT,
            conflict_paths_json TEXT NOT NULL DEFAULT '[]',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE INDEX candidates_work_item_status
            ON candidates(work_item_id, status, created_at);
          CREATE TABLE landing_leases (
            work_item_id TEXT PRIMARY KEY REFERENCES work_items(id) ON DELETE CASCADE,
            run_id TEXT NOT NULL REFERENCES provider_runs(id) ON DELETE CASCADE,
            acquired_at TEXT NOT NULL,
            expires_at TEXT NOT NULL
          );
        `);
        this.recordMigration(5);
      }).immediate();
    }
    if (!applied.has(6)) {
      this.database.transaction(() => {
        this.database.exec(`
          ALTER TABLE work_items ADD COLUMN integration_branch TEXT;
          ALTER TABLE candidates ADD COLUMN integration_branch TEXT;
        `);
        const workItems = this.database
          .prepare(
            `SELECT id, base_branch, current_branch, current_sha, pull_request
             FROM work_items`,
          )
          .all() as SqlRow[];
        const updateWorkItem = this.database.prepare(
          `UPDATE work_items
           SET integration_branch = ?, current_branch = ?, current_sha = ?,
               pull_request = ?, updated_at = ?
           WHERE id = ?`,
        );
        const now = new Date().toISOString();
        for (const row of workItems) {
          const id = String(row.id);
          const baseBranch = String(row.base_branch);
          const currentBranch = nullableString(row.current_branch);
          const integrationBranch = isDedicatedIntegrationBranch(
            currentBranch,
            baseBranch,
          )
            ? currentBranch
            : integrationBranchFor(id, baseBranch);
          const replacesCandidateBranch = isRelayCandidateBranch(currentBranch);
          updateWorkItem.run(
            integrationBranch,
            replacesCandidateBranch ? integrationBranch : currentBranch ?? null,
            replacesCandidateBranch ? null : row.current_sha,
            replacesCandidateBranch ? null : row.pull_request,
            now,
            id,
          );
        }
        this.database.exec(`
          UPDATE candidates
          SET integration_branch = (
            SELECT work_items.integration_branch
            FROM work_items
            WHERE work_items.id = candidates.work_item_id
          );
        `);
        this.recordMigration(6);
      }).immediate();
    }
    if (!applied.has(7)) {
      this.database.transaction(() => {
        const workItems = this.database
          .prepare('SELECT id, base_branch, integration_branch FROM work_items')
          .all() as SqlRow[];
        const updateWorkItem = this.database.prepare(
          'UPDATE work_items SET integration_branch = ?, updated_at = ? WHERE id = ?',
        );
        const now = new Date().toISOString();
        for (const row of workItems) {
          const id = String(row.id);
          const baseBranch = String(row.base_branch);
          const integrationBranch = nullableString(row.integration_branch);
          if (isDedicatedIntegrationBranch(integrationBranch, baseBranch)) continue;
          updateWorkItem.run(integrationBranchFor(id, baseBranch), now, id);
        }
        this.database.exec(`
          UPDATE candidates
          SET integration_branch = (
            SELECT work_items.integration_branch
            FROM work_items
            WHERE work_items.id = candidates.work_item_id
          );
        `);
        this.recordMigration(7);
      }).immediate();
    }
    if (!applied.has(8)) {
      this.database.pragma('foreign_keys = OFF');
      try {
        this.database.transaction(() => {
          this.database.exec(`
            ALTER TABLE provider_runs ADD COLUMN launch_attempt_id TEXT;
            ALTER TABLE provider_runs ADD COLUMN launch_state TEXT
              CHECK(launch_state IN ('prepared','accepted','uncertain'));
            ALTER TABLE provider_runs ADD COLUMN launch_owner_id TEXT;
            ALTER TABLE provider_runs ADD COLUMN launch_owner_pid INTEGER;
          `);
          const hasAccountLeases = this.database
            .prepare(
              `SELECT 1 FROM sqlite_master
               WHERE type = 'table' AND name = 'account_leases'`,
            )
            .get() !== undefined;
          if (hasAccountLeases) {
            const invalidLeaseCount = this.database
              .prepare(
                `SELECT COUNT(*) AS count
                 FROM account_leases AS lease
                 LEFT JOIN provider_runs AS run ON run.id = lease.run_id
                 WHERE run.id IS NULL OR run.account_id IS NOT lease.account_id`,
              )
              .get() as SqlRow;
            if (Number(invalidLeaseCount.count) !== 0) {
              throw new Error('Migration 8 found account leases without matching account-owned runs.');
            }
          }
          this.database.exec(`
            CREATE TABLE account_leases_scoped (
              account_id TEXT NOT NULL REFERENCES provider_accounts(id) ON DELETE CASCADE,
              run_id TEXT NOT NULL REFERENCES provider_runs(id) ON DELETE CASCADE,
              acquired_at TEXT NOT NULL,
              expires_at TEXT NOT NULL,
              PRIMARY KEY(account_id, run_id)
            );
          `);
          if (hasAccountLeases) {
            this.database.exec(`
              INSERT INTO account_leases_scoped (account_id, run_id, acquired_at, expires_at)
              SELECT account_id, run_id, acquired_at, expires_at FROM account_leases;
              DROP TABLE account_leases;
            `);
          }
          this.database.exec('ALTER TABLE account_leases_scoped RENAME TO account_leases;');
          this.recordMigration(8);
        }).immediate();
      } finally {
        this.database.pragma('foreign_keys = ON');
      }
      const violations = this.database.pragma('foreign_key_check') as unknown[];
      if (violations.length > 0) {
        throw new Error('Migration 8 left foreign-key violations.');
      }
    }
    if (!applied.has(9)) {
      this.database.transaction(() => {
        this.database.exec(`
          ALTER TABLE work_items ADD COLUMN skill_source_sha TEXT;
          ALTER TABLE provider_sessions ADD COLUMN skills_json TEXT NOT NULL DEFAULT '[]';
          ALTER TABLE provider_runs ADD COLUMN skills_json TEXT NOT NULL DEFAULT '[]';
        `);
        this.recordMigration(9);
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

  private requireAccountLeaseRunOwner(
    accountId: string,
    runId: string,
    options: { active?: boolean } = {},
  ): void {
    const row = this.database
      .prepare(
        `SELECT run.account_id AS run_account_id, session.account_id AS session_account_id,
                run.status
         FROM provider_runs AS run
         JOIN provider_sessions AS session ON session.id = run.session_id
         WHERE run.id = ?`,
      )
      .get(runId) as SqlRow | undefined;
    if (row === undefined) {
      throw new RelayError('not_found', `Run ${runId} was not found.`);
    }
    if (
      nullableString(row.run_account_id) !== accountId ||
      nullableString(row.session_account_id) !== accountId
    ) {
      throw new RelayError(
        'provider_mismatch',
        `Run ${runId} is not owned by provider account ${accountId}.`,
      );
    }
    if (options.active === true && row.status !== 'running') {
      throw new RelayError(
        'invalid_run_transition',
        `Run ${runId} is not active for lease heartbeat.`,
      );
    }
  }

  private setRunLaunchState(
    id: string,
    launchState: 'prepared' | 'accepted',
    attemptId: string,
  ): RunRecord {
    if (attemptId.trim() === '') {
      throw new RelayError('invalid_argument', 'Launch attempt ID is required.');
    }
    return this.database.transaction(() => {
      const run = this.getRun(id);
      if (run.status !== 'queued' && run.status !== 'running') {
        throw new RelayError(
          'invalid_run_transition',
          `Run ${id} cannot record a launch attempt from ${run.status}.`,
        );
      }
      if (run.launchAttemptId !== undefined && run.launchAttemptId !== attemptId) {
        throw new RelayError(
          'invalid_argument',
          `Run ${id} already has a different launch attempt.`,
        );
      }
      if (launchState === 'accepted') {
        const owner = this.database
          .prepare('SELECT launch_owner_id FROM provider_runs WHERE id = ?')
          .get(id) as SqlRow;
        if (
          run.launchState !== 'prepared' ||
          nullableString(owner.launch_owner_id) !== this.launchOwnerId
        ) {
          throw new RelayError(
            'invalid_run_transition',
            `Run ${id} does not have a prepared launch owned by this process.`,
          );
        }
        this.database
          .prepare('UPDATE provider_runs SET launch_state = ? WHERE id = ?')
          .run(launchState, id);
      } else {
        if (run.launchState !== undefined && run.launchState !== 'prepared') {
          throw new RelayError(
            'invalid_run_transition',
            `Run ${id} already has launch state ${run.launchState}.`,
          );
        }
        this.database
          .prepare(
            `UPDATE provider_runs SET launch_attempt_id = ?, launch_state = ?,
             launch_owner_id = ?, launch_owner_pid = ? WHERE id = ?`,
          )
          .run(
            attemptId,
            launchState,
            this.launchOwnerId,
            process.pid,
            id,
          );
      }
      return this.getRun(id);
    }).immediate();
  }

  private quarantineOwnedLaunches(ownerId: string | undefined) {
    return this.database
      .prepare(
        `UPDATE provider_runs
         SET status = 'launch_uncertain', launch_state = 'uncertain',
             launch_owner_id = NULL, launch_owner_pid = NULL, finished_at = NULL
         WHERE status IN ('queued', 'running')
           AND launch_state IN ('prepared', 'accepted')
           AND launch_owner_id IS ?`,
      )
      .run(ownerId ?? null);
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
      integrationBranch: String(row.integration_branch),
      status: String(row.status) as WorkItemRecord['status'],
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
    if (row.current_branch !== null) record.currentBranch = String(row.current_branch);
    if (row.skill_source_sha !== null) {
      record.skillSourceSha = String(row.skill_source_sha);
    }
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
      skills: parseResolvedSkills(String(row.skills_json)),
      lastActivityAt: String(row.last_activity_at),
    };
    if (row.provider_url !== null) record.providerUrl = String(row.provider_url);
    if (row.account_id !== null) record.accountId = String(row.account_id);
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
      skills: parseResolvedSkills(String(row.skills_json)),
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
    if (row.account_id !== null) record.accountId = String(row.account_id);
    if (row.model !== null) record.model = String(row.model);
    if (row.base_sha !== null) record.baseSha = String(row.base_sha);
    if (row.result_sha !== null) record.resultSha = String(row.result_sha);
    if (row.launch_attempt_id !== null) {
      record.launchAttemptId = String(row.launch_attempt_id);
    }
    if (row.launch_state !== null) {
      record.launchState = String(row.launch_state) as NonNullable<RunRecord['launchState']>;
    }
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

  private candidateFromRow(row: SqlRow): CandidateRecord {
    const record: CandidateRecord = {
      id: String(row.run_id),
      runId: String(row.run_id),
      workItemId: String(row.work_item_id),
      status: String(row.status) as CandidateStatus,
      sourceBranch: String(row.source_branch),
      sourceSha: String(row.source_sha),
      baseSha: String(row.base_sha),
      integrationBranch: String(row.integration_branch),
      conflictFiles: parseStringArray(row.conflict_paths_json),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
    if (row.staging_branch !== null) {
      record.stagingBranch = String(row.staging_branch);
    }
    if (row.staging_sha !== null) record.stagingSha = String(row.staging_sha);
    if (row.integration_base_sha !== null) {
      record.integrationBaseSha = String(row.integration_base_sha);
    }
    if (row.integration_ref_existed !== null) {
      record.integrationRefExisted = Boolean(row.integration_ref_existed);
    }
    if (row.landed_sha !== null) record.landedSha = String(row.landed_sha);
    return record;
  }
}

function nullableString(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}

function nullableInteger(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (
      error instanceof Error &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'EPERM'
    );
  }
}

function isFullSha(value: string): boolean {
  return /^[0-9a-f]{40}$/i.test(value);
}

function isRelayCandidateBranch(branch: string | undefined): boolean {
  return (
    branch === 'relay/run' ||
    branch?.startsWith('relay/run/') === true ||
    branch === 'relay/stage' ||
    branch?.startsWith('relay/stage/') === true
  );
}

function isDedicatedIntegrationBranch(
  branch: string | undefined,
  baseBranch: string,
): branch is string {
  return (
    branch !== undefined &&
    branch.startsWith('relay/work/') &&
    branch.length > 'relay/work/'.length &&
    branch !== baseBranch
  );
}

function integrationBranchFor(workItemId: string, baseBranch: string): string {
  const label = workItemId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  const digest = createHash('sha256').update(workItemId).digest('hex').slice(0, 12);
  const branch = `relay/work/${label || 'work'}-${digest}`;
  return branch === baseBranch ? `${branch}-integration` : branch;
}

function parseStringArray(value: unknown): readonly string[] {
  const parsed: unknown = JSON.parse(String(value));
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== 'string')) {
    throw new Error('Candidate conflict paths are malformed.');
  }
  return parsed as string[];
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
