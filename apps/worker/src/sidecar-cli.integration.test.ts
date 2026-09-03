import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const children: ChildProcessWithoutNullStreams[] = [];

afterEach(async () => {
  await Promise.all(
    children.splice(0).map(async (child) => {
      if (child.exitCode === null) child.kill('SIGKILL');
      if (child.exitCode === null) await once(child, 'exit');
    }),
  );
});

function startWorker(testMode = false) {
  const cli = fileURLToPath(new URL('./sidecar-cli.ts', import.meta.url));
  const child = spawn(process.execPath, ['--import', 'tsx', cli], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ...(testMode ? { DIGITAL_TWIN_SIDECAR_TEST_MODE: '1' } : {}),
    },
  });
  children.push(child);
  const lines = createInterface({ input: child.stdout });
  const iterator = lines[Symbol.asyncIterator]();
  return {
    child,
    async request(value: string) {
      child.stdin.write(`${value}\n`);
      const next = await iterator.next();
      if (next.done) throw new Error('worker stdout closed');
      return JSON.parse(next.value) as Record<string, unknown>;
    },
  };
}

describe('worker sidecar process integration', () => {
  it('survives malformed and unknown requests before serving a valid request', async () => {
    const worker = startWorker();
    expect(await worker.request('{bad')).toMatchObject({
      error: { code: -32700 },
    });
    expect(
      await worker.request(
        JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'unknown' }),
      ),
    ).toMatchObject({ error: { code: -32601 } });
    expect(
      await worker.request(
        JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'system.health' }),
      ),
    ).toMatchObject({ result: { status: 'ready' } });
  });

  it('can be restarted after a controlled crash', async () => {
    const first = startWorker(true);
    first.child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'test.crash' })}\n`,
    );
    const [code] = (await once(first.child, 'exit')) as [number];
    expect(code).toBe(86);

    const restarted = startWorker();
    expect(
      await restarted.request(
        JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'system.health' }),
      ),
    ).toMatchObject({ result: { status: 'ready' } });
  });
});
