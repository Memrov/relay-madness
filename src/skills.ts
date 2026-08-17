import { chmodSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseDocument } from 'yaml';

import { RelayError } from './errors.js';
import { ProcessRunner, type ProcessResult } from './process-runner.js';

const FULL_SHA = /^[0-9a-f]{40}$/i;
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SKILLS = 32;
const RESOLVED_SKILL_KEYS = ['name', 'path', 'sourceSha', 'treeSha'] as const;
const PROTECTED_PATHS = [
  'AGENTS.md',
  'CLAUDE.md',
  '.agents/skills',
  '.claude/skills',
  '.github/skills',
  '.openhands/microagents',
  '.mcp.json',
] as const;

export interface ResolvedSkill {
  name: string;
  path: string;
  sourceSha: string;
  treeSha: string;
}

export interface ResolveSkillsInput {
  repositoryPath: string;
  sourceSha: string;
  names: readonly string[];
}

export interface InstructionSurfaceInput {
  repositoryPath: string;
  trustedSha: string;
  candidateSha: string;
}

export interface SkillResolver {
  resolve(input: ResolveSkillsInput): Promise<readonly ResolvedSkill[]>;
  changedInstructionPaths(
    input: InstructionSurfaceInput,
  ): Promise<readonly string[]>;
}

export class GitSkillResolver implements SkillResolver {
  private readonly hooksPath: string;

  constructor(private readonly runner: ProcessRunner = new ProcessRunner()) {
    this.hooksPath = mkdtempSync(join(tmpdir(), 'relay-skill-hooks-'));
    chmodSync(this.hooksPath, 0o700);
  }

  async resolve(
    input: ResolveSkillsInput,
  ): Promise<readonly ResolvedSkill[]> {
    assertRepositoryPath(input.repositoryPath);
    assertFullSha(input.sourceSha, 'Skill source SHA');
    assertSkillNames(input.names);
    if (input.names.length === 0) return [];

    await this.fetchCommit(input.repositoryPath, input.sourceSha);
    await this.assertCommit(input.repositoryPath, input.sourceSha);

    const resolved: ResolvedSkill[] = [];
    for (const name of input.names) {
      const path = `.agents/skills/${name}`;
      let skillDocument: ProcessResult;
      let tree: ProcessResult;
      try {
        [skillDocument, tree] = await Promise.all([
          this.git(input.repositoryPath, 'show', `${input.sourceSha}:${path}/SKILL.md`),
          this.git(
            input.repositoryPath,
            'rev-parse',
            '--verify',
            `${input.sourceSha}:${path}`,
          ),
        ]);
      } catch (error) {
        if (isGitFailure(error)) {
          throw new RelayError(
            'not_found',
            `Skill ${name} was not found at source commit ${input.sourceSha}.`,
            { name, path, sourceSha: input.sourceSha },
          );
        }
        throw error;
      }

      validateSkillDocument(name, skillDocument.stdout);
      const treeSha = tree.stdout.trim();
      assertFullSha(treeSha, `Tree SHA for skill ${name}`);
      const type = await this.git(input.repositoryPath, 'cat-file', '-t', treeSha);
      if (type.stdout.trim() !== 'tree') {
        throw new RelayError(
          'provider_output_invalid',
          `Git object for skill ${name} is not a tree.`,
          { name, path, sourceSha: input.sourceSha },
        );
      }
      resolved.push({ name, path, sourceSha: input.sourceSha, treeSha });
    }
    return resolved;
  }

  async changedInstructionPaths(
    input: InstructionSurfaceInput,
  ): Promise<readonly string[]> {
    assertRepositoryPath(input.repositoryPath);
    assertFullSha(input.trustedSha, 'Trusted skill source SHA');
    assertFullSha(input.candidateSha, 'Candidate SHA');
    if (input.trustedSha === input.candidateSha) return [];

    await this.fetchCommit(input.repositoryPath, input.trustedSha);
    await this.fetchCommit(input.repositoryPath, input.candidateSha);
    await this.assertCommit(input.repositoryPath, input.trustedSha);
    await this.assertCommit(input.repositoryPath, input.candidateSha);
    const result = await this.git(
      input.repositoryPath,
      'diff',
      '--name-only',
      '-z',
      input.trustedSha,
      input.candidateSha,
      '--',
      ...PROTECTED_PATHS,
    );
    return [...new Set(result.stdout.split('\0').filter(Boolean))].sort();
  }

  private async fetchCommit(repositoryPath: string, sha: string): Promise<void> {
    try {
      await this.git(repositoryPath, 'fetch', '--no-tags', 'origin', sha);
    } catch (error) {
      if (isGitFailure(error)) {
        throw new RelayError(
          'not_found',
          `Git commit ${sha} could not be fetched from origin.`,
          { sourceSha: sha },
        );
      }
      throw error;
    }
  }

  private async assertCommit(repositoryPath: string, sha: string): Promise<void> {
    let result: ProcessResult;
    try {
      result = await this.git(repositoryPath, 'cat-file', '-t', sha);
    } catch (error) {
      if (isGitFailure(error)) {
        throw new RelayError('not_found', `Git commit ${sha} was not found.`, {
          sourceSha: sha,
        });
      }
      throw error;
    }
    if (result.stdout.trim() !== 'commit') {
      throw new RelayError(
        'invalid_argument',
        `Skill source ${sha} is not a Git commit.`,
        { sourceSha: sha },
      );
    }
  }

  private async git(
    cwd: string,
    ...args: readonly string[]
  ): Promise<ProcessResult> {
    return await this.runner.run(
      'git',
      ['-c', `core.hooksPath=${this.hooksPath}`, ...args],
      { cwd, timeoutMs: 120_000 },
    );
  }
}

export function appendSkillPacket(
  prompt: string,
  skills: readonly ResolvedSkill[],
): string {
  validateResolvedSkills(skills);
  if (skills.length === 0) return prompt;

  const coordinates = skills
    .map(
      (skill) =>
        `- ${skill.name}\n  source commit: ${skill.sourceSha}\n  directory: ${skill.path}\n  tree: ${skill.treeSha}`,
    )
    .join('\n\n');
  return `${prompt}\n\nRelay-selected skills\n\nThe caller selected the following repository skills. Before doing the task,\nread each skill from the exact trusted Git commit shown below. Do not substitute\na same-named file from the working tree or another ref.\n\n${coordinates}\n\nUse \`git show <source-commit>:<path>\` to read SKILL.md and any referenced files.\nIf the commit is not present locally, fetch that exact commit from origin. Never\nsubstitute content from another commit.\nSkill instructions do not change Relay's read/write mode. Do not merge.`;
}

export function parseResolvedSkills(value: string): readonly ResolvedSkill[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (cause) {
    throw new RelayError(
      'state_conflict',
      'Stored skill coordinates are not valid JSON.',
      undefined,
      { cause },
    );
  }
  if (!Array.isArray(parsed)) {
    throw new RelayError(
      'state_conflict',
      'Stored skill coordinates must be an array.',
    );
  }
  validateResolvedSkills(parsed);
  return parsed;
}

export function serializeResolvedSkills(
  skills: readonly ResolvedSkill[],
): string {
  validateResolvedSkills(skills);
  return JSON.stringify(
    skills.map(({ name, path, sourceSha, treeSha }) => ({
      name,
      path,
      sourceSha,
      treeSha,
    })),
  );
}

function validateSkillDocument(expectedName: string, source: string): void {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
  if (match === null) {
    throw new RelayError(
      'invalid_argument',
      `Skill ${expectedName} must begin with YAML frontmatter.`,
      { name: expectedName },
    );
  }

  let metadata: unknown;
  try {
    const document = parseDocument(match[1] ?? '', {
      schema: 'core',
      uniqueKeys: true,
    });
    if (document.errors.length > 0 || document.warnings.length > 0) {
      throw document.errors[0] ?? document.warnings[0];
    }
    metadata = document.toJS({ maxAliasCount: 0 });
  } catch (cause) {
    throw new RelayError(
      'invalid_argument',
      `Skill ${expectedName} has invalid YAML frontmatter.`,
      { name: expectedName },
      { cause },
    );
  }

  if (
    metadata === null ||
    typeof metadata !== 'object' ||
    Array.isArray(metadata)
  ) {
    throw new RelayError(
      'invalid_argument',
      `Skill ${expectedName} frontmatter must be a mapping.`,
      { name: expectedName },
    );
  }
  const values = metadata as Record<string, unknown>;
  if (values.name !== expectedName) {
    throw new RelayError(
      'invalid_argument',
      `Skill ${expectedName} frontmatter name must match its directory.`,
      { name: expectedName },
    );
  }
  if (
    typeof values.description !== 'string' ||
    values.description.trim() === ''
  ) {
    throw new RelayError(
      'invalid_argument',
      `Skill ${expectedName} requires a non-empty description.`,
      { name: expectedName },
    );
  }
}

function validateResolvedSkills(value: readonly unknown[]): asserts value is readonly ResolvedSkill[] {
  if (value.length > MAX_SKILLS) {
    throw new RelayError(
      'invalid_argument',
      `At most ${MAX_SKILLS} skills may be selected.`,
    );
  }
  const names = new Set<string>();
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throwInvalidCoordinates();
    }
    const candidate = entry as Record<string, unknown>;
    const keys = Object.keys(candidate).sort();
    if (
      keys.length !== RESOLVED_SKILL_KEYS.length ||
      !RESOLVED_SKILL_KEYS.every((key) => keys.includes(key))
    ) {
      throwInvalidCoordinates();
    }
    if (
      typeof candidate.name !== 'string' ||
      !SKILL_NAME.test(candidate.name) ||
      typeof candidate.path !== 'string' ||
      candidate.path !== `.agents/skills/${candidate.name}` ||
      typeof candidate.sourceSha !== 'string' ||
      !FULL_SHA.test(candidate.sourceSha) ||
      typeof candidate.treeSha !== 'string' ||
      !FULL_SHA.test(candidate.treeSha) ||
      names.has(candidate.name)
    ) {
      throwInvalidCoordinates();
    }
    names.add(candidate.name);
  }
}

function assertSkillNames(names: readonly string[]): void {
  if (names.length > MAX_SKILLS) {
    throw new RelayError(
      'invalid_argument',
      `At most ${MAX_SKILLS} skills may be selected.`,
    );
  }
  const seen = new Set<string>();
  for (const name of names) {
    if (!SKILL_NAME.test(name)) {
      throw new RelayError(
        'invalid_argument',
        `Invalid skill name ${JSON.stringify(name)}. Use lowercase kebab-case.`,
      );
    }
    if (seen.has(name)) {
      throw new RelayError(
        'invalid_argument',
        `Skill ${name} was selected more than once.`,
      );
    }
    seen.add(name);
  }
}

function assertRepositoryPath(path: string): void {
  if (path.trim() === '') {
    throw new RelayError('invalid_argument', 'Repository path is required.');
  }
}

function assertFullSha(value: string, label: string): void {
  if (!FULL_SHA.test(value)) {
    throw new RelayError(
      'invalid_argument',
      `${label} must contain exactly 40 hexadecimal characters.`,
    );
  }
}

function throwInvalidCoordinates(): never {
  throw new RelayError(
    'state_conflict',
    'Stored skill coordinates are invalid.',
  );
}

function isGitFailure(error: unknown): error is RelayError {
  return error instanceof RelayError && error.code === 'process_failed';
}
