import { describe, expect, it, vi } from 'vitest';
import {
  createTauriDesktopAdapter,
  createDemoDesktopAdapter,
  type ConnectionSummary,
  type DesktopAdapter,
  type NativeAppServerTransport,
  type NativeJsonRpcMessage,
} from './desktop-adapter.js';
import { TauriCodexTransport, type TauriBridge } from './codex-transport.js';
import { createNativePipeline } from '../../worker/src/native-pipeline.js';
import type { WorkflowWorkerGateway } from './workflow-worker-client.js';

class ScriptedNativeServer implements NativeAppServerTransport {
  readonly sent: NativeJsonRpcMessage[] = [];
  starts = 0;
  startError: Error | null = null;
  accountReadError: string | null = null;
  holdAccountReads = false;
  readonly heldAccountReads: NativeJsonRpcMessage[] = [];
  private lineListener: ((line: string) => void) | undefined;
  private exitListener:
    | ((detail: { code: number | null; signal: string | null }) => void)
    | undefined;

  constructor(
    public account: unknown = {
      type: 'chatgpt',
      email: 'person@example.com',
      planType: 'plus',
    },
  ) {}

  async start(): Promise<void> {
    this.starts += 1;
    if (this.startError) throw this.startError;
  }

  async send(line: string): Promise<void> {
    const message = JSON.parse(line) as NativeJsonRpcMessage;
    this.sent.push(message);
    if (message.id === undefined || message.method === undefined) return;
    if (message.method === 'account/read' && this.holdAccountReads) {
      this.heldAccountReads.push(message);
      return;
    }
    if (message.method === 'account/read' && this.accountReadError) {
      this.emit({ id: message.id, error: { code: -32000, message: this.accountReadError } });
      return;
    }
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

  crash(): void {
    this.exitListener?.({ code: 70, signal: null });
  }

  private responseFor(method: string): unknown {
    switch (method) {
      case 'initialize':
        return {};
      case 'account/read':
        return { account: this.account, requiresOpenaiAuth: this.account === null };
      case 'account/login/start':
        return { type: 'chatgpt', loginId: 'login-1', authUrl: 'https://auth.openai.com/login' };
      case 'thread/start':
        return { thread: { id: 'thread-native-1' } };
      case 'thread/resume':
        return { thread: { id: 'thread-native-1' } };
      case 'turn/start':
        return { turn: { id: 'turn-native-1' } };
      default:
        return {};
    }
  }
}

function observeConnection(adapter: DesktopAdapter) {
  // A missing subscription or a publication that leaves runtime at its placeholder breaks the UI contract.
  expect(typeof adapter.subscribeConnection).toBe('function');
  const updates: ConnectionSummary[] = [];
  const unsubscribe = adapter.subscribeConnection((snapshot) => updates.push(snapshot));
  return { updates, unsubscribe };
}

function authGateVisualPipeline() {
  const pipeline = createNativePipeline({
    id: 'project-auth', name: '鉴权检查', goal: '不启动付费生成', createdAt: 'now',
  });
  pipeline.revision = 7;
  pipeline.project.workflowStatus = 'visual_review';
  pipeline.currentSlideId = 'slide-auth';
  pipeline.slideSpecs = {
    version: {
      id: 'specs-v1', projectId: 'project-auth', sequence: 1,
      status: 'frozen', createdAt: 'now', frozenAt: 'now',
    },
    value: [{
      id: 'slide-auth', title: '鉴权页', body: ['正文'], findingIds: [], dataPointIds: [],
      tables: [], charts: [], shapes: [], sourceMap: [], imageGenerationBrief: '16:9 蓝色构图',
    }],
  };
  return pipeline;
}

class NativeConnectionBridge implements TauriBridge {
  readonly commands: Array<{ command: string; args?: Record<string, unknown> }> = [];
  private generation = 0;
  private readonly listeners = new Map<string, Set<(event: { payload: unknown }) => void>>();

  async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    this.commands.push({ command, args });
    if (command === 'start_codex_app_server') {
      return { binaryPath: '/local/codex', generation: ++this.generation } as T;
    }
    if (command === 'send_codex_app_server_line') {
      const message = JSON.parse(args?.line as string) as NativeJsonRpcMessage;
      if (message.id !== undefined) {
        const result = message.method === 'account/read'
          ? { account: { type: 'chatgpt', email: 'native@example.com', planType: 'pro' }, requiresOpenaiAuth: false }
          : {};
        queueMicrotask(() => {
          for (const listener of this.listeners.get('codex-app-server://stdout') ?? []) {
            listener({ payload: { generation: args?.generation, line: JSON.stringify({ id: message.id, result }) } });
          }
        });
      }
    }
    return { status: '已保存' } as T;
  }

  async listen<T>(event: string, handler: (event: { payload: T }) => void): Promise<() => void> {
    const listeners = this.listeners.get(event) ?? new Set();
    const listener = handler as (event: { payload: unknown }) => void;
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return () => { listeners.delete(listener); };
  }
}

describe('desktop connection snapshots', () => {
  it('publishes a real account and connected local runtime, and replays the latest snapshot', async () => {
    const transport = new ScriptedNativeServer();
    const adapter = createTauriDesktopAdapter(transport, vi.fn());
    const { updates } = observeConnection(adapter);
    expect(updates.at(-1)).toMatchObject({ account: { status: 'unavailable' }, runtime: { status: 'unavailable' } });

    await expect(adapter.connectAccount()).resolves.toEqual({ email: 'person@example.com', plan: 'plus', status: 'connected' });

    expect(updates.at(-1)).toEqual({
      account: { email: 'person@example.com', plan: 'plus', status: 'connected' },
      runtime: {
        status: 'connected', detail: expect.stringContaining('plus'),
        address: 'stdio（本机进程）', model: null, uptime: null, queue: null,
      },
    });
    expect(observeConnection(adapter).updates).toEqual([updates.at(-1)]);
  });

  it('keeps the service connected while an unauthenticated account waits for login', async () => {
    const adapter = createTauriDesktopAdapter(new ScriptedNativeServer(null), vi.fn());
    const { updates } = observeConnection(adapter);
    await adapter.connectAccount();
    expect(updates.at(-1)).toMatchObject({
      account: { email: null, plan: null, status: 'logged_out' },
      runtime: { status: 'connected', detail: expect.stringMatching(/登录/), address: 'stdio（本机进程）' },
    });
  });

  it('clears a crashed connection and establishes a new handshake when reconnected', async () => {
    const transport = new ScriptedNativeServer();
    const adapter = createTauriDesktopAdapter(transport, vi.fn());
    const { updates } = observeConnection(adapter);
    await adapter.connectAccount();
    transport.crash();
    expect(updates.at(-1)).toMatchObject({
      account: { email: null, plan: null, status: 'unavailable' },
      runtime: { status: 'unavailable', address: null },
    });

    transport.account = { type: 'chatgpt', email: 'second@example.com', planType: 'pro' };
    await adapter.connectAccount();
    expect(transport.starts).toBe(2);
    expect(updates.at(-1)).toMatchObject({ account: { email: 'second@example.com', plan: 'pro' }, runtime: { status: 'connected' } });
  });

  it('refreshes connection state after recovering a crashed task without starting another turn', async () => {
    const { adapter, transport, task } = await runningNativeTask();
    const { updates } = observeConnection(adapter);
    transport.crash();
    transport.account = { type: 'chatgpt', email: 'recovered@example.com', planType: 'pro' };

    await expect(adapter.recoverTask(task.id)).resolves.toMatchObject({ status: 'ready' });

    expect(updates.at(-1)).toMatchObject({
      account: { email: 'recovered@example.com', plan: 'pro', status: 'connected' },
      runtime: { status: 'connected', address: 'stdio（本机进程）' },
    });
    expect(transport.sent.filter(({ method }) => method === 'turn/start')).toHaveLength(1);
  });

  it('keeps connection unavailable if reading the account after task recovery fails', async () => {
    const { adapter, transport, task } = await runningNativeTask();
    const { updates } = observeConnection(adapter);
    transport.crash();
    transport.accountReadError = 'recovered account unavailable';

    await expect(adapter.recoverTask(task.id)).rejects.toThrow('recovered account unavailable');

    expect(updates.at(-1)).toMatchObject({
      account: { email: null, plan: null, status: 'unavailable' },
      runtime: { status: 'unavailable', detail: expect.stringContaining('recovered account unavailable') },
    });
    expect(transport.sent.filter(({ method }) => method === 'turn/start')).toHaveLength(1);
  });

  it('never publishes connected runtime if starting the local process fails', async () => {
    const transport = new ScriptedNativeServer();
    transport.startError = new Error('binary unavailable');
    const adapter = createTauriDesktopAdapter(transport, vi.fn());
    const { updates } = observeConnection(adapter);
    await expect(adapter.connectAccount()).rejects.toThrow('binary unavailable');
    expect(updates.every(({ runtime }) => runtime.status === 'unavailable')).toBe(true);
    expect(updates.at(-1)?.runtime.detail).toContain('binary unavailable');
  });

  it('clears an earlier successful snapshot when an account refresh fails', async () => {
    const transport = new ScriptedNativeServer();
    const adapter = createTauriDesktopAdapter(transport, vi.fn());
    const { updates } = observeConnection(adapter);
    await adapter.connectAccount();
    transport.accountReadError = 'account refresh failed';
    await expect(adapter.connectAccount()).rejects.toThrow('account refresh failed');
    expect(updates.at(-1)).toMatchObject({
      account: { email: null, plan: null, status: 'unavailable' },
      runtime: { status: 'unavailable', detail: expect.stringContaining('account refresh failed') },
    });
  });

  it.each(['account/login/completed', 'account/updated'] as const)('refreshes the real email on %s without looping on account/read', async (method) => {
    const transport = new ScriptedNativeServer(null);
    const adapter = createTauriDesktopAdapter(transport, vi.fn());
    const { updates } = observeConnection(adapter);
    await adapter.connectAccount();
    if (method === 'account/login/completed') await adapter.startLogin();
    transport.account = { type: 'chatgpt', email: 'logged-in@example.com', planType: 'pro' };
    transport.emit({ method, params: method === 'account/login/completed'
      ? { loginId: 'login-1', success: true, error: null }
      : { authMode: 'chatgpt', planType: 'pro' } });

    await vi.waitFor(() => expect(updates.at(-1)).toMatchObject({
      account: { email: 'logged-in@example.com', plan: 'pro', status: 'connected' },
      runtime: { status: 'connected' },
    }));
    expect(transport.sent.filter(({ method: sent }) => sent === 'account/read')).toHaveLength(2);
  });

  it.each([
    [null, 'logged_out'],
    ['apikey', 'unavailable'],
  ])('prevents a stale read from restoring an account after auth mode becomes %s', async (authMode, status) => {
    const transport = new ScriptedNativeServer();
    const adapter = createTauriDesktopAdapter(transport, vi.fn());
    const { updates } = observeConnection(adapter);
    await adapter.connectAccount();
    transport.holdAccountReads = true;
    const refreshing = adapter.connectAccount();
    await vi.waitFor(() => expect(transport.heldAccountReads).toHaveLength(1));
    transport.emit({ method: 'account/updated', params: { authMode, planType: null } });
    expect(updates.at(-1)).toMatchObject({ account: { email: null, plan: null, status }, runtime: { status: 'connected' } });
    transport.emit({ id: transport.heldAccountReads[0]!.id, result: {
      account: { type: 'chatgpt', email: 'stale@example.com', planType: 'plus' }, requiresOpenaiAuth: false,
    } });
    await expect(refreshing).rejects.toThrow(/失效|superseded/);
    expect(updates.at(-1)).toMatchObject({ account: { email: null, plan: null, status } });
  });

  it('blocks a superseded task account check instead of accepting the last connected account', async () => {
    const transport = new ScriptedNativeServer();
    const adapter = createTauriDesktopAdapter(transport, async () => '/validated/workspace');
    await adapter.connectAccount();
    transport.holdAccountReads = true;
    const task = adapter.startTask('不得使用之前的登录状态');
    const checking = adapter.connectAccount();
    const outcomes = Promise.allSettled([task, checking]);
    await vi.waitFor(() => expect(transport.heldAccountReads).toHaveLength(1));
    transport.emit({ id: transport.heldAccountReads[0]!.id, result: { account: null, requiresOpenaiAuth: true } });

    const [taskOutcome] = await outcomes;
    expect(taskOutcome.status).toBe('rejected');
    expect(transport.sent.some(({ method }) => method === 'thread/start')).toBe(false);
    expect(transport.sent.some(({ method }) => method === 'turn/start')).toBe(false);
    expect(observeConnection(adapter).updates.at(-1)?.account.status).toBe('logged_out');
  });

  it('stops publishing to an unsubscribed listener and isolates replayed snapshots', async () => {
    const adapter = createTauriDesktopAdapter(new ScriptedNativeServer(), vi.fn());
    const { updates, unsubscribe } = observeConnection(adapter);
    updates[0]!.account.email = 'mutated@example.com';
    expect(observeConnection(adapter).updates[0]!.account.email).toBeNull();
    unsubscribe();
    await adapter.connectAccount();
    expect(updates).toHaveLength(1);
  });

  it('publishes connection state when starting a task performs the account check', async () => {
    const { adapter } = await runningNativeTask();
    expect(observeConnection(adapter).updates.at(-1)).toMatchObject({
      account: { email: 'person@example.com', status: 'connected' }, runtime: { status: 'connected' },
    });
  });

  it('publishes logged-out service state when a PPT account check blocks execution', async () => {
    const pipeline = authGateVisualPipeline();
    const invoke = vi.fn(async (command: string) => {
      if (command === 'ppt_load_pipeline') return structuredClone(pipeline);
      throw new Error(`Unexpected native command: ${command}`);
    });
    const adapter = createTauriDesktopAdapter(new ScriptedNativeServer(null), invoke);
    const { updates } = observeConnection(adapter);
    await expect(adapter.requestVisual('project-auth', 'slide-auth')).rejects.toThrow('ChatGPT');
    expect(updates.at(-1)).toMatchObject({ account: { status: 'logged_out' }, runtime: { status: 'connected' } });
  });

  it('invalidates a saved Codex path and reconnects through a fresh native process', async () => {
    const bridge = new NativeConnectionBridge();
    const adapter = createTauriDesktopAdapter(new TauriCodexTransport(null, bridge), bridge.invoke.bind(bridge));
    const { updates } = observeConnection(adapter);
    await adapter.connectAccount();
    await adapter.saveSettings({ workspacePath: '/workspace', codexPath: '/other/codex' });
    expect(updates.at(-1)).toMatchObject({ account: { email: null, status: 'unavailable' }, runtime: { status: 'unavailable' } });
    await adapter.connectAccount();
    expect(updates.at(-1)).toMatchObject({ account: { email: 'native@example.com' }, runtime: { status: 'connected' } });
    expect(bridge.commands.filter(({ command }) => command === 'start_codex_app_server')).toEqual([
      { command: 'start_codex_app_server', args: { configuredPath: null } },
      { command: 'start_codex_app_server', args: { configuredPath: '/other/codex' } },
    ]);
  });

  it('replays and publishes an explicitly identified demo connection', async () => {
    const adapter = createDemoDesktopAdapter();
    const { updates, unsubscribe } = observeConnection(adapter);
    await adapter.connectAccount();
    expect(updates).toHaveLength(2);
    expect(updates.at(-1)).toMatchObject({
      account: { email: 'demo@workbench.local', status: 'connected' },
      runtime: { status: 'connected', detail: expect.stringContaining('演示') },
    });
    unsubscribe();
    await adapter.connectAccount();
    expect(updates).toHaveLength(2);
  });
});

async function runningNativeTask() {
  const transport = new ScriptedNativeServer();
  const invoke = vi.fn(async (command: string) => {
    if (command === 'workspace_directory') return '/validated/workspace';
    return {};
  });
  const adapter = createTauriDesktopAdapter(transport, invoke);
  const task = await adapter.startTask('整理评审结论');
  return { adapter, invoke, task, transport };
}

describe('native desktop general-task bridge', () => {
  it('does not expose an inactive ChatGPT account as connected to the UI', async () => {
    const transport = new ScriptedNativeServer({
      type: 'chatgpt', email: 'person@example.com', planType: '',
    });
    const adapter = createTauriDesktopAdapter(transport, vi.fn());

    await expect(adapter.connectAccount()).resolves.toEqual({
      email: null, plan: null, status: 'unavailable',
    });
  });

  it.each([
    [{ type: 'apikey' }, 'API-key'],
    [null, 'ChatGPT'],
    [{ type: 'chatgpt', email: null, planType: '' }, 'active'],
  ])('atomically blocks non-active ChatGPT auth before any paid turn (%j)', async (account, message) => {
    const transport = new ScriptedNativeServer(account);
    const invoke = vi.fn(async () => '/validated/workspace');
    const adapter = createTauriDesktopAdapter(transport, invoke);

    await expect(adapter.startTask('不得发起付费 turn')).rejects.toThrow(message);

    expect(transport.sent.some(({ method }) => method === 'account/read')).toBe(true);
    expect(transport.sent.some(({ method }) => method === 'thread/start')).toBe(false);
    expect(transport.sent.some(({ method }) => method === 'turn/start')).toBe(false);
    expect(invoke).not.toHaveBeenCalledWith('workspace_directory', undefined);
  });

  it('scopes auth failure from a read-only checkpoint and blocks Worker/model execution', async () => {
    const transport = new ScriptedNativeServer({ type: 'apikey' });
    const pipeline = authGateVisualPipeline();
    const invoke = vi.fn(async (command: string) => {
      if (command === 'ppt_load_pipeline') return structuredClone(pipeline);
      throw new Error(`Unexpected native command: ${command}`);
    });
    const worker: WorkflowWorkerGateway = {
      health: vi.fn(async () => ({
        protocolVersion: 1 as const,
        worker: 'digital-twin-workflow-worker' as const,
        status: 'ready' as const,
      })),
      createProject: vi.fn(async () => ({} as never)),
      restoreProject: vi.fn(async (pipeline) => pipeline),
      executeProject: vi.fn(async () => ({} as never)),
      snapshotProject: vi.fn(async () => ({} as never)),
    };
    const adapter = createTauriDesktopAdapter(transport, invoke, worker);

    await expect(adapter.requestVisual('project-auth', 'slide-auth')).rejects.toThrow('API-key');

    expect(transport.sent.some(({ method }) => method === 'account/read')).toBe(true);
    expect(transport.sent.some(({ method }) => method === 'thread/start')).toBe(false);
    expect(transport.sent.some(({ method }) => method === 'turn/start')).toBe(false);
    expect(invoke).toHaveBeenCalledExactlyOnceWith('ppt_load_pipeline', { projectId: 'project-auth' });
    expect(worker.restoreProject).not.toHaveBeenCalled();
    expect(worker.executeProject).not.toHaveBeenCalled();
    expect(adapter.getProjectGeneration('project-auth')).toMatchObject({
      status: 'failed', visualContext: { slideId: 'slide-auth', baseRevision: 7 },
    });
  });

  it('times out a hung visual account read and ignores its late response without starting a turn', async () => {
    vi.useFakeTimers();
    try {
      const transport = new ScriptedNativeServer();
      transport.holdAccountReads = true;
      const pipeline = authGateVisualPipeline();
      const invoke = vi.fn(async (command: string) => {
        if (command === 'ppt_load_pipeline') return structuredClone(pipeline);
        throw new Error(`Unexpected native command: ${command}`);
      });
      const worker: WorkflowWorkerGateway = {
        health: vi.fn(async () => ({ protocolVersion: 1 as const, worker: 'digital-twin-workflow-worker' as const, status: 'ready' as const })),
        createProject: vi.fn(async () => ({} as never)),
        restoreProject: vi.fn(async (value) => value),
        executeProject: vi.fn(async () => ({} as never)),
        snapshotProject: vi.fn(async () => ({} as never)),
      };
      const adapter = createTauriDesktopAdapter(transport, invoke, worker);
      let outcome = 'pending';
      const generation = adapter.requestVisual('project-auth', 'slide-auth');
      void generation.then(() => { outcome = 'resolved'; }, (error: unknown) => {
        outcome = error instanceof Error ? error.message : String(error);
      });

      await vi.advanceTimersByTimeAsync(30_001);
      expect(outcome).toContain('账号状态超时');
      expect(transport.sent.some(({ method }) => method === 'thread/start')).toBe(false);
      expect(adapter.getProjectGeneration('project-auth')).toMatchObject({
        status: 'failed', error: expect.stringContaining('账号状态超时'),
        visualContext: { slideId: 'slide-auth', baseRevision: 7 },
      });

      transport.emit({ id: transport.heldAccountReads[0]!.id, result: {
        account: { type: 'chatgpt', email: 'late@example.com', planType: 'plus' }, requiresOpenaiAuth: false,
      } });
      await Promise.resolve();
      expect(transport.sent.some(({ method }) => method === 'thread/start')).toBe(false);
      expect(worker.executeProject).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses only the canonical workspace returned by Rust for a general task', async () => {
    const { invoke, task, transport } = await runningNativeTask();

    expect(task.status).toBe('running');
    expect(invoke).toHaveBeenCalledWith('workspace_directory', undefined);
    expect(transport.sent.find(({ method }) => method === 'thread/start')).toMatchObject({
      params: { cwd: '/validated/workspace' },
    });
  });

  it('refreshes project summaries without starting AI processes or replacing connection state', async () => {
    const transport = new ScriptedNativeServer();
    const persisted = createDemoDesktopAdapter().initialState;
    const invoke = vi.fn(async (command: string) => {
      if (command !== 'load_desktop_state') throw new Error('Unexpected native command');
      return persisted;
    });
    const adapter = createTauriDesktopAdapter(transport, invoke);
    await adapter.connectAccount();
    const states: ConnectionSummary[] = [];
    adapter.subscribeConnection((state) => states.push(state));
    const sentBefore = transport.sent.length;
    expect(await adapter.listProjects()).toEqual(persisted.projects);
    expect(invoke).toHaveBeenCalledExactlyOnceWith('load_desktop_state', undefined);
    expect(transport.sent).toHaveLength(sentBefore);
    expect(states).toHaveLength(1);
    expect(states[0]?.account).toEqual({ email: 'person@example.com', plan: 'plus', status: 'connected' });
  });

  it('refreshes memories and derives approvals from ready pipeline drafts without starting services', async () => {
    const transport = new ScriptedNativeServer();
    const persisted = structuredClone(createDemoDesktopAdapter().initialState);
    persisted.projects = [{
      id: 'project-review', name: '真实待审核项目', goal: '审核真实草稿',
      stage: '逐页细化', progress: 40, updatedAt: '刚刚',
    }];
    persisted.approvals = [{
      id: 'historical-approved', title: '历史记录', detail: '不应作为待处理项',
      author: '本机用户', time: '昨天',
    }];
    persisted.memories = [{
      id: 'proposal-saved', title: '已落盘建议', content: '不用再次生成即可看到', status: '待决定',
    }];
    const draft = createNativePipeline({
      id: 'project-review', name: '真实待审核项目', goal: '审核真实草稿',
      createdAt: '2026-09-07T02:00:00.000Z',
    });
    draft.project.workflowStatus = 'detail_review';
    draft.slideSpecs = {
      version: {
        id: 'project-review-slide-specs-v1', projectId: 'project-review', sequence: 1,
        status: 'draft', createdAt: '2026-09-07T03:00:00.000Z', frozenAt: null,
      },
      value: [],
    };
    const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'load_desktop_state') return persisted;
      if (command === 'ppt_load_pipeline' && args?.projectId === 'project-review') return draft;
      throw new Error(`Unexpected native command: ${command}`);
    });
    const worker: WorkflowWorkerGateway = {
      health: vi.fn(async () => ({
        protocolVersion: 1 as const, worker: 'digital-twin-workflow-worker' as const,
        status: 'ready' as const,
      })),
      createProject: vi.fn(async () => ({} as never)),
      restoreProject: vi.fn(async (pipeline) => pipeline),
      executeProject: vi.fn(async () => ({} as never)),
      snapshotProject: vi.fn(async () => ({} as never)),
    };
    const adapter = createTauriDesktopAdapter(transport, invoke, worker);

    await expect(adapter.loadCollections?.()).resolves.toEqual({
      approvals: [{
        id: 'ppt-review:project-review:details:project-review-slide-specs-v1',
        projectId: 'project-review', title: '真实待审核项目', detail: '全部页面细化待审核',
        author: 'PPT 工作流', time: '2026-09-07T02:00:00.000Z',
      }],
      memories: persisted.memories,
      availability: { approvals: 'loaded', memories: 'loaded' },
    });
    expect(transport.sent).toEqual([]);
    expect(worker.health).not.toHaveBeenCalled();
    expect(worker.restoreProject).not.toHaveBeenCalled();
  });

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
    const worker: WorkflowWorkerGateway = {
      health: vi.fn(async () => ({
        protocolVersion: 1 as const,
        worker: 'digital-twin-workflow-worker' as const,
        status: 'ready' as const,
      })),
      createProject: vi.fn(async () => ({} as never)),
      restoreProject: vi.fn(async (pipeline) => pipeline),
      executeProject: vi.fn(async () => ({} as never)),
      snapshotProject: vi.fn(async () => ({} as never)),
    };
    const adapter = createTauriDesktopAdapter(transport, invoke, worker);

    await expect(adapter.loadInitialState()).resolves.toEqual(persisted);
    expect(worker.health).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith('load_desktop_state', undefined);
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

  it('exposes cancel and crash recovery with recoverable task state', async () => {
    const cancelled = await runningNativeTask();
    await expect(cancelled.adapter.cancelTask(cancelled.task.id)).resolves.toMatchObject({
      status: 'cancelled',
    });
    expect(cancelled.transport.sent.at(-1)).toMatchObject({
      method: 'turn/interrupt',
      params: { threadId: 'thread-native-1', turnId: 'turn-native-1' },
    });

    const crashed = await runningNativeTask();
    let latest = crashed.task;
    crashed.adapter.subscribeTask(crashed.task.id, (task) => { latest = task; });
    crashed.transport.crash();
    expect(latest).toMatchObject({ status: 'interrupted', recoverable: true });

    await expect(crashed.adapter.recoverTask(crashed.task.id)).resolves.toMatchObject({
      status: 'ready',
      recoverable: false,
    });
    expect(crashed.transport.sent.some(({ method }) => method === 'thread/resume')).toBe(true);
  });
});
