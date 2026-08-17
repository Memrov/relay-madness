#!/usr/bin/env node

import { createInterface } from 'node:readline/promises';

import {
  createCli,
  createRelayApplication,
  formatCliError,
  type RelayIo,
} from './app.js';
import { serveRelayMcp } from './mcp.js';

const application = createRelayApplication();
const io = nodeIo();

try {
  await createCli(application.core, io, {
    serveMcp: async () => await serveRelayMcp(application.core),
  }).parseAsync(process.argv);
} catch (error) {
  io.writeError(formatCliError(error));
  process.exitCode = 1;
} finally {
  io.close();
  application.close();
}

function nodeIo(): RelayIo {
  let readline: ReturnType<typeof createInterface> | undefined;
  return {
    cwd: () => process.cwd(),
    write: (text) => process.stdout.write(text),
    writeError: (text) => process.stderr.write(text),
    readLine: async (prompt) => {
      readline ??= createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      return await readline.question(prompt);
    },
    close: () => readline?.close(),
  };
}
