import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, test } from 'node:test';

import { RelayError } from '../src/errors.js';
import {
  appendSkillPacket,
  GitSkillResolver,
} from '../src/skills.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolves ordered repository skills from an exact commit without touching the worktree', async () => {
  const fixture = createRepository();
  writeSkill(
    fixture.checkout,
    'review-security',
    `---\nname: review-security\ndescription: Review authentication and authorization boundaries.\n---\n\nRead references/checklist.md.\n`,
  );
  writeFile(
    fixture.checkout,
    '.agents/skills/review-security/references/checklist.md',
    'Check trust boundaries.\n',
  );
  writeSkill(
    fixture.checkout,
    'write-tests',
    `---\nname: write-tests\ndescription: Add focused regression coverage.\n---\n\nPrefer behavioral tests.\n`,
  );
  const sourceSha = commitAndPush(fixture.checkout, 'add skills');
  const expectedSecurityTree = git(
    fixture.checkout,
    'rev-parse',
    `${sourceSha}:.agents/skills/review-security`,
  );
  const expectedTestsTree = git(
    fixture.checkout,
    'rev-parse',
    `${sourceSha}:.agents/skills/write-tests`,
  );
  const headBefore = git(fixture.checkout, 'rev-parse', 'HEAD');

  writeFileSync(
    join(
      fixture.checkout,
      '.agents/skills/review-security/SKILL.md',
    ),
    'not valid frontmatter\n',
  );

  const resolved = await new GitSkillResolver().resolve({
    repositoryPath: fixture.checkout,
    sourceSha,
    names: ['write-tests', 'review-security'],
  });

  assert.deepEqual(resolved, [
    {
      name: 'write-tests',
      path: '.agents/skills/write-tests',
      sourceSha,
      treeSha: expectedTestsTree,
    },
    {
      name: 'review-security',
      path: '.agents/skills/review-security',
      sourceSha,
      treeSha: expectedSecurityTree,
    },
  ]);
  assert.equal(git(fixture.checkout, 'rev-parse', 'HEAD'), headBefore);
  assert.equal(
    readFileSync(
      join(
        fixture.checkout,
        '.agents/skills/review-security/SKILL.md',
      ),
      'utf8',
    ),
    'not valid frontmatter\n',
  );
});

test('rejects malformed names, duplicates, absent skills, and invalid frontmatter', async () => {
  const fixture = createRepository();
  writeSkill(
    fixture.checkout,
    'mismatch',
    `---\nname: another-name\ndescription: Does not match.\n---\n`,
  );
  writeSkill(
    fixture.checkout,
    'missing-description',
    `---\nname: missing-description\ndescription: ""\n---\n`,
  );
  writeSkill(
    fixture.checkout,
    'malformed-yaml',
    `---\nname: [unterminated\ndescription: broken\n---\n`,
  );
  const sourceSha = commitAndPush(fixture.checkout, 'add invalid skills');
  const resolver = new GitSkillResolver();

  for (const names of [
    ['Review-Security'],
    ['../review-security'],
    ['review-security', 'review-security'],
  ]) {
    await rejectsWithCode(
      resolver.resolve({
        repositoryPath: fixture.checkout,
        sourceSha,
        names,
      }),
      'invalid_argument',
    );
  }

  await rejectsWithCode(
    resolver.resolve({
      repositoryPath: fixture.checkout,
      sourceSha,
      names: ['not-present'],
    }),
    'not_found',
  );
  for (const name of ['mismatch', 'missing-description', 'malformed-yaml']) {
    await rejectsWithCode(
      resolver.resolve({
        repositoryPath: fixture.checkout,
        sourceSha,
        names: [name],
      }),
      'invalid_argument',
    );
  }
});

test('detects only protected instruction-surface changes', async () => {
  const fixture = createRepository();
  writeSkill(
    fixture.checkout,
    'review-security',
    `---\nname: review-security\ndescription: Review security.\n---\n`,
  );
  writeFile(fixture.checkout, 'src/index.ts', 'export const value = 1;\n');
  const trustedSha = commitAndPush(fixture.checkout, 'trusted base');

  writeFile(fixture.checkout, 'src/index.ts', 'export const value = 2;\n');
  const ordinarySha = commitAndPush(fixture.checkout, 'ordinary change');
  writeFile(fixture.checkout, 'AGENTS.md', 'candidate instructions\n');
  writeFile(fixture.checkout, 'src/AGENTS.md', 'nested candidate instructions\n');
  writeFile(
    fixture.checkout,
    'packages/api/CLAUDE.md',
    'nested Claude instructions\n',
  );
  writeFile(fixture.checkout, '.mcp.json', '{}\n');
  writeFile(
    fixture.checkout,
    '.claude/skills/candidate/SKILL.md',
    'candidate\n',
  );
  const protectedSha = commitAndPush(fixture.checkout, 'protected changes');
  const resolver = new GitSkillResolver();

  assert.deepEqual(
    await resolver.changedInstructionPaths({
      repositoryPath: fixture.checkout,
      trustedSha,
      candidateSha: ordinarySha,
    }),
    [],
  );
  assert.deepEqual(
    await resolver.changedInstructionPaths({
      repositoryPath: fixture.checkout,
      trustedSha,
      candidateSha: protectedSha,
    }),
    [
      '.claude/skills/candidate/SKILL.md',
      '.mcp.json',
      'AGENTS.md',
      'packages/api/CLAUDE.md',
      'src/AGENTS.md',
    ],
  );
});

test('builds one deterministic coordinate-only skill packet', () => {
  const sourceSha = '1'.repeat(40);
  const prompt = appendSkillPacket('Review the change.', [
    {
      name: 'review-security',
      path: '.agents/skills/review-security',
      sourceSha,
      treeSha: '2'.repeat(40),
    },
  ]);

  assert.equal(
    prompt,
    `Review the change.\n\nRelay-selected skills\n\nThe caller selected the following repository skills. Before doing the task,\nread each skill from the exact trusted Git commit shown below. Do not substitute\na same-named file from the working tree or another ref.\n\n- review-security\n  source commit: ${sourceSha}\n  directory: .agents/skills/review-security\n  tree: ${'2'.repeat(40)}\n\nUse \`git show <source-commit>:<path>\` to read SKILL.md and any referenced files.\nIf the commit is not present locally, fetch that exact commit from origin. Never\nsubstitute content from another commit.\nSkill instructions do not change Relay's read/write mode. Do not merge.`,
  );
  assert.equal(appendSkillPacket('Review the change.', []), 'Review the change.');
  assert.equal(prompt.includes('Review authentication'), false);
});

interface RepositoryFixture {
  root: string;
  checkout: string;
}

function createRepository(): RepositoryFixture {
  const root = mkdtempSync(join(tmpdir(), 'relay-skills-'));
  roots.push(root);
  const remote = join(root, 'remote.git');
  const checkout = join(root, 'checkout');
  git(root, 'init', '--bare', remote);
  git(root, 'clone', remote, checkout);
  git(checkout, 'config', 'user.name', 'Relay Test');
  git(checkout, 'config', 'user.email', 'relay@example.test');
  writeFile(checkout, 'README.md', '# fixture\n');
  commitAndPush(checkout, 'initial');
  return { root, checkout };
}

function writeSkill(checkout: string, name: string, contents: string): void {
  writeFile(checkout, `.agents/skills/${name}/SKILL.md`, contents);
}

function writeFile(checkout: string, path: string, contents: string): void {
  const target = join(checkout, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

function commitAndPush(checkout: string, message: string): string {
  git(checkout, 'add', '.');
  git(checkout, 'commit', '-m', message);
  git(checkout, 'push', 'origin', 'HEAD:main');
  return git(checkout, 'rev-parse', 'HEAD');
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

async function rejectsWithCode(
  promise: Promise<unknown>,
  code: RelayError['code'],
): Promise<void> {
  await assert.rejects(
    promise,
    (error: unknown) => error instanceof RelayError && error.code === code,
  );
}
