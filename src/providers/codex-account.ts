import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as z from 'zod/v4';

import { RelayError } from '../errors.js';

export const CODEX_PROFILE_CREDENTIAL_OVERRIDES = [
  'OPENAI_API_KEY',
  'CODEX_ACCESS_TOKEN',
] as const;

const accountResponseSchema = z.object({
  id: z.literal(1),
  result: z.object({
    account: z.object({
      type: z.literal('chatgpt'),
      email: z.string().nullable(),
      planType: z.string().nullable().optional(),
    }),
    requiresOpenaiAuth: z.literal(true),
  }),
});

interface CodexAccountProbeOptions {
  env?: NodeJS.ProcessEnv;
  statePath?: string;
  timeoutMs?: number;
}

let identityProbeTail = Promise.resolve();

export function codexProfileConfigArgs(
  profilePath: string | undefined,
  sqlitePath = profilePath,
): readonly string[] {
  if (profilePath === undefined || sqlitePath === undefined) return [];
  return [
    '-c',
    'cli_auth_credentials_store="file"',
    '-c',
    'forced_login_method="chatgpt"',
    '-c',
    `sqlite_home=${JSON.stringify(sqlitePath)}`,
  ];
}

export async function readCodexProfileIdentity(
  profilePath: string,
  options: CodexAccountProbeOptions = {},
): Promise<string> {
  return await serializeIdentityProbe(async () => {
    const ephemeral = options.statePath === undefined;
    const scratchPath =
      options.statePath ??
      (await mkdtemp(join(tmpdir(), 'relay-codex-identity-')));
    try {
      if (!ephemeral) await mkdir(scratchPath, { recursive: true, mode: 0o700 });
      return await runAccountProbe(profilePath, scratchPath, options);
    } finally {
      if (ephemeral) await rm(scratchPath, { recursive: true, force: true });
    }
  });
}

async function serializeIdentityProbe<T>(operation: () => Promise<T>): Promise<T> {
  const predecessor = identityProbeTail;
  let release!: () => void;
  identityProbeTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await predecessor;
  try {
    return await operation();
  } finally {
    release();
  }
}

async function runAccountProbe(
  profilePath: string,
  scratchPath: string,
  options: CodexAccountProbeOptions,
): Promise<string> {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    ...options.env,
    CODEX_HOME: profilePath,
    CODEX_SQLITE_HOME: scratchPath,
  };
  for (const name of CODEX_PROFILE_CREDENTIAL_OVERRIDES) delete environment[name];

  return await new Promise<string>((resolve, reject) => {
    const child = spawn(
      'codex',
      [
        'app-server',
        '--stdio',
        '--disable',
        'plugins',
        ...codexProfileConfigArgs(profilePath, scratchPath),
      ],
      {
        env: environment,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    const timeoutMs = options.timeoutMs ?? 30_000;
    let stdout = '';
    let outputBytes = 0;
    let result: string | undefined;
    let failure: RelayError | undefined;
    let initialized = false;
    let forceKillTimer: NodeJS.Timeout | undefined;

    const stop = () => {
      if (
        child.exitCode !== null ||
        child.signalCode !== null ||
        forceKillTimer !== undefined
      ) {
        return;
      }
      child.kill('SIGTERM');
      forceKillTimer = setTimeout(() => child.kill('SIGKILL'), 250);
      forceKillTimer.unref();
    };
    const fail = (error: RelayError) => {
      if (failure !== undefined || result !== undefined) return;
      failure = error;
      stop();
    };
    const write = (message: unknown) => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    const handleLine = (line: string) => {
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        fail(invalidAccountResponse());
        return;
      }
      if (!isRecord(message) || typeof message.id !== 'number') return;
      if (message.id === 0) {
        if ('error' in message || initialized) {
          fail(invalidAccountResponse());
          return;
        }
        initialized = true;
        write({ method: 'initialized' });
        write({
          method: 'account/read',
          id: 1,
          params: { refreshToken: false },
        });
        return;
      }
      if (message.id !== 1) return;
      const parsed = accountResponseSchema.safeParse(message);
      const email = parsed.success
        ? parsed.data.result.account.email?.trim().toLowerCase()
        : undefined;
      if (email === undefined || email === '') {
        fail(invalidAccountResponse());
        return;
      }
      result = createHash('sha256').update(email).digest('hex');
      stop();
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > 1_048_576) {
        fail(invalidAccountResponse());
        return;
      }
      stdout += chunk;
      let newline = stdout.indexOf('\n');
      while (newline >= 0) {
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        if (line !== '') handleLine(line);
        newline = stdout.indexOf('\n');
      }
    });
    child.stderr.resume();
    child.stdin.on('error', (cause) => {
      fail(
        new RelayError(
          'process_failed',
          'Codex account identity probe closed its input unexpectedly.',
          { command: 'codex' },
          { cause },
        ),
      );
    });

    const timeout = setTimeout(() => {
      failure = new RelayError(
        'process_timeout',
        'Codex account identity probe exceeded its execution deadline.',
        { command: 'codex', timeoutMs },
      );
      stop();
    }, timeoutMs);
    timeout.unref();

    write({
      method: 'initialize',
      id: 0,
      params: {
        clientInfo: {
          name: 'relay_cluster',
          title: 'Relay Cluster',
          version: '0.1.0',
        },
      },
    });

    child.once('error', (cause) => {
      clearTimeout(timeout);
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
      reject(
        new RelayError(
          (cause as NodeJS.ErrnoException).code === 'ENOENT'
            ? 'command_not_found'
            : 'process_failed',
          'Unable to start the Codex account identity probe.',
          { command: 'codex' },
          { cause },
        ),
      );
    });
    child.once('close', () => {
      clearTimeout(timeout);
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
      if (result !== undefined) {
        resolve(result);
        return;
      }
      reject(failure ?? invalidAccountResponse());
    });
  });
}

function invalidAccountResponse(): RelayError {
  return new RelayError(
    'provider_output_invalid',
    'Codex app-server did not report a verifiable ChatGPT account identity.',
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
