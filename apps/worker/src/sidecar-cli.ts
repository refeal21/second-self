#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { handleWorkerRpcLine } from './sidecar-rpc.js';

async function main(): Promise<void> {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    const response = await handleWorkerRpcLine(line);
    if (response !== null) process.stdout.write(`${response}\n`);
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `Worker protocol loop failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
