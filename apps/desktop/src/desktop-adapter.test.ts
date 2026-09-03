import { describe, expect, it, vi } from 'vitest';
import {
  createTauriDesktopAdapter,
  type NativeAppServerTransport,
  type NativeJsonRpcMessage,
} from './desktop-adapter.js';

class ScriptedNativeServer implements NativeAppServerTransport {
  readonly sent: NativeJsonRpcMessage[] = [];
  private lineListener: ((line: string) => void) | undefined;
  private exitListener:
    | ((detail: { code: number | null; signal: string | null }) => void)
    | undefined;

  async start(): Promise<void> {}

  async send(line: string): Promise<void> {
    const message = JSON.parse(line) as NativeJsonRpcMessage;
    this.sent.push(message);
    if (message.id === undefined || message.method === undefined) return;
    const result = this.responseFor(message.method);
    queueMicrotask(() =>
      this.lineListener?.(JSON.stringify({ id: message.id, result })),
    );
  }

  onLine(listener: (line: string) => void): () => void {
    this.lineListener = listener;
    return () => {
      this.lineListener = undefined;
    };
  }

  onExit(
    listener: (detail: { code: number | null; signal: string | null }) => void,
  ): () => void {
    this.exitListener = listener;
    return () => {
      this.exitListener = undefined;
    };
  }

  emit(message: NativeJsonRpcMessage): void {
    this.lineListener?.(JSON.stringify(message));
  }

  private responseFor(method: string): unknown {
    switch (method) {
      case 'initialize':
        return {};
      case 'thread/start':
        return { thread: { id: 'thread-native-1' } };
      case 'turn/start':
        return { turn: { id: 'turn-native-1' } };
      default:
        return {};
    }
  }
}

async function runningNativeTask() {
  const transport = new ScriptedNativeServer();
  const invoke = vi.fn(async () => ({}));
  const adapter = createTauriDesktopAdapter(transport, invoke);
  const task = await adapter.startTask('整理评审结论');
  return { adapter, invoke, task, transport };
}

describe('native desktop general-task bridge', () => {
  it('loads persisted collections through the native command boundary', async () => {
    const transport = new ScriptedNativeServer();
    const persisted = {
      account: { email: null, plan: null, status: 'unavailable' },
      projects: [
        {
          id: 'persisted-1',
          name: '已保存项目',
          goal: '重启后恢复',
          stage: '视觉审批',
          workflowStatus: 'visual_review',
          progress: 60,
          selectedSlide: 2,
          slides: [
            { page: 1, status: 'approved' },
            { page: 2, status: 'waiting' },
            { page: 3, status: 'pending' },
            { page: 4, status: 'pending' },
            { page: 5, status: 'pending' },
          ],
          exportReady: false,
          slideNotice: '等待审批',
          updatedAt: 'unix:1',
        },
      ],
      approvals: [],
      memories: [],
      runtime: {
        status: 'unavailable',
        detail: '等待连接本机 Codex App Server',
        model: null,
        address: null,
        uptime: null,
        queue: null,
      },
      collections: { projects: 'loaded', approvals: 'loaded', memories: 'loaded' },
      settings: { workspacePath: '/tmp/workspace', codexPath: '' },
    } as const;
    const invoke = vi.fn(async (command: string) => {
      if (command === 'load_desktop_state') return persisted;
      if (command === 'start_worker_sidecar') {
        return { generation: 1, pid: 10, protocolVersion: 1 };
      }
      return {};
    });
    const adapter = createTauriDesktopAdapter(transport, invoke);

    await expect(adapter.loadInitialState()).resolves.toEqual(persisted);
    expect(invoke).toHaveBeenNthCalledWith(1, 'start_worker_sidecar', undefined);
    expect(invoke).toHaveBeenNthCalledWith(2, 'load_desktop_state', undefined);
  });

  it('publishes streamed output, usage, and completion from App Server', async () => {
    const { adapter, task, transport } = await runningNativeTask();
    const updates: typeof task[] = [];
    adapter.subscribeTask(task.id, (update) => updates.push(update));

    transport.emit({
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'thread-native-1',
        turnId: 'turn-native-1',
        itemId: 'answer-1',
        delta: '结论一。',
      },
    });
    transport.emit({
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: 'thread-native-1',
        tokenUsage: { total: { totalTokens: 321 }, modelContextWindow: 4096 },
      },
    });
    transport.emit({
      method: 'turn/completed',
      params: {
        threadId: 'thread-native-1',
        turn: { id: 'turn-native-1', status: 'completed', error: null },
      },
    });

    expect(updates.at(-1)).toMatchObject({
      status: 'completed',
      transcript: [
        { role: 'user', text: '整理评审结论' },
        { role: 'assistant', text: '结论一。' },
      ],
      usage: '321 / 4096 tokens',
    });
  });

  it('stores the actual approval request id and maps UI approval to accept', async () => {
    const { adapter, task, transport } = await runningNativeTask();
    let latest = task;
    adapter.subscribeTask(task.id, (update) => {
      latest = update;
    });
    transport.emit({
      id: 'approval-real-42',
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thread-native-1',
        turnId: 'turn-native-1',
        itemId: 'command-1',
        command: 'git status',
      },
    });

    expect(latest.pendingInteraction).toMatchObject({
      requestId: 'approval-real-42',
      kind: 'command_approval',
    });
    await adapter.respondToTask(task.id, 'approve');
    expect(transport.sent.at(-1)).toEqual({
      id: 'approval-real-42',
      result: { decision: 'accept' },
    });
    expect(transport.sent.some((message) => message.id === 0)).toBe(false);
  });

  it('maps decline and returns blocking input answers to their real request ids', async () => {
    const { adapter, task, transport } = await runningNativeTask();
    transport.emit({
      id: 73,
      method: 'item/fileChange/requestApproval',
      params: {
        threadId: 'thread-native-1',
        turnId: 'turn-native-1',
        itemId: 'change-1',
      },
    });
    await adapter.respondToTask(task.id, 'decline');
    expect(transport.sent.at(-1)).toEqual({
      id: 73,
      result: { decision: 'decline' },
    });

    transport.emit({
      id: 'input-real-9',
      method: 'item/tool/requestUserInput',
      params: {
        threadId: 'thread-native-1',
        turnId: 'turn-native-1',
        itemId: 'input-1',
        questions: [{ id: 'tone', question: '使用什么语气？' }],
      },
    });
    await adapter.respondToTaskInput(task.id, { tone: ['简洁'] });
    expect(transport.sent.at(-1)).toEqual({
      id: 'input-real-9',
      result: { answers: { tone: { answers: ['简洁'] } } },
    });
  });

  it('publishes terminal App Server errors and rejects approvals without a request', async () => {
    const { adapter, task, transport } = await runningNativeTask();
    let latest = task;
    adapter.subscribeTask(task.id, (update) => {
      latest = update;
    });
    transport.emit({
      method: 'error',
      params: {
        threadId: 'thread-native-1',
        turnId: 'turn-native-1',
        willRetry: false,
        error: { message: '本地执行失败' },
      },
    });

    expect(latest).toMatchObject({ status: 'failed', error: '本地执行失败' });
    await expect(adapter.respondToTask(task.id, 'approve')).rejects.toThrow(
      'Task is not waiting for an approval',
    );
  });
});
