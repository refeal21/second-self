import { describe, expect, it, vi } from 'vitest';
import {
  CodexAppServerClient,
  type AppServerExit,
  type AppServerTransport,
  type JsonRpcMessage,
} from './app-server.js';
import { CodexImageTurnRunner } from './codex-image-turn.js';

const IMAGE_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';

class ImageTurnTransport implements AppServerTransport {
  readonly sent: JsonRpcMessage[] = [];
  imageGeneration: unknown = true;
  namespaceTools: unknown = true;
  webSearch: unknown = true;
  private lines = new Set<(line: string) => void>();
  private exits = new Set<(detail: AppServerExit) => void>();
  private turnStartHook: ((requestId: string | number) => void) | null = null;

  async start(): Promise<void> {}
  async send(line: string): Promise<void> {
    const request = JSON.parse(line) as JsonRpcMessage;
    this.sent.push(request);
    if (request.id === undefined || request.method === undefined) return;
    if (request.method === 'turn/start' && this.turnStartHook) {
      this.turnStartHook(request.id);
      return;
    }
    const result = request.method === 'initialize' ? {}
      : request.method === 'modelProvider/capabilities/read'
        ? { namespaceTools: this.namespaceTools, imageGeneration: this.imageGeneration, webSearch: this.webSearch }
        : request.method === 'thread/start'
          ? { thread: { id: 'thread-image' } }
          : request.method === 'turn/start'
            ? { turn: { id: 'turn-image' } }
            : {};
    queueMicrotask(() => this.emit({ id: request.id, result }));
  }
  onLine(listener: (line: string) => void): () => void {
    this.lines.add(listener);
    return () => { this.lines.delete(listener); };
  }
  onExit(listener: (detail: AppServerExit) => void): () => void {
    this.exits.add(listener);
    return () => { this.exits.delete(listener); };
  }
  emit(message: JsonRpcMessage): void {
    for (const listener of this.lines) listener(JSON.stringify(message));
  }
  crash(): void {
    for (const listener of this.exits) listener({ code: 70, signal: null });
  }
  beforeTurnStartResponse(hook: (requestId: string | number) => void): void {
    this.turnStartHook = hook;
  }
  respondToTurnStart(requestId: string | number): void {
    this.emit({ id: requestId, result: { turn: { id: 'turn-image' } } });
  }
  image(result = IMAGE_BASE64, overrides: Record<string, unknown> = {}): void {
    this.emit({ method: 'item/completed', params: {
      threadId: 'thread-image', turnId: 'turn-image', completedAtMs: 1,
      item: {
        type: 'imageGeneration', id: 'image-1', status: 'completed',
        revisedPrompt: null, result, failure: null, ...overrides,
      },
    } });
  }
  startImage(): void {
    this.emit({ method: 'item/started', params: {
      threadId: 'thread-image', turnId: 'turn-image',
      item: {
        type: 'imageGeneration', id: 'image-1', status: 'inProgress',
        revisedPrompt: null, result: '', failure: null,
      },
    } });
  }
  complete(overrides: Record<string, unknown> = {}): void {
    this.emit({ method: 'turn/completed', params: {
      threadId: 'thread-image',
      turn: { id: 'turn-image', status: 'completed', error: null, ...overrides },
    } });
  }
  get operationListenerCount(): number {
    // One line and one exit listener belong to the connected client itself.
    return this.lines.size + this.exits.size - 2;
  }
}

function setup(options: { timeoutMs?: number; maxImageBytes?: number } = {}) {
  const transport = new ImageTurnTransport();
  const client = new CodexAppServerClient(transport);
  const runner = new CodexImageTurnRunner(client, options);
  return { transport, runner };
}

async function started(transport: ImageTurnTransport, promise: Promise<unknown>): Promise<void> {
  void promise.catch(() => {});
  await vi.waitFor(() => expect(transport.sent.some(({ method }) => method === 'turn/start')).toBe(true));
}

describe('Codex native image turn', () => {
  it.each([false, null, 'yes'])('rejects unsupported or malformed capability %j before a thread starts', async (capability) => {
    const { transport, runner } = setup();
    transport.imageGeneration = capability;

    await expect(runner.generate({ cwd: '/project', prompt: 'native ImageGen only' }))
      .rejects.toThrow(/ImageGen capability/i);
    expect(transport.sent.some(({ method }) => method === 'thread/start')).toBe(false);
    expect(transport.operationListenerCount).toBe(0);
  });

  it('rejects an incomplete provider capability response before a thread starts', async () => {
    const { transport, runner } = setup({ timeoutMs: 10 });
    transport.namespaceTools = undefined;
    await expect(runner.generate({ cwd: '/project', prompt: 'native ImageGen only' }))
      .rejects.toThrow(/ImageGen capability/i);
    expect(transport.sent.some(({ method }) => method === 'thread/start')).toBe(false);
  });

  it('retains one matching image until the matching turn completes', async () => {
    const { transport, runner } = setup();
    const progress: string[] = [];
    const generated = runner.generate({ cwd: '/project', prompt: 'native ImageGen only', onProgress: (value) => progress.push(value) });
    await started(transport, generated);
    expect(progress.at(-1)).toMatch(/等待 Codex 调用图片生成工具/);
    transport.startImage();
    expect(progress.at(-1)).toMatch(/正在生成图片/);
    transport.image();
    await expect(Promise.race([generated.then(() => 'resolved'), Promise.resolve('pending')])).resolves.toBe('pending');
    transport.complete();

    await expect(generated).resolves.toEqual({ imageBase64: IMAGE_BASE64 });
    expect(progress.length).toBeGreaterThan(1);
    expect(transport.operationListenerCount).toBe(0);
  });

  it('buffers matching notifications emitted before the turn/start response', async () => {
    const { transport, runner } = setup();
    transport.beforeTurnStartResponse((requestId) => {
      transport.image();
      transport.complete();
      transport.respondToTurnStart(requestId);
    });

    await expect(runner.generate({ cwd: '/project', prompt: 'native ImageGen only' }))
      .resolves.toEqual({ imageBase64: IMAGE_BASE64 });
    expect(transport.operationListenerCount).toBe(0);
  });

  it('ignores image and completion events from other thread/turn identities', async () => {
    const { transport, runner } = setup();
    const generated = runner.generate({ cwd: '/project', prompt: 'native ImageGen only' });
    await started(transport, generated);
    transport.emit({ method: 'item/completed', params: {
      threadId: 'other-thread', turnId: 'turn-image', completedAtMs: 1,
      item: { type: 'imageGeneration', id: 'wrong', status: 'completed', revisedPrompt: null, result: 'd3Jvbmc=', failure: null },
    } });
    transport.emit({ method: 'turn/completed', params: {
      threadId: 'thread-image', turn: { id: 'other-turn', status: 'completed', error: null },
    } });
    transport.image();
    transport.complete();

    await expect(generated).resolves.toEqual({ imageBase64: IMAGE_BASE64 });
  });

  it('rejects quota exhaustion without returning its image payload', async () => {
    const { transport, runner } = setup();
    const generated = runner.generate({ cwd: '/project', prompt: 'native ImageGen only' });
    await started(transport, generated);
    transport.image('', { status: 'failed', failure: { type: 'usageLimitExceeded', limitId: 'images', resetsAt: 123 } });
    transport.complete();

    await expect(generated).rejects.toThrow(/usage limit/i);
    expect(transport.operationListenerCount).toBe(0);
  });

  it('rejects a failed turn even after receiving an image', async () => {
    const { transport, runner } = setup();
    const generated = runner.generate({ cwd: '/project', prompt: 'native ImageGen only' });
    await started(transport, generated);
    transport.image();
    transport.complete({ status: 'failed', error: { message: 'provider failed' } });

    await expect(generated).rejects.toThrow('provider failed');
  });

  it.each([
    ['without an image', (transport: ImageTurnTransport) => transport.complete(), /did not return an image/i],
    ['with multiple images', (transport: ImageTurnTransport) => { transport.image(); transport.image('YW5vdGhlcg==', { id: 'image-2' }); transport.complete(); }, /multiple images/i],
    ['with malformed base64', (transport: ImageTurnTransport) => { transport.image('not base64!?'); transport.complete(); }, /base64/i],
  ])('rejects completion %s', async (_name, emit, message) => {
    const { transport, runner } = setup();
    const generated = runner.generate({ cwd: '/project', prompt: 'native ImageGen only' });
    await started(transport, generated);
    emit(transport);
    await expect(generated).rejects.toThrow(message);
    expect(transport.operationListenerCount).toBe(0);
  });

  it('rejects an oversized base64 result before returning a candidate', async () => {
    const { transport, runner } = setup({ maxImageBytes: 3 });
    const generated = runner.generate({ cwd: '/project', prompt: 'native ImageGen only' });
    await started(transport, generated);
    transport.image('MTIzNA==');
    transport.complete();
    await expect(generated).rejects.toThrow(/too large/i);
  });

  it('rejects an oversized malformed payload by length before base64 scanning', async () => {
    const { transport, runner } = setup({ maxImageBytes: 3 });
    const generated = runner.generate({ cwd: '/project', prompt: 'native ImageGen only' });
    await started(transport, generated);
    transport.image('!!!!!!!!!!!!!!!!');
    transport.complete();
    await expect(generated).rejects.toThrow(/too large/i);
  });

  it('validates a normal multi-megabyte base64 payload without regex stack growth', async () => {
    const imageBase64 = 'A'.repeat(4 * 1024 * 1024);
    const { transport, runner } = setup({ maxImageBytes: 4 * 1024 * 1024 });
    const generated = runner.generate({ cwd: '/project', prompt: 'native ImageGen only' });
    await started(transport, generated);
    transport.image(imageBase64);
    transport.complete();
    await expect(generated).resolves.toEqual({ imageBase64 });
  });

  it('rejects an app-server exit and cleans operation listeners', async () => {
    const { transport, runner } = setup();
    const generated = runner.generate({ cwd: '/project', prompt: 'native ImageGen only' });
    await started(transport, generated);
    transport.crash();
    await expect(generated).rejects.toThrow(/exited/i);
    expect(transport.operationListenerCount).toBe(0);
  });

  it('bounds the whole operation and best-effort interrupts a started turn', async () => {
    const { transport, runner } = setup({ timeoutMs: 10 });
    const generated = runner.generate({ cwd: '/project', prompt: 'native ImageGen only' });
    await started(transport, generated);
    await expect(generated).rejects.toThrow(/timed out/i);
    await vi.waitFor(() => expect(transport.sent.some(({ method }) => method === 'turn/interrupt')).toBe(true));
    expect(transport.operationListenerCount).toBe(0);
  });

  it('interrupts a turn whose start response arrives after the total deadline', async () => {
    const { transport, runner } = setup({ timeoutMs: 10 });
    transport.beforeTurnStartResponse(() => {});
    const generated = runner.generate({ cwd: '/project', prompt: 'native ImageGen only' });
    await started(transport, generated);
    await expect(generated).rejects.toThrow(/timed out/i);
    const start = transport.sent.find(({ method }) => method === 'turn/start')!;
    transport.respondToTurnStart(start.id!);
    await vi.waitFor(() => expect(transport.sent.some(({ method }) => method === 'turn/interrupt')).toBe(true));
  });
});
