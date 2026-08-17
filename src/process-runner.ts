import { spawn } from 'node:child_process';

import { RelayError } from './errors.js';

export interface ProcessResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface InteractiveOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export class ProcessRunner {
  async run(
    command: string,
    args: readonly string[],
    options: RunOptions = {},
  ): Promise<ProcessResult> {
    if (options.timeoutMs !== undefined && options.timeoutMs <= 0) {
      throw new RelayError(
        'invalid_argument',
        'Process timeout must be greater than zero.',
      );
    }

    return await new Promise<ProcessResult>((resolve, reject) => {
      const child = spawn(command, [...args], {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;
      let forceKillTimer: NodeJS.Timeout | undefined;

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });

      const timeout =
        options.timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              timedOut = true;
              child.kill('SIGTERM');
              forceKillTimer = setTimeout(() => child.kill('SIGKILL'), 250);
              forceKillTimer.unref();
            }, options.timeoutMs);
      timeout?.unref();

      const clearTimers = () => {
        if (timeout !== undefined) {
          clearTimeout(timeout);
        }
        if (forceKillTimer !== undefined) {
          clearTimeout(forceKillTimer);
        }
      };

      child.once('error', (cause) => {
        if (settled) return;
        settled = true;
        clearTimers();
        reject(
          new RelayError(
            (cause as NodeJS.ErrnoException).code === 'ENOENT'
              ? 'command_not_found'
              : 'process_failed',
            `Unable to start ${command}.`,
            { command },
            { cause },
          ),
        );
      });

      child.once('close', (exitCode, signal) => {
        if (settled) return;
        settled = true;
        clearTimers();

        if (timedOut) {
          reject(
            new RelayError(
              'process_timeout',
              `${command} exceeded its execution deadline.`,
              { command, timeoutMs: options.timeoutMs },
            ),
          );
          return;
        }

        const code = exitCode ?? 1;
        if (code !== 0) {
          reject(
            new RelayError('process_failed', `${command} exited with ${code}.`, {
              command,
              exitCode: code,
              signal,
              stdout,
              stderr,
            }),
          );
          return;
        }

        resolve({ command, exitCode: code, stdout, stderr });
      });
    });
  }

  async spawnInteractive(
    command: string,
    args: readonly string[],
    options: InteractiveOptions = {},
  ): Promise<number> {
    return await new Promise<number>((resolve, reject) => {
      const child = spawn(command, [...args], {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        shell: false,
        stdio: 'inherit',
      });

      child.once('error', (cause) => {
        reject(
          new RelayError(
            (cause as NodeJS.ErrnoException).code === 'ENOENT'
              ? 'command_not_found'
              : 'process_failed',
            `Unable to start ${command}.`,
            { command },
            { cause },
          ),
        );
      });
      child.once('close', (exitCode) => resolve(exitCode ?? 1));
    });
  }
}
