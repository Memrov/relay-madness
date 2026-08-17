import { RelayError } from './errors.js';

export interface HandoffPacketInput {
  repo: string;
  title: string;
  baseBranch: string;
  sourceBranch: string;
  sourceSha: string;
  pullRequest?: number;
  instruction: string;
  targetBranch?: string;
  expectedOutput?: string;
}

export function buildHandoffPacket(input: HandoffPacketInput): string {
  if (!/^[0-9a-f]{40}$/i.test(input.sourceSha)) {
    throw new RelayError(
      'invalid_argument',
      'A handoff requires a full 40-character source SHA.',
    );
  }

  const lines = [
    `Repository: ${input.repo}`,
    `Work item: ${input.title}`,
    `Base branch: ${input.baseBranch}`,
    `Source branch: ${input.sourceBranch}`,
    `Source commit: ${input.sourceSha}`,
  ];
  if (input.pullRequest !== undefined) {
    lines.push(`Pull request: #${input.pullRequest}`);
  }
  if (input.targetBranch !== undefined) {
    lines.push(`Target branch: ${input.targetBranch}`);
  }
  lines.push(
    `Instruction: ${input.instruction}`,
    `Expected output: ${input.expectedOutput ?? 'Inspect the pinned commit and report the result. Do not merge.'}`,
  );
  return lines.join('\n');
}

export function buildRecoveryPrompt(input: {
  repo: string;
  title: string;
  branch: string;
  instruction: string;
  sha?: string;
  pullRequest?: number;
}): string {
  const lines = [
    `Continue work on ${input.title}.`,
    `Repository: ${input.repo}`,
    `Current branch: ${input.branch}`,
  ];
  if (input.sha !== undefined) lines.push(`Current commit: ${input.sha}`);
  if (input.pullRequest !== undefined) {
    lines.push(`Pull request: #${input.pullRequest}`);
  }
  lines.push(
    'The previous provider session expired. Inspect the repository and pull request before continuing.',
    `New instruction: ${input.instruction}`,
  );
  return lines.join('\n');
}
