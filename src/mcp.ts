import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

import type { RelayApi } from './app.js';
import { RelayError, redact } from './errors.js';
import type { MutationMode, ProviderName } from './provider.js';

const providerSchema = z.enum(['claude', 'codex', 'jules']);
const modeSchema = z.enum(['read', 'write']);
const workItemSchema = z.string().min(1).default('current');
const outputSchema = z.object({
  workItem: z.string(),
  repo: z.string(),
  title: z.string(),
  provider: providerSchema.optional(),
  runId: z.string().optional(),
  correlationId: z.string().optional(),
  delegationDepth: z.number().int().min(0).max(2).optional(),
  status: z.string(),
  branch: z.string().optional(),
  sha: z.string().optional(),
  pullRequest: z.number().int().positive().optional(),
  checks: z.enum(['passing', 'failing', 'pending', 'unknown']).optional(),
  providers: z.partialRecord(providerSchema, z.string()).optional(),
});

export interface RelayMcpOptions {
  cwd?: string;
}

export function createRelayMcpServer(
  core: RelayApi,
  options: RelayMcpOptions = {},
): McpServer {
  const cwd = options.cwd ?? process.cwd();
  const server = new McpServer(
    { name: 'relay-madness', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    'relay_delegate',
    {
      title: 'Delegate cloud coding work',
      description:
        'Start provider-hosted work. Relay coordinates it and verifies durable output through GitHub.',
      inputSchema: z
        .object({
          provider: providerSchema,
          task: z.string().min(1),
          workItem: workItemSchema.optional(),
          title: z.string().min(1).optional(),
          mode: modeSchema.default('write'),
          parentRunId: z.string().min(1).optional(),
        })
        .strict(),
      outputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ provider, task, workItem, title, mode, parentRunId }) => {
      return await executeTool(async () => {
        const result = await delegateCurrentOrNew(core, {
          provider,
          task,
          mode,
          cwd,
          ...(workItem === undefined ? {} : { workItem }),
          ...(title === undefined ? {} : { title }),
          ...(parentRunId === undefined ? {} : { parentRunId }),
        });
        return publicRun(result);
      });
    },
  );

  server.registerTool(
    'relay_send',
    {
      title: 'Continue a provider session',
      description:
        'Send a follow-up to an existing usable provider session for one WorkItem.',
      inputSchema: z
        .object({
          provider: providerSchema,
          message: z.string().min(1),
          workItem: workItemSchema,
          mode: modeSchema.default('read'),
          parentRunId: z.string().min(1).optional(),
        })
        .strict(),
      outputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ provider, message, workItem, mode, parentRunId }) => {
      return await executeTool(async () => {
        const result = await core.send({
          provider,
          message,
          mode,
          ...selection(workItem, cwd),
          ...(parentRunId === undefined ? {} : { parentRunId }),
        });
        return publicRun(result);
      });
    },
  );

  server.registerTool(
    'relay_handoff',
    {
      title: 'Hand published work to another provider',
      description:
        'Pin current GitHub state and send a compact handoff packet to another provider.',
      inputSchema: z
        .object({
          provider: providerSchema,
          instruction: z.string().min(1),
          workItem: workItemSchema,
          mode: modeSchema.default('read'),
          parentRunId: z.string().min(1).optional(),
        })
        .strict(),
      outputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ provider, instruction, workItem, mode, parentRunId }) => {
      return await executeTool(async () => {
        const result = await core.handoff({
          provider,
          instruction,
          mode,
          ...selection(workItem, cwd),
          ...(parentRunId === undefined ? {} : { parentRunId }),
        });
        return publicRun(result);
      });
    },
  );

  server.registerTool(
    'relay_status',
    {
      title: 'Inspect reconciled Relay status',
      description:
        'Inspect provider coordination state and refresh authoritative GitHub artifact state.',
      inputSchema: z.object({ workItem: workItemSchema }).strict(),
      outputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ workItem }) => {
      return await executeTool(async () => {
        const status = await core.status(selection(workItem, cwd));
        return publicStatus(status);
      });
    },
  );

  return server;
}

export async function serveRelayMcp(
  core: RelayApi,
  options: RelayMcpOptions = {},
): Promise<void> {
  const handle = serveStdio(() => createRelayMcpServer(core, options), {
    onerror: (error) => process.stderr.write(`MCP error: ${error.message}\n`),
  });
  process.stderr.write('Relay Madness MCP ready on STDIO.\n');
  await waitForStdinEnd();
  await handle.close();
}

async function delegateCurrentOrNew(
  core: RelayApi,
  input: {
    provider: ProviderName;
    task: string;
    workItem?: string;
    title?: string;
    mode: MutationMode;
    parentRunId?: string;
    cwd: string;
  },
) {
  const base = {
    provider: input.provider,
    task: input.task,
    cwd: input.cwd,
    mode: input.mode,
    ...(input.title === undefined ? {} : { title: input.title }),
    ...(input.parentRunId === undefined
      ? {}
      : { parentRunId: input.parentRunId }),
  };
  if (input.workItem !== undefined && input.workItem !== 'current') {
    return await core.delegate({ ...base, workItemId: input.workItem });
  }
  if (input.workItem === 'current') {
    try {
      return await core.delegate({ ...base, workItemId: 'current' });
    } catch (error) {
      if (!(error instanceof RelayError) || error.code !== 'not_found') throw error;
    }
  }
  return await core.delegate(base);
}

function selection(workItem: string, cwd: string) {
  return { workItemId: workItem, cwd };
}

function publicRun(result: Awaited<ReturnType<RelayApi['delegate']>>) {
  return compact({
    workItem: result.workItem.id,
    repo: result.project.repo,
    title: result.workItem.title,
    provider: result.run.provider,
    runId: result.run.id,
    correlationId: result.run.correlationId,
    delegationDepth: result.run.delegationDepth,
    status: result.run.status,
    branch: result.artifact?.branch ?? result.workItem.currentBranch,
    sha: result.artifact?.sha,
    pullRequest: result.artifact?.pullRequest,
    checks: result.artifact?.checks,
  });
}

function publicStatus(status: Awaited<ReturnType<RelayApi['status']>>) {
  const providerStates: Partial<Record<ProviderName, string>> = {};
  for (const session of status.sessions) {
    const current = providerStates[session.provider];
    if (
      current === undefined ||
      sessionPriority(session.status) <= sessionPriority(current)
    ) {
      providerStates[session.provider] = session.status;
    }
  }
  return compact({
    workItem: status.workItem.id,
    repo: status.project.repo,
    title: status.workItem.title,
    status: status.workItem.status,
    branch: status.artifact?.branch ?? status.workItem.currentBranch,
    sha: status.artifact?.sha,
    pullRequest: status.artifact?.pullRequest,
    checks: status.artifact?.checks,
    providers: providerStates,
  });
}

function sessionPriority(status: string): number {
  if (status === 'active') return 0;
  if (status === 'pending') return 1;
  return 2;
}

function compact<T extends Readonly<Record<string, unknown>>>(value: T) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  );
}

function toolResult(output: Readonly<Record<string, unknown>>) {
  const safe = redact(output) as Readonly<Record<string, unknown>>;
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(safe) }],
    structuredContent: safe,
  };
}

async function executeTool(
  operation: () => Promise<Readonly<Record<string, unknown>>>,
) {
  try {
    return toolResult(await operation());
  } catch (error) {
    return toolError(error);
  }
}

function toolError(error: unknown) {
  const publicError =
    error instanceof RelayError
      ? compact({
          code: error.code,
          message: error.message,
          details: error.details,
        })
      : {
          code: 'unexpected_error',
          message: 'Relay operation failed.',
        };
  const safe = redact({ error: publicError });
  return {
    isError: true,
    content: [{ type: 'text' as const, text: JSON.stringify(safe) }],
  };
}

async function waitForStdinEnd(): Promise<void> {
  if (process.stdin.readableEnded || process.stdin.destroyed) return;
  await new Promise<void>((resolve) => {
    const done = () => resolve();
    process.stdin.once('end', done);
    process.stdin.once('close', done);
  });
}
