import { describe, expect, it } from 'vitest';
import {
  CodexAppServerClient,
  type AppServerExit,
  type AppServerTransport,
  type JsonRpcMessage,
} from './app-server.js';
import { GeneralTaskManager } from './general-tasks.js';

const initializeResponse = {
  userAgent: 'codex/0.151.0-alpha.7.2',
  codexHome: '/tmp/codex-home',
  platformFamily: 'unix',
  platformOs: 'macos',
};

class ScriptedAppServer implements AppServerTransport {
  readonly sent: JsonRpcMessage[] = [];
  starts = 0;
  private lineListener: ((line: string) => void) | undefined;
  private exitListener: ((detail: AppServerExit) => void) | undefined;

  async start(): Promise<void> {
    this.starts += 1;
  }

  async send(line: string): Promise<void> {
    const message = JSON.parse(line) as JsonRpcMessage;
    this.sent.push(message);
    if (message.id === undefined || message.method === undefined) return;

    const result = this.responseFor(message.method);
    queueMicrotask(() => this.lineListener?.(JSON.stringify({ id: message.id, result })));
  }

  onLine(listener: (line: string) => void): () => void {
    this.lineListener = listener;
    return () => { this.lineListener = undefined; };
  }

  onExit(listener: (detail: AppServerExit) => void): () => void {
    this.exitListener = listener;
    return () => { this.exitListener = undefined; };
  }

  emit(message: JsonRpcMessage): void {
    this.lineListener?.(JSON.stringify(message));
  }

  crash(): void {
    this.exitListener?.({ code: 70, signal: null });
  }

  private responseFor(method: string): unknown {
    switch (method) {
      case 'initialize': return initializeResponse;
      case 'thread/start': return { thread: { id: 'thread-1' } };
      case 'thread/resume': return { thread: { id: 'thread-1' } };
      case 'turn/start': return { turn: { id: 'turn-1' } };
      default: return {};
    }
  }
}

async function runningTask() {
  const transport = new ScriptedAppServer();
  const client = new CodexAppServerClient(transport);
  await client.connect();
  const manager = new GeneralTaskManager(client);
  await manager.startTask({
    id: 'task-1',
    cwd: '/workspace',
    prompt: 'Draft an outline.',
    createdAt: '2026-09-01T00:00:00.000Z',
  });
  return { transport, manager };
}

function emitApproval(transport: ScriptedAppServer, requestId = 'approval-1'): void {
  transport.emit({
    id: requestId,
    method: 'item/commandExecution/requestApproval',
    params: {
      kind: 'command',
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'item-1',
      startedAtMs: 1_788_220_800_000,
      environmentId: null,
      command: 'git status',
    },
  });
}

describe('general task transcript and lifecycle', () => {
  it('streams assistant deltas into one transcript item and completes the task', async () => {
    const { transport, manager } = await runningTask();

    transport.emit({
      method: 'item/agentMessage/delta',
      params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', delta: 'Hello ' },
    });
    transport.emit({
      method: 'item/agentMessage/delta',
      params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', delta: 'world.' },
    });
    transport.emit({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', error: null } },
    });

    expect(manager.getTask('task-1')).toMatchObject({
      threadId: 'thread-1',
      turnId: 'turn-1',
      status: 'completed',
      transcript: [
        { role: 'user', text: 'Draft an outline.' },
        { role: 'assistant', text: 'Hello world.' },
      ],
    });
  });

  it('interrupts the active turn when the task is cancelled', async () => {
    const { transport, manager } = await runningTask();

    await manager.cancelTask('task-1');

    expect(manager.getTask('task-1')?.status).toBe('cancelled');
    expect(transport.sent.at(-1)).toEqual({
      id: 4,
      method: 'turn/interrupt',
      params: { threadId: 'thread-1', turnId: 'turn-1' },
    });
  });

  it('surfaces command approval requests and sends the user decision', async () => {
    const { transport, manager } = await runningTask();
    emitApproval(transport);

    expect(manager.getTask('task-1')).toMatchObject({
      status: 'waiting_for_approval',
      pendingInteraction: {
        requestId: 'approval-1',
        kind: 'command_approval',
      },
    });

    await manager.respondToApproval('task-1', 'accept');
    expect(transport.sent.at(-1)).toEqual({
      id: 'approval-1',
      result: { decision: 'accept' },
    });
    expect(manager.getTask('task-1')?.status).toBe('running');
  });

  it('clears a pending interaction when the server resolves the matching request', async () => {
    const { transport, manager } = await runningTask();
    emitApproval(transport, 'approval-current');

    transport.emit({
      method: 'serverRequest/resolved',
      params: { threadId: 'thread-1', requestId: 'approval-current' },
    });

    expect(manager.getTask('task-1')).toMatchObject({
      status: 'running',
      pendingInteraction: null,
    });
  });

  it('does not clear a newer interaction when a stale request is resolved', async () => {
    const { transport, manager } = await runningTask();
    emitApproval(transport, 'approval-current');

    transport.emit({
      method: 'serverRequest/resolved',
      params: { threadId: 'thread-1', requestId: 'approval-old' },
    });

    expect(manager.getTask('task-1')).toMatchObject({
      status: 'waiting_for_approval',
      pendingInteraction: { requestId: 'approval-current' },
    });
  });

  it.each([
    ['completed', 'completed'],
    ['interrupted', 'interrupted'],
    ['failed', 'failed'],
  ] as const)('clears pending interaction when a turn is %s', async (turnStatus, taskStatus) => {
    const { transport, manager } = await runningTask();
    emitApproval(transport);

    transport.emit({
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: {
          id: 'turn-1',
          status: turnStatus,
          error: turnStatus === 'failed' ? { message: 'Turn failed' } : null,
        },
      },
    });

    expect(manager.getTask('task-1')).toMatchObject({
      status: taskStatus,
      pendingInteraction: null,
    });
  });

  it('keeps the active interaction when a stale turn completes', async () => {
    const { transport, manager } = await runningTask();
    emitApproval(transport);

    transport.emit({
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: { id: 'turn-old', status: 'completed', error: null },
      },
    });

    expect(manager.getTask('task-1')).toMatchObject({
      status: 'waiting_for_approval',
      pendingInteraction: { requestId: 'approval-1' },
    });
  });

  it('ignores a stale approval request after the turn completed', async () => {
    const { transport, manager } = await runningTask();
    transport.emit({
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: { id: 'turn-1', status: 'completed', error: null },
      },
    });

    emitApproval(transport, 'approval-late');

    expect(manager.getTask('task-1')).toMatchObject({
      status: 'completed',
      pendingInteraction: null,
    });
  });

  it('surfaces blocking user questions and returns answers by question id', async () => {
    const { transport, manager } = await runningTask();
    transport.emit({
      id: 'input-1',
      method: 'item/tool/requestUserInput',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-2',
        isBlocking: true,
        autoResolutionMs: null,
        questions: [{
          id: 'tone',
          header: 'Tone',
          question: 'Which tone?',
          isOther: false,
          isSecret: false,
          options: [{ label: 'Concise', description: 'Keep it brief.' }],
        }],
      },
    });

    expect(manager.getTask('task-1')).toMatchObject({
      status: 'waiting_for_input',
      pendingInteraction: { requestId: 'input-1', kind: 'user_input' },
    });

    await manager.respondToUserInput('task-1', { tone: ['Concise'] });
    expect(transport.sent.at(-1)).toEqual({
      id: 'input-1',
      result: { answers: { tone: { answers: ['Concise'] } } },
    });
  });

  it('keeps the latest sparse rate-limit notification for the UI', async () => {
    const { transport, manager } = await runningTask();
    const rateLimits = {
      limitId: 'codex',
      limitName: 'Codex',
      primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1_788_238_800 },
      secondary: null,
      credits: null,
      individualLimit: null,
      spendControlReached: false,
      planType: 'plus',
      rateLimitReachedType: null,
    };

    transport.emit({ method: 'account/rateLimits/updated', params: { rateLimits } });

    expect(manager.getRateLimits()).toEqual(rateLimits);
  });

  it('keeps the latest token usage update on its task', async () => {
    const { transport, manager } = await runningTask();
    const tokenUsage = {
      total: {
        totalTokens: 150,
        inputTokens: 100,
        cachedInputTokens: 20,
        cacheWriteInputTokens: 0,
        outputTokens: 50,
        reasoningOutputTokens: 10,
      },
      last: {
        totalTokens: 150,
        inputTokens: 100,
        cachedInputTokens: 20,
        cacheWriteInputTokens: 0,
        outputTokens: 50,
        reasoningOutputTokens: 10,
      },
      modelContextWindow: 258_400,
    };

    transport.emit({
      method: 'thread/tokenUsage/updated',
      params: { threadId: 'thread-1', turnId: 'turn-1', tokenUsage },
    });

    expect(manager.getTask('task-1')?.tokenUsage).toEqual(tokenUsage);
  });

  it('records a terminal App Server error on the task', async () => {
    const { transport, manager } = await runningTask();
    emitApproval(transport);

    transport.emit({
      method: 'error',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        willRetry: false,
        error: { message: 'Model unavailable', codexErrorInfo: null, additionalDetails: null, misalignment: null },
      },
    });

    expect(manager.getTask('task-1')).toMatchObject({
      status: 'failed',
      error: 'Model unavailable',
      pendingInteraction: null,
    });
  });

  it('recovers from a process crash by reconnecting and resuming the durable thread', async () => {
    const { transport, manager } = await runningTask();
    transport.emit({
      method: 'item/agentMessage/delta',
      params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', delta: 'Partial output' },
    });

    transport.crash();
    expect(manager.getTask('task-1')).toMatchObject({
      status: 'interrupted',
      recoverable: true,
      error: 'Codex App Server exited with code 70',
    });

    await manager.recoverTask('task-1');

    expect(transport.starts).toBe(2);
    expect(transport.sent.at(-1)).toMatchObject({
      method: 'thread/resume',
      params: { threadId: 'thread-1' },
    });
    expect(manager.getTask('task-1')).toMatchObject({
      status: 'ready',
      recoverable: false,
      error: null,
      transcript: [
        { role: 'user', text: 'Draft an outline.' },
        { role: 'assistant', text: 'Partial output' },
      ],
    });
  });

  it('disposes manager subscriptions before a replacement manager is constructed', async () => {
    const transport = new ScriptedAppServer();
    const client = new CodexAppServerClient(transport);
    await client.connect();
    const oldManager = new GeneralTaskManager(client);
    await oldManager.startTask({
      id: 'task-old',
      cwd: '/workspace',
      prompt: 'Old task',
      createdAt: '2026-09-01T00:00:00.000Z',
    });
    oldManager.dispose();

    const currentManager = new GeneralTaskManager(client);
    await currentManager.startTask({
      id: 'task-current',
      cwd: '/workspace',
      prompt: 'Current task',
      createdAt: '2026-09-01T00:01:00.000Z',
    });
    transport.emit({
      method: 'item/agentMessage/delta',
      params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', delta: 'Once' },
    });
    emitApproval(transport);
    transport.crash();

    expect(oldManager.getTask('task-old')).toMatchObject({
      status: 'running',
      transcript: [{ role: 'user', text: 'Old task' }],
      pendingInteraction: null,
    });
    expect(currentManager.getTask('task-current')).toMatchObject({
      status: 'interrupted',
      transcript: [
        { role: 'user', text: 'Current task' },
        { role: 'assistant', text: 'Once' },
      ],
      pendingInteraction: null,
    });
  });
});
