import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = resolve(projectRoot, 'dist');
const compilerPath = resolve(
  projectRoot,
  'node_modules',
  'typescript',
  'bin',
  'tsc',
);

rmSync(outputPath, { recursive: true, force: true });

const result = spawnSync(
  process.execPath,
  [compilerPath, '-p', resolve(projectRoot, 'tsconfig.build.json')],
  { cwd: projectRoot, stdio: 'inherit' },
);

if (result.error !== undefined) throw result.error;
process.exitCode = result.status ?? 1;
