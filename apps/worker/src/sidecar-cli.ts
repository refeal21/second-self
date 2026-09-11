#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { handleLegacyCopyValidatorLine } from './presales/legacy-copy.js';

async function main(): Promise<void> {
  if (process.argv.includes('--presales-validate')) {
    // A separate mode and handler: the legacy runtime module is not loaded.
    let pending = Buffer.alloc(0);
    for await (const chunk of process.stdin) {
      if (pending.length + (chunk as Uint8Array).byteLength > 9 * 1024 * 1024) throw new Error('Validation input exceeds limit');
      pending = Buffer.concat([pending, Buffer.from(chunk as Uint8Array)]);
      let newline: number;
      while ((newline = pending.indexOf(10)) !== -1) {
        const line = new TextDecoder('utf-8', { fatal: true }).decode(pending.subarray(0, newline));
        process.stdout.write(`${handleLegacyCopyValidatorLine(line)}\n`);
        pending = pending.subarray(newline + 1);
      }
    }
    if (pending.length !== 0) throw new Error('Validation request is incomplete');
    return;
  }
  const { handleWorkerRpcLine } = await import('./sidecar-rpc.js');
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
