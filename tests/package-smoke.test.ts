import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, test } from 'node:test';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test('packed package exposes a runnable relay binary without source files', () => {
  const root = mkdtempSync(join(process.cwd(), '.package-smoke-'));
  roots.push(root);
  const packed = run('npm', [
    'pack',
    '--json',
    '--ignore-scripts',
    '--pack-destination',
    root,
  ]);
  const report = JSON.parse(packed.stdout) as Array<{ filename: string }>;
  const tarball = join(root, report[0]?.filename ?? 'missing.tgz');
  const listing = run('tar', ['-tf', tarball]).stdout.trim().split('\n');

  assert.ok(listing.includes('package/dist/cli.js'));
  assert.ok(!listing.some((path) => path.startsWith('package/src/')));
  assert.ok(!listing.some((path) => path.startsWith('package/tests/')));

  run('tar', ['-xzf', tarball, '-C', root]);
  const help = run(
    process.execPath,
    [join(root, 'package', 'dist', 'cli.js'), '--help'],
    { XDG_STATE_HOME: join(root, 'state') },
  );
  assert.match(help.stdout, /delegate \[options\] <provider> <task>/);
  assert.match(help.stdout, /mcp\s+Serve Relay over MCP STDIO/);
});

function run(
  command: string,
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
) {
  const childEnvironment = { ...process.env, ...env };
  delete childEnvironment.npm_config_dry_run;
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: childEnvironment,
    encoding: 'utf8',
  });
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(' ')} failed:\n${result.stderr}`,
  );
  return result;
}
