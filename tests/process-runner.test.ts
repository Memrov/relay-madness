import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RelayError, redact } from '../src/errors.js';
import { ProcessRunner } from '../src/process-runner.js';

test('runs a command without a shell and preserves separate streams', async () => {
  const result = await new ProcessRunner().run(process.execPath, [
    '-e',
    "process.stdout.write('out'); process.stderr.write('err')",
  ]);

  assert.deepEqual(result, {
    command: process.execPath,
    exitCode: 0,
    stdout: 'out',
    stderr: 'err',
  });
});

test('passes shell metacharacters as literal arguments', async () => {
  const marker = '$(printf unsafe);`printf unsafe`';
  const result = await new ProcessRunner().run(process.execPath, [
    '-e',
    'process.stdout.write(process.argv[1])',
    marker,
  ]);

  assert.equal(result.stdout, marker);
});

test('removes explicitly scrubbed variables from the child environment', async () => {
  const result = await new ProcessRunner().run(
    process.execPath,
    [
      '-e',
      "process.stdout.write(Object.hasOwn(process.env, 'RELAY_TEST_SCRUB') ? 'present' : 'absent')",
    ],
    {
      env: { RELAY_TEST_SCRUB: 'wrong-account' },
      unsetEnv: ['RELAY_TEST_SCRUB'],
    },
  );

  assert.equal(result.stdout, 'absent');
});

test('captures a pseudo-terminal command without evaluating literal arguments', async () => {
  const marker = '$(printf unsafe);`printf unsafe`;single\'quote';
  const result = await new ProcessRunner().run(
    process.execPath,
    [
      '-e',
      'process.stdout.write(`${String(process.stdout.isTTY)}:${process.argv[1]}`)',
      marker,
    ],
    { pty: true },
  );

  assert.equal(result.stdout.trim(), `true:${marker}`);
});

test('kills a command after its deadline', async () => {
  await assert.rejects(
    new ProcessRunner().run(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      { timeoutMs: 25 },
    ),
    (error: unknown) =>
      error instanceof RelayError && error.code === 'process_timeout',
  );
});

test('reports nonzero exits with redacted diagnostics', async () => {
  await assert.rejects(
    new ProcessRunner().run(process.execPath, [
      '-e',
      "process.stderr.write('failed'); process.exit(7)",
    ]),
    (error: unknown) =>
      error instanceof RelayError &&
      error.code === 'process_failed' &&
      error.details?.exitCode === 7 &&
      error.details?.stderr === 'failed',
  );
});

test('redacts nested credential-shaped values without changing safe values', () => {
  assert.deepEqual(
    redact({
      token: 'abc',
      nested: { apiKey: 'def', safe: 'yes' },
      Authorization: 'Bearer xyz',
      list: [{ password: 'hidden' }, 'public'],
    }),
    {
      token: '[REDACTED]',
      nested: { apiKey: '[REDACTED]', safe: 'yes' },
      Authorization: '[REDACTED]',
      list: [{ password: '[REDACTED]' }, 'public'],
    },
  );
});
