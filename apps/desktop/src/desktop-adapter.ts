import { invoke } from '@tauri-apps/api/core';
import {
  CodexAppServerClient,
  type AppServerTransport,
  type JsonRpcMessage,
} from '../../worker/src/app-server.js';
import { GeneralTaskManager, type GeneralTask } from '../../worker/src/general-tasks.js';
import { TauriCodexTransport } from './codex-transport.js';
import {
  TauriWorkflowWorkerClient,
  type WorkflowWorkerGateway,
} from './workflow-worker-client.js';

export type NativeAppServerTransport = AppServerTransport;
export type NativeJsonRpcMessage = JsonRpcMessage;
export type DesktopAdapterMode = 'demo' | 'tauri';

export interface AccountSummary {
  email: string | null;
  plan: string | null;
  status: 'connected' | 'logged_out' | 'unavailable';
}
export interface ProjectSummary {
  id: string;
  name: string;
  goal: string;
  stage: string;
  progress: number;
  updatedAt: string;
  workflowStatus?: string;
  selectedSlide?: number;
  slides?: Array<{ page: number; status: 'approved' | 'waiting' | 'pending' }>;
  exportReady?: boolean;
  slideNotice?: string;
}
export interface ApprovalSummary {
  id: string;
  title: string;
  detail: string;
  author: string;
  time: string;
}
export interface MemorySummary {
  id: string;
  title: string;
  content: string;
  status: string;
}
export interface RuntimeSummary {
  status: 'connected' | 'unavailable';
  detail: string;
  model: string | null;
  address: string | null;
  uptime: string | null;
  queue: number | null;
}
export type CollectionAvailability = 'unavailable' | 'loading' | 'loaded';
export interface DesktopSettings {
  workspacePath: string;
  codexPath: string;
}
export interface DesktopInitialState {
  account: AccountSummary;
  projects: ProjectSummary[];
  approvals: ApprovalSummary[];
  memories: MemorySummary[];
  runtime: RuntimeSummary;
  collections: {
    projects: CollectionAvailability;
    approvals: CollectionAvailability;
    memories: CollectionAvailability;
  };
  settings: DesktopSettings;
}
export interface PendingTaskInteraction {
  requestId: number | string;
  kind: 'command_approval' | 'file_change_approval' | 'user_input';
  params: unknown;
}
export interface TaskSummary {
  id: string;
  prompt: string;
  status: 'running' | 'waiting_for_approval' | 'waiting_for_input' | 'completed' | 'failed' | 'interrupted';
  transcript: Array<{ role: 'user' | 'assistant'; text: string }>;
  usage: string;
  pendingInteraction: PendingTaskInteraction | null;
  error: string | null;
}
export interface RegenerateResult { status: string; selectedSlide: number }
export interface ApprovalResult {
  status: string;
  nextSlide: number;
  stage?: string;
  exportReady?: boolean;
}
export interface CreateProjectInput { name: string; goal: string }

export interface DesktopAdapter {
  readonly mode: DesktopAdapterMode;
  readonly initialState: DesktopInitialState;
  loadInitialState(): Promise<DesktopInitialState>;
  connectAccount(): Promise<AccountSummary>;
  startLogin(): Promise<{ message: string }>;
  startTask(prompt: string): Promise<TaskSummary>;
  subscribeTask(taskId: string, listener: (task: TaskSummary) => void): () => void;
  respondToTask(taskId: string, decision: 'approve' | 'decline'): Promise<{ status: string }>;
  respondToTaskInput(taskId: string, answers: Record<string, string[]>): Promise<{ status: string }>;
  createProject(input: CreateProjectInput): Promise<ProjectSummary>;
  renameProject(projectId: string, name: string): Promise<{ status: string }>;
  regenerateSlide(projectId: string, slide: number, comment: string): Promise<RegenerateResult>;
  approveSlide(projectId: string, slide: number, comment: string): Promise<ApprovalResult>;
  reopenSlide(projectId: string, slide: number): Promise<{ status: string }>;
  exportProject(projectId: string, name: string): Promise<{ message: string }>;
  decideApproval(approvalId: string, decision: 'approved' | 'rejected'): Promise<{ status: string }>;
  decideMemory(proposalId: string, decision: 'approved' | 'rejected'): Promise<{ status: string }>;
  saveSettings(input: { workspacePath: string; codexPath: string }): Promise<{ status: string }>;
}

export interface DemoAdapterOptions {
  createProjectError?: string;
  delays?: Partial<Record<'approveSlide' | 'regenerateSlide' | 'decideMemory', number>>;
}

const demoInitialState: DesktopInitialState = {
  account: { email: 'demo@workbench.local', plan: 'Plus', status: 'connected' },
  runtime: {
    status: 'connected', detail: '演示服务（非本地 Codex）', model: 'demo-codex',
    address: '演示数据', uptime: '当前会话', queue: 0,
  },
  projects: [
    {
      id: 'ppt-demo-001', name: '年度经营复盘与增长计划',
      goal: '向管理层复盘年度经营结果并说明下一年度增长计划。',
      stage: '视觉审批', progress: 60, updatedAt: '今天 14:29',
    },
    {
      id: 'ppt-demo-002', name: '智能家居产品发布会',
      goal: '向媒体和渠道伙伴介绍智能家居新品与上市计划。',
      stage: '视觉审批', progress: 42, updatedAt: '昨天 16:43',
    },
  ],
  approvals: [
    { id: 'approval-1', title: '智能家居产品发布会', detail: '内容大纲待审批', author: '张三', time: '10 分钟前' },
    { id: 'approval-2', title: '年度工作总结汇报', detail: '最终稿待审批', author: '李四', time: '2 小时前' },
    { id: 'approval-3', title: '市场推广方案', detail: '内容修改待审批', author: '王五', time: '昨天 18:32' },
  ],
  memories: [
    { id: 'memory-chart', title: '图表优先', content: '在经营复盘类 PPT 中，优先使用趋势图和对比图呈现关键数据。', status: '待决定' },
    { id: 'memory-tone', title: '中文简洁表述', content: '报告文本采用简洁、直接的中文表达，并保留关键事实来源。', status: '待决定' },
  ],
  collections: {
    projects: 'loaded',
    approvals: 'loaded',
    memories: 'loaded',
  },
  settings: {
    workspacePath: '/Users/demo/Documents/Workspaces',
    codexPath: '演示：自动检测',
  },
};

const nativeInitialState: DesktopInitialState = {
  account: { email: null, plan: null, status: 'unavailable' },
  runtime: { status: 'unavailable', detail: '尚未从本地服务读取', model: null, address: null, uptime: null, queue: null },
  projects: [], approvals: [], memories: [],
  collections: {
    projects: 'unavailable',
    approvals: 'unavailable',
    memories: 'unavailable',
  },
  settings: { workspacePath: '', codexPath: '' },
};

export function createDemoDesktopAdapter(options: DemoAdapterOptions = {}): DesktopAdapter {
  let counter = 1;
  const initialState = structuredClone(demoInitialState);
  const tasks = new Map<string, TaskSummary>();
  const listeners = new Map<string, Set<(task: TaskSummary) => void>>();
  const delay = async (key: keyof NonNullable<DemoAdapterOptions['delays']>) => {
    const milliseconds = options.delays?.[key] ?? 0;
    if (milliseconds > 0) await new Promise((resolve) => window.setTimeout(resolve, milliseconds));
  };
  return {
    mode: 'demo',
    initialState,
    async loadInitialState() { return structuredClone(initialState); },
    async connectAccount() { return structuredClone(demoInitialState.account); },
    async startLogin() { return { message: '演示数据：浏览器登录流程已准备好。' }; },
    async startTask(prompt) {
      const task: TaskSummary = {
        id: `demo-task-${counter++}`, prompt, status: 'waiting_for_approval',
        transcript: [
          { role: 'user', text: prompt },
          { role: 'assistant', text: '演示响应：已分析任务范围，等待你的批准。' },
        ],
        usage: '2.6K / 5.0K tokens',
        pendingInteraction: { requestId: `demo-approval-${counter}`, kind: 'command_approval', params: {} },
        error: null,
      };
      tasks.set(task.id, task);
      return cloneTask(task);
    },
    subscribeTask(taskId, listener) {
      const taskListeners = listeners.get(taskId) ?? new Set();
      taskListeners.add(listener);
      listeners.set(taskId, taskListeners);
      const current = tasks.get(taskId);
      if (current) listener(cloneTask(current));
      return () => taskListeners.delete(listener);
    },
    async respondToTask(taskId, decision) {
      const task = tasks.get(taskId);
      if (!task?.pendingInteraction || task.pendingInteraction.kind === 'user_input') throw new Error('Task is not waiting for an approval');
      task.pendingInteraction = null;
      task.status = decision === 'approve' ? 'running' : 'failed';
      const status = decision === 'approve'
        ? '演示数据：已批准，Codex 正在继续执行。'
        : '演示数据：已拒绝，任务保持为草稿。';
      task.transcript.push({ role: 'assistant', text: status });
      for (const listener of listeners.get(taskId) ?? []) listener(cloneTask(task));
      return { status };
    },
    async respondToTaskInput(taskId) {
      const task = tasks.get(taskId);
      if (task?.pendingInteraction?.kind !== 'user_input') throw new Error('Task is not waiting for user input');
      task.pendingInteraction = null;
      task.status = 'running';
      return { status: '演示数据：已提交补充信息。' };
    },
    async createProject(input) {
      if (options.createProjectError) throw new Error(options.createProjectError);
      return { id: `ppt-demo-${counter++}`, name: input.name, goal: input.goal, stage: '材料', progress: 10, updatedAt: '刚刚' };
    },
    async renameProject(_projectId, name) { return { status: `演示数据：项目已重命名为“${name}”。` }; },
    async regenerateSlide(_projectId, slide) {
      await delay('regenerateSlide');
      return { status: '已生成候选版本', selectedSlide: slide };
    },
    async approveSlide(_projectId, slide) {
      await delay('approveSlide');
      return slide >= 5
        ? { status: '第 5 页已批准，进入可编辑转换。', nextSlide: 5, stage: 'conversion', exportReady: true }
        : { status: `已批准，进入第 ${slide + 1} 页`, nextSlide: slide + 1 };
    },
    async reopenSlide(_projectId, slide) { return { status: `第 ${slide} 页已重新打开，等待修改。` }; },
    async exportProject(_projectId, name) { return { message: `演示数据：已准备好“${name}.pptx”导出。` }; },
    async decideApproval(_approvalId, decision) { return { status: `演示数据：${decision === 'approved' ? '已批准' : '已驳回'}已记录。` }; },
    async decideMemory(_proposalId, decision) {
      await delay('decideMemory');
      return { status: decision === 'approved' ? '已批准' : '已拒绝' };
    },
    async saveSettings() { return { status: '演示数据：设置已保存在当前浏览器会话。' }; },
  };
}

type NativeCommandInvoker = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

class TauriDesktopAdapter implements DesktopAdapter {
  readonly mode = 'tauri' as const;
  readonly initialState = structuredClone(nativeInitialState);
  private readonly client: CodexAppServerClient;
  private readonly tasks: GeneralTaskManager;
  private readonly taskIds = new Set<string>();
  private readonly taskPrompts = new Map<string, string>();
  private readonly listeners = new Map<string, Set<(task: TaskSummary) => void>>();
  private taskCounter = 1;

  constructor(
    transport: NativeAppServerTransport,
    private readonly nativeInvoke: NativeCommandInvoker,
    private readonly worker: WorkflowWorkerGateway,
  ) {
    this.client = new CodexAppServerClient(transport);
    this.tasks = new GeneralTaskManager(this.client);
    this.client.onServerMessage((message) => {
      const params = asRecord(message.params);
      const threadId = typeof params?.threadId === 'string' ? params.threadId : null;
      if (threadId) this.publishThread(threadId);
    });
    this.client.onExit(() => this.publishAll());
  }

  async loadInitialState(): Promise<DesktopInitialState> {
    await this.worker.health();
    return this.callNative('load_desktop_state', undefined);
  }

  async connectAccount(): Promise<AccountSummary> {
    await this.client.connect();
    const account = await this.client.readAccount();
    return account
      ? { email: account.email, plan: account.planType, status: 'connected' }
      : { email: null, plan: null, status: 'logged_out' };
  }
  async startLogin(): Promise<{ message: string }> {
    await this.client.connect();
    const response = await this.client.startChatGptLogin();
    return { message: `已发起登录，请在浏览器中继续：${response.authUrl}` };
  }
  async startTask(prompt: string): Promise<TaskSummary> {
    await this.client.connect();
    const id = `desktop-task-${this.taskCounter++}`;
    const task = await this.tasks.startTask({ id, cwd: '.', prompt, createdAt: new Date().toISOString() });
    this.taskIds.add(id);
    this.taskPrompts.set(id, prompt);
    return this.toTaskSummary(task);
  }
  subscribeTask(taskId: string, listener: (task: TaskSummary) => void): () => void {
    const taskListeners = this.listeners.get(taskId) ?? new Set();
    taskListeners.add(listener);
    this.listeners.set(taskId, taskListeners);
    const current = this.tasks.getTask(taskId);
    if (current) listener(this.toTaskSummary(current));
    return () => taskListeners.delete(listener);
  }
  async respondToTask(taskId: string, decision: 'approve' | 'decline'): Promise<{ status: string }> {
    await this.tasks.respondToApproval(taskId, decision === 'approve' ? 'accept' : 'decline');
    this.publish(taskId);
    return { status: decision === 'approve' ? '已批准，Codex 正在继续执行。' : '已拒绝该执行请求。' };
  }
  async respondToTaskInput(taskId: string, answers: Record<string, string[]>): Promise<{ status: string }> {
    await this.tasks.respondToUserInput(taskId, answers);
    this.publish(taskId);
    return { status: '已提交补充信息，Codex 正在继续执行。' };
  }
  createProject(input: CreateProjectInput): Promise<ProjectSummary> { return this.callNative('ppt_create_project', { input }); }
  renameProject(projectId: string, name: string): Promise<{ status: string }> { return this.callNative('ppt_rename_project', { projectId, name }); }
  regenerateSlide(projectId: string, slide: number, comment: string): Promise<RegenerateResult> { return this.callNative('ppt_regenerate_slide', { projectId, slide, comment }); }
  approveSlide(projectId: string, slide: number, comment: string): Promise<ApprovalResult> { return this.callNative('ppt_approve_slide', { projectId, slide, comment }); }
  reopenSlide(projectId: string, slide: number): Promise<{ status: string }> { return this.callNative('ppt_reopen_slide', { projectId, slide }); }
  exportProject(projectId: string, name: string): Promise<{ message: string }> { return this.callNative('ppt_export_project', { projectId, name }); }
  decideApproval(approvalId: string, decision: 'approved' | 'rejected'): Promise<{ status: string }> { return this.callNative('approval_decide', { approvalId, decision }); }
  decideMemory(proposalId: string, decision: 'approved' | 'rejected'): Promise<{ status: string }> { return this.callNative('memory_decide', { proposalId, decision }); }
  saveSettings(input: { workspacePath: string; codexPath: string }): Promise<{ status: string }> { return this.callNative('save_desktop_settings', input); }

  private callNative<T>(command: string, args?: Record<string, unknown>): Promise<T> { return this.nativeInvoke(command, args) as Promise<T>; }
  private publishThread(threadId: string): void {
    for (const taskId of this.taskIds) if (this.tasks.getTask(taskId)?.threadId === threadId) this.publish(taskId);
  }
  private publishAll(): void { for (const taskId of this.taskIds) this.publish(taskId); }
  private publish(taskId: string): void {
    const task = this.tasks.getTask(taskId);
    if (!task) return;
    const summary = this.toTaskSummary(task);
    for (const listener of this.listeners.get(taskId) ?? []) listener(summary);
  }
  private toTaskSummary(task: GeneralTask): TaskSummary {
    const status: TaskSummary['status'] =
      task.status === 'queued' ||
      task.status === 'ready' ||
      task.status === 'recovering'
        ? 'running'
        : task.status === 'cancelled'
          ? 'failed'
          : task.status;
    return {
      id: task.id,
      prompt: this.taskPrompts.get(task.id) ?? task.transcript[0]?.text ?? '',
      status,
      transcript: task.transcript.map(({ role, text }) => ({ role, text })),
      usage: formatUsage(task.tokenUsage),
      pendingInteraction: task.pendingInteraction ? { ...task.pendingInteraction } : null,
      error: task.error,
    };
  }
}

export function createTauriDesktopAdapter(
  transport: NativeAppServerTransport = new TauriCodexTransport(null),
  nativeInvoke: NativeCommandInvoker = (command, args) => invoke(command, args),
  worker: WorkflowWorkerGateway = new TauriWorkflowWorkerClient(),
): DesktopAdapter {
  return new TauriDesktopAdapter(transport, nativeInvoke, worker);
}
export function createDesktopAdapter(): DesktopAdapter {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
    ? createTauriDesktopAdapter()
    : createDemoDesktopAdapter();
}

function formatUsage(usage: Record<string, unknown> | null): string {
  const total = asRecord(usage?.total);
  const tokens = typeof total?.totalTokens === 'number' ? total.totalTokens : null;
  const context = typeof usage?.modelContextWindow === 'number' ? usage.modelContextWindow : null;
  if (tokens === null) return '等待 App Server 使用量更新';
  return context === null ? `${tokens} tokens` : `${tokens} / ${context} tokens`;
}
function cloneTask(task: TaskSummary): TaskSummary { return structuredClone(task); }
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null;
}
