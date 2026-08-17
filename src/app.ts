import { homedir } from 'node:os';
import { join } from 'node:path';

import { Command, Option } from 'commander';

import { RelayError, redact } from './errors.js';
import { GitHubClient, type MergeStrategy } from './github-client.js';
import { LandingCoordinator, type LandingResult } from './landing.js';
import { ProcessRunner } from './process-runner.js';
import type {
  CloudProvider,
  MutationMode,
  ProviderName,
} from './provider.js';
import { ClaudeProvider } from './providers/claude.js';
import { CodexProvider } from './providers/codex.js';
import { JulesProvider } from './providers/jules.js';
import { RelayCore } from './relay-core.js';
import { runRepl } from './repl.js';
import {
  StateStore,
  type CandidateRecord,
  type ProviderAccountInput,
  type ProviderAccountRecord,
  type UsageSnapshotInput,
  type UsageSnapshotRecord,
} from './state-store.js';

type RelayCoreApi = Pick<
  RelayCore,
  | 'doctor'
  | 'initialize'
  | 'delegate'
  | 'send'
  | 'handoff'
  | 'status'
  | 'sessions'
  | 'providers'
  | 'reconcile'
  | 'chat'
  | 'merge'
>;

export interface RelayAccountSummary {
  id: string;
  label: string;
  provider: ProviderName;
  status: ProviderAccountRecord['status'];
  capacity: number;
  activeLeaseCount: number;
  latestUsage: readonly UsageSnapshotRecord[];
}

export type RelayStatus = Awaited<ReturnType<RelayCore['status']>> & {
  candidates?: readonly CandidateRecord[];
};

export type RelayApi = Omit<RelayCoreApi, 'status'> & {
  addAccount(input: ProviderAccountInput): Promise<ProviderAccountRecord>;
  accounts(): Promise<readonly RelayAccountSummary[]>;
  recordUsage(
    input: Omit<UsageSnapshotInput, 'observedAt'>,
  ): Promise<UsageSnapshotRecord>;
  usage(accountId: string): Promise<readonly UsageSnapshotRecord[]>;
  land(runId: string): Promise<LandingResult>;
  status(input: Parameters<RelayCore['status']>[0]): Promise<RelayStatus>;
};

export interface RelayIo {
  cwd(): string;
  write(text: string): void;
  writeError(text: string): void;
  readLine(prompt: string): Promise<string | undefined>;
  close(): void;
}

export interface CliOptions {
  serveMcp?: () => Promise<void>;
}

export interface RelayApplication {
  core: RelayApi;
  close(): void;
}

export function createRelayApplication(options: {
  statePath?: string;
  env?: NodeJS.ProcessEnv;
} = {}): RelayApplication {
  const env = options.env ?? process.env;
  const statePath =
    options.statePath ??
    join(
      env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'),
      'relay-madness',
      'relay.db',
    );
  const store = StateStore.open(statePath);
  const runner = new ProcessRunner();
  const providers = new Map<ProviderName, CloudProvider>([
    ['claude', new ClaudeProvider(runner, { env })],
    ['codex', new CodexProvider(runner, { env })],
    ['jules', new JulesProvider({ apiKey: () => env.JULES_API_KEY })],
  ]);
  const github = new GitHubClient(runner, { env });
  const relayCore = new RelayCore({
    store,
    github,
    providers,
    storePrompts: env.RELAY_STORE_PROMPTS !== 'false',
  });
  const landing = new LandingCoordinator({ store, github, runner });
  return {
    core: createRelayApi(relayCore, store, landing),
    close: () => store.close(),
  };
}

function createRelayApi(
  core: RelayCore,
  store: StateStore,
  landing: LandingCoordinator,
): RelayApi {
  return {
    doctor: core.doctor.bind(core),
    initialize: core.initialize.bind(core),
    delegate: core.delegate.bind(core),
    send: core.send.bind(core),
    handoff: core.handoff.bind(core),
    status: async (input) => {
      const status = await core.status(input);
      return {
        ...status,
        candidates: status.runs.flatMap((run) => {
          const candidate = store.getCandidate(run.id);
          return candidate === undefined ? [] : [candidate];
        }),
      };
    },
    sessions: core.sessions.bind(core),
    providers: core.providers.bind(core),
    reconcile: core.reconcile.bind(core),
    chat: core.chat.bind(core),
    merge: core.merge.bind(core),
    addAccount: async (input) => store.upsertProviderAccount(input),
    accounts: async () =>
      store.listProviderAccounts().map((account) => ({
        id: account.id,
        label: account.label,
        provider: account.provider,
        status: account.status,
        capacity: account.maxConcurrency,
        activeLeaseCount: store.countActiveAccountLeases(account.id),
        latestUsage: store.listLatestUsage(account.id),
      })),
    recordUsage: async (input) =>
      store.recordUsageSnapshot({
        ...input,
        observedAt: new Date().toISOString(),
      }),
    usage: async (accountId) => store.listLatestUsage(accountId),
    land: async (runId) => await landing.land(runId),
  };
}

export function createCli(
  core: RelayApi,
  io: RelayIo,
  options: CliOptions = {},
): Command {
  const program = new Command('relay');
  program
    .description('A thin relay for provider-hosted coding agents')
    .version('0.1.0')
    .configureOutput({
      writeOut: (text) => io.write(text),
      writeErr: (text) => io.writeError(text),
    })
    .action(async () => {
      await runRepl(core, io);
    });

  program
    .command('doctor')
    .description('Check GitHub and provider authentication')
    .option('--json', 'print machine-readable JSON')
    .action(async ({ json }: { json?: boolean }) => {
      const report = await core.doctor();
      if (json === true) return writeJson(io, report);
      writeHealth(io, 'GitHub', report.github);
      for (const provider of PROVIDERS) {
        writeHealth(io, titleCase(provider), report.providers[provider].auth);
      }
    });

  program
    .command('init')
    .description('Register the current GitHub project')
    .option('--codex-env <id>', 'Codex cloud environment ID')
    .option('--jules-source <name>', 'Jules source resource name')
    .option('--json', 'print machine-readable JSON')
    .action(
      async (commandOptions: {
        codexEnv?: string;
        julesSource?: string;
        json?: boolean;
      }) => {
        const providerConfigs: Partial<
          Record<ProviderName, Readonly<Record<string, unknown>>>
        > = {};
        if (commandOptions.codexEnv !== undefined) {
          providerConfigs.codex = { environmentId: commandOptions.codexEnv };
        }
        if (commandOptions.julesSource !== undefined) {
          providerConfigs.jules = { source: commandOptions.julesSource };
        }
        const project = await core.initialize({
          cwd: io.cwd(),
          ...(Object.keys(providerConfigs).length === 0
            ? {}
            : { providerConfigs }),
        });
        if (commandOptions.json === true) return writeJson(io, project);
        io.write(`Initialized ${project.repo}.\n`);
      },
    );

  program
    .command('delegate')
    .description('Delegate durable work to a cloud provider')
    .argument('<provider>', 'claude, codex, or jules')
    .argument('<task>', 'work to perform')
    .option('--title <title>', 'WorkItem title')
    .option('--work-item <id>', 'existing WorkItem ID')
    .option('--account <id>', 'provider account ID')
    .option('--model <model>', 'provider model identifier')
    .addOption(modeOption('write'))
    .option('--json', 'print machine-readable JSON')
    .action(async (providerText: string, task: string, commandOptions) => {
      const result = await core.delegate({
        provider: providerName(providerText),
        task,
        cwd: io.cwd(),
        mode: commandOptions.mode as MutationMode,
        ...(commandOptions.title === undefined
          ? {}
          : { title: commandOptions.title as string }),
        ...(commandOptions.workItem === undefined
          ? {}
          : { workItemId: commandOptions.workItem as string }),
        ...(commandOptions.account === undefined
          ? {}
          : { accountId: commandOptions.account as string }),
        ...(commandOptions.model === undefined
          ? {}
          : { model: commandOptions.model as string }),
      });
      writeResult(io, result, commandOptions.json === true);
    });

  program
    .command('send')
    .description('Continue a provider session for the current WorkItem')
    .argument('<provider>', 'claude, codex, or jules')
    .argument('<message>', 'message to send')
    .option('--work-item <id>', 'WorkItem ID')
    .addOption(modeOption('read'))
    .option('--json', 'print machine-readable JSON')
    .action(async (providerText: string, message: string, commandOptions) => {
      const result = await core.send({
        provider: providerName(providerText),
        message,
        mode: commandOptions.mode as MutationMode,
        ...selector(io, commandOptions.workItem as string | undefined),
      });
      writeResult(io, result, commandOptions.json === true);
    });

  program
    .command('handoff')
    .description('Hand verified GitHub state to another provider')
    .argument('<provider>', 'claude, codex, or jules')
    .argument('<instruction>', 'handoff instruction')
    .option('--work-item <id>', 'WorkItem ID')
    .option('--account <id>', 'provider account ID')
    .option('--model <model>', 'provider model identifier')
    .addOption(modeOption('read'))
    .option('--json', 'print machine-readable JSON')
    .action(async (providerText: string, instruction: string, commandOptions) => {
      const result = await core.handoff({
        provider: providerName(providerText),
        instruction,
        mode: commandOptions.mode as MutationMode,
        ...selector(io, commandOptions.workItem as string | undefined),
        ...(commandOptions.account === undefined
          ? {}
          : { accountId: commandOptions.account as string }),
        ...(commandOptions.model === undefined
          ? {}
          : { model: commandOptions.model as string }),
      });
      writeResult(io, result, commandOptions.json === true);
    });

  const account = program
    .command('account')
    .description('Manage local provider account references');
  account
    .command('add')
    .description('Register a local provider profile reference')
    .argument('<provider>', 'claude, codex, or jules')
    .argument('<id>', 'provider account ID')
    .requiredOption('--label <label>', 'human-readable account label')
    .requiredOption('--profile <path>', 'local profile reference')
    .option('--default', 'use this account by default for its provider')
    .action(async (providerText: string, id: string, commandOptions) => {
      const saved = await core.addAccount({
        id,
        provider: providerName(providerText),
        label: commandOptions.label as string,
        profilePath: commandOptions.profile as string,
        status: 'ready',
        maxConcurrency: 1,
        isDefault: commandOptions.default === true,
      });
      io.write(`Registered ${saved.label} (${saved.id}).\n`);
    });

  program
    .command('accounts')
    .description('List provider account capacity and weekly usage')
    .option('--json', 'print machine-readable JSON')
    .action(async ({ json }: { json?: boolean }) => {
      const accounts = await core.accounts();
      if (json === true) return writeJson(io, accounts);
      for (const entry of accounts) {
        io.write(
          `${titleCase(entry.provider)}  ${entry.label}  ${entry.status}  ${entry.activeLeaseCount}/${entry.capacity} active\n`,
        );
      }
    });

  const usage = program
    .command('usage')
    .description('Record or inspect caller-supplied weekly usage telemetry')
    .option('--account <id>', 'provider account ID')
    .option('--json', 'print machine-readable JSON')
    .action(async (commandOptions: { account?: string; json?: boolean }) => {
      if (commandOptions.account === undefined) {
        throw new RelayError('invalid_argument', '--account is required.');
      }
      const snapshots = await core.usage(commandOptions.account);
      if (commandOptions.json === true) return writeJson(io, snapshots);
      for (const snapshot of snapshots) {
        io.write(`${snapshot.model}  ${snapshot.remainingPercent}% remaining\n`);
      }
    });
  usage
    .command('set')
    .description('Record a caller-supplied weekly usage snapshot')
    .argument('<account>', 'provider account ID')
    .requiredOption('--model <model>', 'provider model identifier')
    .requiredOption('--remaining-percent <percent>', 'remaining weekly usage percent')
    .option('--resets-at <timestamp>', 'usage reset time as an ISO timestamp')
    .action(async (accountId: string, commandOptions) => {
      const remainingPercent = Number(commandOptions.remainingPercent);
      if (!Number.isFinite(remainingPercent) || remainingPercent < 0 || remainingPercent > 100) {
        throw new RelayError(
          'invalid_argument',
          '--remaining-percent must be a finite number from 0 through 100.',
        );
      }
      const resetsAt = normalizeIsoTimestamp(commandOptions.resetsAt as string | undefined);
      await core.recordUsage({
        accountId,
        period: 'weekly',
        model: commandOptions.model as string,
        remainingPercent,
        source: 'manual',
        ...(resetsAt === undefined ? {} : { resetsAt }),
      });
      io.write(`Recorded weekly usage for ${accountId}.\n`);
    });

  program
    .command('status')
    .description('Reconcile and show current WorkItem status')
    .option('--work-item <id>', 'WorkItem ID')
    .option('--json', 'print machine-readable JSON')
    .action(async (commandOptions: { workItem?: string; json?: boolean }) => {
      const status = await core.status(selector(io, commandOptions.workItem));
      if (commandOptions.json === true) return writeJson(io, status);
      writeStatus(io, status);
    });

  program
    .command('sessions')
    .description('List provider sessions for the current WorkItem')
    .option('--work-item <id>', 'WorkItem ID')
    .option('--json', 'print machine-readable JSON')
    .action(async (commandOptions: { workItem?: string; json?: boolean }) => {
      const sessions = await core.sessions(selector(io, commandOptions.workItem));
      if (commandOptions.json === true) return writeJson(io, sessions);
      for (const session of sessions) {
        io.write(`${titleCase(session.provider)}  ${session.status}\n`);
      }
    });

  program
    .command('land')
    .description('Stage or land a candidate on its WorkItem integration branch; never merges main')
    .argument('<run-id>', 'candidate run ID')
    .option('--json', 'print machine-readable JSON')
    .action(async (runId: string, commandOptions: { json?: boolean }) => {
      const result = await core.land(runId);
      if (commandOptions.json === true) return writeJson(io, result);
      io.write(`${result.runId} — ${result.status}\n`);
    });

  program
    .command('providers')
    .description('Show provider capabilities')
    .option('--json', 'print machine-readable JSON')
    .action(async ({ json }: { json?: boolean }) => {
      const capabilities = await core.providers();
      if (json === true) return writeJson(io, capabilities);
      for (const provider of PROVIDERS) {
        const supported = Object.entries(capabilities[provider])
          .filter(([, enabled]) => enabled)
          .map(([name]) => name)
          .join(', ');
        io.write(`${titleCase(provider)}  ${supported}\n`);
      }
    });

  program
    .command('reconcile')
    .description('Refresh GitHub artifact truth')
    .option('--work-item <id>', 'WorkItem ID')
    .option('--json', 'print machine-readable JSON')
    .action(async (commandOptions: { workItem?: string; json?: boolean }) => {
      const artifact = await core.reconcile(selector(io, commandOptions.workItem));
      if (commandOptions.json === true) return writeJson(io, artifact ?? null);
      io.write(
        artifact === undefined
          ? 'No published GitHub artifact yet.\n'
          : `GitHub ${artifact.branch} @ ${artifact.sha}\n`,
      );
    });

  program
    .command('chat')
    .description('Attach to a provider-native cloud session')
    .argument('<provider>', 'claude, codex, or jules')
    .option('--work-item <id>', 'WorkItem ID')
    .action(async (providerText: string, commandOptions: { workItem?: string }) => {
      await core.chat(
        providerName(providerText),
        selector(io, commandOptions.workItem),
      );
    });

  program
    .command('merge')
    .description('Verify and interactively merge the current pull request')
    .option('--work-item <id>', 'WorkItem ID')
    .addOption(
      new Option('--strategy <strategy>', 'GitHub merge strategy')
        .choices(['merge', 'rebase', 'squash'])
        .default('squash'),
    )
    .action(
      async (commandOptions: {
        workItem?: string;
        strategy: MergeStrategy;
      }) => {
        const selected = selector(io, commandOptions.workItem);
        const status = await core.status(selected);
        const artifact = status.artifact;
        if (artifact?.pullRequest === undefined) {
          throw new RelayError(
            'merge_not_ready',
            'The current WorkItem has no verified pull request.',
          );
        }
        io.write(
          [
            `PR #${artifact.pullRequest} — ${status.workItem.title}`,
            `HEAD ${artifact.sha}`,
            `Checks ${artifact.checks}`,
            `Review ${artifact.reviewDecision ?? 'unknown'}`,
            '',
          ].join('\n'),
        );
        const answer = await io.readLine(
          `Merge using ${commandOptions.strategy}? [y/N] `,
        );
        if (!isYes(answer)) {
          io.write('Merge cancelled.\n');
          return;
        }
        await core.merge({
          ...selected,
          strategy: commandOptions.strategy,
          approved: true,
        });
        io.write(`Merged PR #${artifact.pullRequest}.\n`);
      },
    );

  for (const provider of PROVIDERS) {
    program
      .command(provider)
      .description(`Send to ${titleCase(provider)} or start its current session`)
      .argument('<message>', 'message or task')
      .option('--new', 'force a new WorkItem')
      .addOption(modeOption('read'))
      .option('--json', 'print machine-readable JSON')
      .action(async (message: string, commandOptions) => {
        const result =
          commandOptions.new === true
            ? await core.delegate({
                provider,
                task: message,
                cwd: io.cwd(),
                mode: commandOptions.mode as MutationMode,
              })
            : await sendOrDelegate(
                core,
                provider,
                message,
                io.cwd(),
                commandOptions.mode as MutationMode,
              );
        writeResult(io, result, commandOptions.json === true);
      });
  }

  program
    .command('mcp')
    .description('Serve Relay over MCP STDIO')
    .action(async () => {
      if (options.serveMcp === undefined) {
        throw new RelayError(
          'capability_unavailable',
          'The MCP server is not available in this build.',
        );
      }
      await options.serveMcp();
    });

  return program;
}

export function formatCliError(error: unknown): string {
  if (error instanceof RelayError) {
    return `${error.code}: ${error.message}\n`;
  }
  if (error instanceof Error) return `unexpected_error: ${error.message}\n`;
  return `unexpected_error: ${JSON.stringify(redact(error))}\n`;
}

async function sendOrDelegate(
  core: RelayApi,
  provider: ProviderName,
  message: string,
  cwd: string,
  mode: MutationMode,
) {
  try {
    return await core.send({
      provider,
      message,
      workItemId: 'current',
      cwd,
      mode,
    });
  } catch (error) {
    if (!(error instanceof RelayError) || error.code !== 'not_found') throw error;
    return await core.delegate({ provider, task: message, cwd, mode });
  }
}

function selector(io: RelayIo, workItemId?: string) {
  return {
    cwd: io.cwd(),
    ...(workItemId === undefined ? {} : { workItemId }),
  };
}

function modeOption(defaultValue: MutationMode): Option {
  return new Option('--mode <mode>', 'read or write')
    .choices(['read', 'write'])
    .default(defaultValue);
}

function writeHealth(
  io: RelayIo,
  label: string,
  status: { authenticated: boolean; detail?: string },
): void {
  io.write(
    `${label.padEnd(10)} ${status.authenticated ? '✓' : '✗'}${
      status.detail === undefined ? '' : `  ${status.detail}`
    }\n`,
  );
}

function writeStatus(
  io: RelayIo,
  status: Awaited<ReturnType<RelayApi['status']>>,
): void {
  io.write(`WorkItem  ${status.workItem.title}\n`);
  io.write(`Branch    ${status.workItem.currentBranch ?? 'not published'}\n`);
  io.write(`Integration ${status.workItem.integrationBranch}\n`);
  io.write(`SHA       ${status.artifact?.sha ?? 'not published'}\n`);
  io.write(`PR        ${status.artifact?.pullRequest ?? 'none'}\n`);
  io.write(`Checks    ${status.artifact?.checks ?? 'unknown'}\n`);
  for (const session of status.sessions) {
    io.write(`${titleCase(session.provider).padEnd(10)} ${session.status}\n`);
  }
  for (const candidate of status.candidates ?? []) {
    io.write(`Candidate ${candidate.runId}  ${candidate.status}\n`);
  }
}

function writeResult(io: RelayIo, result: unknown, json: boolean): void {
  if (json) return writeJson(io, result);
  const safe = result as {
    workItem?: { title?: string };
    run?: { status?: string };
  };
  io.write(
    `${safe.workItem?.title ?? 'Work accepted'} — ${safe.run?.status ?? 'queued'}\n`,
  );
}

function writeJson(io: RelayIo, value: unknown): void {
  io.write(`${JSON.stringify(redact(value), null, 2)}\n`);
}

function providerName(value: string): ProviderName {
  if ((PROVIDERS as readonly string[]).includes(value)) {
    return value as ProviderName;
  }
  throw new RelayError(
    'invalid_argument',
    `Unknown provider ${value}. Expected claude, codex, or jules.`,
  );
}

function titleCase(value: string): string {
  return `${value[0]?.toUpperCase() ?? ''}${value.slice(1)}`;
}

function isYes(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === 'y' || value?.trim().toLowerCase() === 'yes';
}

function normalizeIsoTimestamp(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) {
    throw new RelayError('invalid_argument', '--resets-at must be a valid ISO timestamp.');
  }
  return timestamp.toISOString();
}

const PROVIDERS = ['claude', 'codex', 'jules'] as const;
