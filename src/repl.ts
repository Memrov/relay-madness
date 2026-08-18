import { RelayError } from './errors.js';
import type { MergeStrategy } from './github-client.js';
import {
  SUPPORTED_PROVIDERS,
  type MutationMode,
  type ProviderName,
} from './provider.js';
import type { RelayApi, RelayIo } from './app.js';
import {
  MAX_SELECTED_SKILLS,
  SKILL_NAME_PATTERN,
} from './skills.js';

const PROVIDERS = new Set<ProviderName>(SUPPORTED_PROVIDERS);

export async function runRepl(core: RelayApi, io: RelayIo): Promise<void> {
  let provider: ProviderName = 'claude';
  io.write('Relay Cluster — GitHub is artifact truth. Type /help for commands.\n');

  while (true) {
    const input = await io.readLine(`${provider}> `);
    if (input === undefined) return;
    const line = input.trim();
    if (line === '') continue;
    if (line === '/quit' || line === '/exit') return;

    try {
      if (line === '/help') {
        io.write(
          '/use PROVIDER · /new [PROVIDER] [--skill NAME ... --] TASK · /handoff PROVIDER [--skill NAME ... --] TASK · /status · /land RUN_ID · /reconcile · /chat · /merge · /quit\n',
        );
        continue;
      }
      if (line.startsWith('/use ')) {
        provider = parseProvider(line.slice('/use '.length).trim());
        io.write(`Provider → ${provider}\n`);
        continue;
      }
      if (line.startsWith('/new ')) {
        const parsed = providerSkillsAndText(
          line.slice('/new '.length),
          provider,
        );
        const result = await core.delegate({
          provider: parsed.provider,
          task: parsed.text,
          cwd: io.cwd(),
          mode: 'write',
          ...(parsed.skills === undefined ? {} : { skills: parsed.skills }),
        });
        writeRun(io, result);
        continue;
      }
      if (line.startsWith('/handoff ')) {
        const parsed = providerSkillsAndText(line.slice('/handoff '.length));
        const result = await core.handoff({
          provider: parsed.provider,
          instruction: parsed.text,
          workItemId: 'current',
          cwd: io.cwd(),
          ...(parsed.skills === undefined ? {} : { skills: parsed.skills }),
        });
        writeRun(io, result);
        continue;
      }
      if (line === '/status') {
        const status = await core.status(current(io));
        io.write(
          `${status.workItem.title} · ${status.workItem.integrationBranch} · ${status.artifact?.sha ?? 'not published'} · PR ${status.artifact?.pullRequest ?? 'none'} · ${status.artifact?.checks ?? 'unknown'} · ${status.candidates?.length ?? 0} candidates\n`,
        );
        continue;
      }
      if (line.startsWith('/land ')) {
        const runId = line.slice('/land '.length).trim();
        if (runId === '') {
          throw new RelayError('invalid_argument', 'A candidate run ID is required.');
        }
        const result = await core.land(runId);
        io.write(`${result.runId} · ${result.status}\n`);
        continue;
      }
      if (line === '/reconcile') {
        const artifact = await core.reconcile(current(io));
        io.write(
          artifact === undefined
            ? 'No published GitHub artifact yet.\n'
            : `${artifact.branch} @ ${artifact.sha}\n`,
        );
        continue;
      }
      if (line === '/chat' || line.startsWith('/chat ')) {
        const requested = line.slice('/chat'.length).trim();
        await core.chat(
          requested === '' ? provider : parseProvider(requested),
          current(io),
        );
        continue;
      }
      if (line === '/merge' || line.startsWith('/merge ')) {
        const strategy = parseStrategy(line.slice('/merge'.length).trim());
        await mergeInteractively(core, io, strategy);
        continue;
      }
      if (line.startsWith('/')) {
        throw new RelayError('invalid_argument', `Unknown command ${line}.`);
      }

      const result = await core.send({
        provider,
        message: line,
        ...current(io),
      });
      writeRun(io, result);
    } catch (error) {
      io.writeError(
        `${error instanceof RelayError ? error.code : 'unexpected_error'}: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
    }
  }
}

async function mergeInteractively(
  core: RelayApi,
  io: RelayIo,
  strategy: MergeStrategy,
): Promise<void> {
  const selected = current(io);
  const status = await core.status(selected);
  const artifact = status.artifact;
  if (artifact?.pullRequest === undefined) {
    throw new RelayError('merge_not_ready', 'No verified pull request exists.');
  }
  io.write(`PR #${artifact.pullRequest} · ${artifact.sha} · ${artifact.checks}\n`);
  const answer = await io.readLine(`Merge using ${strategy}? [y/N] `);
  const normalized = answer?.trim().toLowerCase();
  if (normalized !== 'y' && normalized !== 'yes') {
    io.write('Merge cancelled.\n');
    return;
  }
  await core.merge({
    ...selected,
    strategy,
    approved: true,
    pullRequest: artifact.pullRequest,
    expectedSha: artifact.sha,
  });
  io.write(`Merged PR #${artifact.pullRequest}.\n`);
}

function current(io: RelayIo) {
  return { workItemId: 'current', cwd: io.cwd() };
}

function providerAndText(
  input: string,
  fallback?: ProviderName,
): { provider: ProviderName; text: string } {
  const trimmed = input.trim();
  const [first = '', ...rest] = trimmed.split(/\s+/);
  if (PROVIDERS.has(first as ProviderName)) {
    const text = rest.join(' ');
    if (text === '') {
      throw new RelayError('invalid_argument', 'An instruction is required.');
    }
    return { provider: first as ProviderName, text };
  }
  if (fallback !== undefined && trimmed !== '') {
    return { provider: fallback, text: trimmed };
  }
  throw new RelayError(
    'invalid_argument',
    'A provider and instruction are required.',
  );
}

function providerSkillsAndText(
  input: string,
  fallback?: ProviderName,
): { provider: ProviderName; text: string; skills?: readonly string[] } {
  if (!input.split(/\s+/).includes('--skill')) {
    return providerAndText(input, fallback);
  }

  const tokens = input.trim().split(/\s+/);
  const first = tokens[0] ?? '';
  let provider: ProviderName;
  if (PROVIDERS.has(first as ProviderName)) {
    provider = first as ProviderName;
    tokens.shift();
  } else if (fallback !== undefined) {
    provider = fallback;
  } else {
    throw new RelayError(
      'invalid_argument',
      'A provider is required before skill options.',
    );
  }

  const delimiter = tokens.indexOf('--');
  if (delimiter === -1) {
    throw new RelayError(
      'invalid_argument',
      'Skill-bearing REPL commands require -- before the instruction.',
    );
  }
  const optionTokens = tokens.slice(0, delimiter);
  const text = tokens.slice(delimiter + 1).join(' ');
  if (text === '') {
    throw new RelayError('invalid_argument', 'An instruction is required.');
  }

  const skills: string[] = [];
  for (let index = 0; index < optionTokens.length; index += 2) {
    const flag = optionTokens[index];
    const name = optionTokens[index + 1];
    if (flag !== '--skill' || name === undefined) {
      throw new RelayError(
        'invalid_argument',
        'Only repeatable --skill NAME options are supported before --.',
      );
    }
    if (!SKILL_NAME_PATTERN.test(name)) {
      throw new RelayError(
        'invalid_argument',
        `Invalid skill name ${JSON.stringify(name)}. Use lowercase kebab-case.`,
      );
    }
    if (skills.includes(name)) {
      throw new RelayError(
        'invalid_argument',
        `Skill ${name} was selected more than once.`,
      );
    }
    if (skills.length >= MAX_SELECTED_SKILLS) {
      throw new RelayError(
        'invalid_argument',
        `At most ${MAX_SELECTED_SKILLS} skills may be selected.`,
      );
    }
    skills.push(name);
  }
  if (skills.length === 0) {
    throw new RelayError('invalid_argument', 'At least one skill is required.');
  }
  return { provider, text, skills };
}

function parseProvider(input: string): ProviderName {
  if (PROVIDERS.has(input as ProviderName)) return input as ProviderName;
  throw new RelayError('invalid_argument', `Unknown provider ${input}.`);
}

function parseStrategy(input: string): MergeStrategy {
  if (input === '') return 'squash';
  if (input === 'merge' || input === 'rebase' || input === 'squash') return input;
  throw new RelayError('invalid_argument', `Unknown merge strategy ${input}.`);
}

function writeRun(io: RelayIo, result: unknown): void {
  const run = result as { run?: { status?: string } };
  io.write(`✓ ${run.run?.status ?? 'accepted'}\n`);
}
