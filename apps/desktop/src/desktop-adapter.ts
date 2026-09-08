import { invoke } from '@tauri-apps/api/core';
import {
  CodexAppServerClient,
  type AppServerTransport,
  type JsonRpcMessage,
} from '../../worker/src/app-server.js';
import { CodexImageTurnRunner } from '../../worker/src/codex-image-turn.js';
import { buildPageVisualPrompt } from '../../worker/src/visual-prompt.js';
import { GeneralTaskManager, type GeneralTask } from '../../worker/src/general-tasks.js';
import type {
  NativePipelineAction,
  NativeOutlineRevisionDraft,
  NativePipelineResult,
  NativePptPipeline,
  NativePromptContext,
} from '../../worker/src/native-pipeline.js';
import type { PptOutline, SlideSpec, SourceAnalysis } from '../../worker/src/ppt-project.js';
import { TauriCodexTransport } from './codex-transport.js';
import { buildPptPrompt, promptContextError } from './ppt-prompts.js';
import { normalizeGeneratedSlideSpecs } from '../../worker/src/slide-spec-contract.js';
import { ProjectGenerationRegistry, type ProjectGeneration } from './project-generation.js';
import { ProjectEditRegistry, type ProjectEdit, type ProjectEditIdentity } from './project-edits.js';
import { derivePendingPptApprovals } from './collection-read-model.js';
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
  projectId?: string;
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
export interface ConnectionSummary {
  account: AccountSummary;
  runtime: RuntimeSummary;
}
export type CollectionAvailability = 'unavailable' | 'loading' | 'loaded';
export interface DesktopSettings {
  workspacePath: string;
  codexPath: string;
  pdfRendererPath?: string;
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
export interface DesktopCollectionSnapshot {
  approvals: ApprovalSummary[];
  memories: MemorySummary[];
  availability: {
    approvals: CollectionAvailability;
    memories: CollectionAvailability;
  };
}
export interface PendingTaskInteraction {
  requestId: number | string;
  kind: 'command_approval' | 'file_change_approval' | 'user_input';
  params: unknown;
}
export interface TaskSummary {
  id: string;
  prompt: string;
  status: 'queued' | 'running' | 'waiting_for_approval' | 'waiting_for_input' | 'completed' |
    'cancelled' | 'failed' | 'interrupted' | 'recovering' | 'ready';
  transcript: Array<{ role: 'user' | 'assistant'; text: string }>;
  usage: string;
  pendingInteraction: PendingTaskInteraction | null;
  error: string | null;
  recoverable: boolean;
}
export interface RegenerateResult { status: string; selectedSlide: number }
export interface ApprovalResult {
  status: string;
  nextSlide: number;
  stage?: string;
  exportReady?: boolean;
}
export interface CreateProjectInput { name: string; goal: string }
export interface SourceFileInput { fileName: string; mediaType: string; contentsBase64: string }

export interface DesktopAdapter {
  readonly mode: DesktopAdapterMode;
  readonly initialState: DesktopInitialState;
  loadInitialState(): Promise<DesktopInitialState>;
  listProjects(): Promise<ProjectSummary[]>;
  loadCollections?(): Promise<DesktopCollectionSnapshot>;
  connectAccount(): Promise<AccountSummary>;
  subscribeConnection(listener: (state: ConnectionSummary) => void): () => void;
  startLogin(): Promise<{ message: string; authUrl: string }>;
  startTask(prompt: string): Promise<TaskSummary>;
  cancelTask(taskId: string): Promise<TaskSummary>;
  recoverTask(taskId: string): Promise<TaskSummary>;
  subscribeTask(taskId: string, listener: (task: TaskSummary) => void): () => void;
  respondToTask(taskId: string, decision: 'approve' | 'decline'): Promise<{ status: string }>;
  respondToTaskInput(taskId: string, answers: Record<string, string[]>): Promise<{ status: string }>;
  createProject(input: CreateProjectInput): Promise<ProjectSummary>;
  loadProjectPipeline(projectId: string): Promise<NativePptPipeline>;
  getProjectGeneration(projectId: string): ProjectGeneration | null;
  subscribeProjectGeneration(projectId: string, listener: (state: ProjectGeneration | null) => void): () => void;
  getProjectEdit(projectId: string): ProjectEdit | null;
  retryProjectEdit(projectId: string): Promise<NativePptPipeline>;
  subscribeProjectEdit(projectId: string, listener: (state: ProjectEdit | null) => void): () => void;
  attachSource(projectId: string, input: SourceFileInput): Promise<NativePptPipeline>;
  saveProjectContext(projectId: string, context: NativePromptContext): Promise<NativePptPipeline>;
  analyzeProject(projectId: string): Promise<NativePptPipeline>;
  generateOutline(projectId: string): Promise<NativePptPipeline>;
  saveOutline(projectId: string, outline: PptOutline): Promise<NativePptPipeline>;
  approveOutline(projectId: string): Promise<NativePptPipeline>;
  generateDetails(projectId: string): Promise<NativePptPipeline>;
  saveDetails(projectId: string, specs: readonly SlideSpec[], expectedRevision: number): Promise<NativePptPipeline>;
  approveDetails(projectId: string, expectedRevision: number): Promise<NativePptPipeline>;
  saveOutlineRevision(projectId: string, draft: NativeOutlineRevisionDraft, expectedRevision: number): Promise<NativePptPipeline>;
  approveOutlineRevision(projectId: string, revisionId: string, baseOutlineVersionId: string, expectedRevision: number): Promise<NativePptPipeline>;
  cancelOutlineRevision(projectId: string, revisionId: string, baseOutlineVersionId: string, expectedRevision: number): Promise<NativePptPipeline>;
  requestVisual(projectId: string, slideId: string, feedback?: string): Promise<NativePptPipeline>;
  readProjectVisual(projectId: string, relativePath: string): Promise<string>;
  replaceVisual(projectId: string, slideId: string, imageBase64: string, altText: string): Promise<NativePptPipeline>;
  approveVisual(projectId: string, slideId: string): Promise<NativePptPipeline>;
  reopenVisual(projectId: string, slideId: string): Promise<NativePptPipeline>;
  runProjectQa(projectId: string): Promise<NativePptPipeline>;
  proposeProjectMemory(projectId: string): Promise<{ status: string }>;
  renameProject(projectId: string, name: string): Promise<{ status: string }>;
  regenerateSlide(projectId: string, slide: number, comment: string): Promise<RegenerateResult>;
  approveSlide(projectId: string, slide: number, comment: string): Promise<ApprovalResult>;
  reopenSlide(projectId: string, slide: number): Promise<{ status: string }>;
  exportProject(projectId: string, name: string): Promise<{ message: string }>;
  decideApproval(approvalId: string, decision: 'approved' | 'rejected'): Promise<{ status: string }>;
  decideMemory(proposalId: string, decision: 'approved' | 'rejected'): Promise<{ status: string }>;
  saveSettings(input: { workspacePath: string; codexPath: string; pdfRendererPath?: string }): Promise<{ status: string }>;
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
    pdfRendererPath: '',
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
  settings: { workspacePath: '', codexPath: '', pdfRendererPath: '' },
};

export function createDemoDesktopAdapter(options: DemoAdapterOptions = {}): DesktopAdapter {
  let counter = 1;
  const initialState = structuredClone(demoInitialState);
  const tasks = new Map<string, TaskSummary>();
  const generations = new ProjectGenerationRegistry();
  const listeners = new Map<string, Set<(task: TaskSummary) => void>>();
  const connectionListeners = new Set<(state: ConnectionSummary) => void>();
  const demoConnection = () => structuredClone({ account: initialState.account, runtime: initialState.runtime });
  const delay = async (key: keyof NonNullable<DemoAdapterOptions['delays']>) => {
    const milliseconds = options.delays?.[key] ?? 0;
    if (milliseconds > 0) await new Promise((resolve) => window.setTimeout(resolve, milliseconds));
  };
  return {
    mode: 'demo',
    initialState,
    async loadInitialState() { return structuredClone(initialState); },
    async listProjects() { return structuredClone(initialState.projects); },
    async connectAccount() {
      for (const listener of connectionListeners) listener(demoConnection());
      return structuredClone(initialState.account);
    },
    subscribeConnection(listener) {
      connectionListeners.add(listener);
      listener(demoConnection());
      return () => { connectionListeners.delete(listener); };
    },
    async startLogin() {
      return { message: '演示数据：浏览器登录流程已准备好。', authUrl: 'https://chatgpt.com/' };
    },
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
        recoverable: false,
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
    async cancelTask(taskId) {
      const task = tasks.get(taskId);
      if (!task) throw new Error('Task does not exist');
      task.status = 'cancelled';
      task.recoverable = false;
      return cloneTask(task);
    },
    async recoverTask(taskId) {
      const task = tasks.get(taskId);
      if (!task?.recoverable) throw new Error('Task is not recoverable');
      task.status = 'ready';
      task.recoverable = false;
      task.error = null;
      return cloneTask(task);
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
    async loadProjectPipeline() { throw new Error('演示模式不使用本地持久化 PPT 管线。'); },
    getProjectGeneration: (projectId) => generations.get(projectId),
    subscribeProjectGeneration: (projectId, listener) => generations.subscribe(projectId, listener),
    getProjectEdit: () => null,
    async retryProjectEdit() { throw new Error('演示模式没有待核实编辑操作。'); },
    subscribeProjectEdit: (_projectId, listener) => { listener(null); return () => {}; },
    async attachSource() { throw new Error('演示模式不会写入本地材料。'); },
    async saveProjectContext() { throw new Error('演示模式不会保存项目说明。'); },
    async analyzeProject() { throw new Error('演示模式不会消耗 Codex 任务。'); },
    async generateOutline() { throw new Error('演示模式不会消耗 Codex 任务。'); },
    async saveOutline() { throw new Error('演示模式不会保存生产大纲。'); },
    async approveOutline() { throw new Error('演示模式不会保存生产审批。'); },
    async generateDetails() { throw new Error('演示模式不会消耗 Codex 任务。'); },
    async saveDetails() { throw new Error('演示模式不会保存生产细化。'); },
    async approveDetails() { throw new Error('演示模式不会保存生产审批。'); },
    async saveOutlineRevision() { throw new Error('演示模式不会保存生产修订。'); },
    async approveOutlineRevision() { throw new Error('演示模式不会批准生产修订。'); },
    async cancelOutlineRevision() { throw new Error('演示模式不会取消生产修订。'); },
    async requestVisual() { throw new Error('演示模式不会请求 ImageGen。'); },
    async readProjectVisual() { throw new Error('演示模式没有生产视觉文件。'); },
    async replaceVisual() { throw new Error('演示模式不会写入视觉文件。'); },
    async approveVisual() { throw new Error('演示模式不会保存生产审批。'); },
    async reopenVisual() { throw new Error('演示模式不会改动生产版本。'); },
    async runProjectQa() { throw new Error('演示模式不会伪造 LibreOffice QA。'); },
    async proposeProjectMemory() { throw new Error('演示模式不会创建生产偏好建议。'); },
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
const VISUAL_ACCOUNT_CHECK_TIMEOUT_MS = 30_000;

class TauriDesktopAdapter implements DesktopAdapter {
  readonly mode = 'tauri' as const;
  readonly initialState = structuredClone(nativeInitialState);
  private readonly client: CodexAppServerClient;
  private readonly imageTurns: CodexImageTurnRunner;
  private readonly tasks: GeneralTaskManager;
  private readonly generations = new ProjectGenerationRegistry();
  private readonly edits = new ProjectEditRegistry((id) => this.generations.get(id)?.status !== 'running');
  private readonly uncertainEdits = new Map<string, { identity: ProjectEditIdentity; action: NativePipelineAction; pipeline: NativePptPipeline }>();
  private readonly taskIds = new Set<string>();
  private readonly taskPrompts = new Map<string, string>();
  private readonly listeners = new Map<string, Set<(task: TaskSummary) => void>>();
  private readonly connectionListeners = new Set<(state: ConnectionSummary) => void>();
  private connection: ConnectionSummary = {
    account: structuredClone(nativeInitialState.account),
    runtime: structuredClone(nativeInitialState.runtime),
  };
  private connectionGeneration = 0;
  private accountRevision = 0;
  private serviceConnected = false;
  private taskCounter = 1;
  private codexPath = '';

  constructor(
    private readonly transport: NativeAppServerTransport,
    private readonly nativeInvoke: NativeCommandInvoker,
    private readonly worker: WorkflowWorkerGateway,
  ) {
    this.client = new CodexAppServerClient(transport);
    this.imageTurns = new CodexImageTurnRunner(this.client);
    this.tasks = new GeneralTaskManager(this.client);
    this.client.onServerMessage((message) => {
      const params = asRecord(message.params);
      if (message.method === 'account/updated' && params) {
        if (params.authMode === 'chatgpt') {
          void this.connectAccount().catch(() => {});
        } else {
          this.accountRevision += 1;
          this.publishConnection({
            email: null, plan: null,
            status: params.authMode == null ? 'logged_out' : 'unavailable',
          });
        }
      } else if (message.method === 'account/login/completed' && params?.success === true) {
        void this.connectAccount().catch(() => {});
      }
      const threadId = typeof params?.threadId === 'string' ? params.threadId : null;
      if (threadId) this.publishThread(threadId);
    });
    this.client.onExit(() => {
      this.invalidateConnection('本机 Codex App Server 已断开，请重新检测连接。');
      this.publishAll();
    });
  }

  async loadInitialState(): Promise<DesktopInitialState> {
    await this.worker.health();
    const state = await this.callNative<DesktopInitialState>('load_desktop_state', undefined);
    this.codexPath = state.settings.codexPath;
    if (this.transport instanceof TauriCodexTransport) {
      await this.transport.setConfiguredPath(state.settings.codexPath);
    }
    return state;
  }

  async listProjects(): Promise<ProjectSummary[]> {
    // A list refresh only reads SQLite. It must not reconnect Codex, restart
    // the Worker, or overwrite the live account/settings with startup defaults.
    const state = await this.callNative<DesktopInitialState>('load_desktop_state', undefined);
    return state.projects;
  }

  async loadCollections(): Promise<DesktopCollectionSnapshot> {
    // Collection refresh is intentionally a read-only native boundary. Loading
    // a pipeline through loadProjectPipeline would also restore Worker state.
    const state = await this.callNative<DesktopInitialState>('load_desktop_state', undefined);
    const pipelines = await Promise.all(state.projects.map(({ id }) =>
      this.callNative<NativePptPipeline>('ppt_load_pipeline', { projectId: id })));
    return {
      approvals: derivePendingPptApprovals(pipelines),
      memories: structuredClone(state.memories),
      availability: { approvals: 'loaded', memories: state.collections.memories },
    };
  }

  async connectAccount(): Promise<AccountSummary> {
    const generation = this.connectionGeneration;
    const revision = ++this.accountRevision;
    try {
      await this.connectService();
      if (generation !== this.connectionGeneration || revision !== this.accountRevision) {
        throw new Error('ChatGPT 账号检测已失效，请重新检测连接。');
      }
      const account = await this.client.readAccount();
      // Logout, account changes, exits, and newer reads supersede an in-flight response.
      if (generation !== this.connectionGeneration || revision !== this.accountRevision) {
        throw new Error('ChatGPT 账号检测已失效，请重新检测连接。');
      }
      this.publishConnection(account?.planType.trim()
        ? { email: account.email, plan: account.planType, status: 'connected' }
        : {
            email: null, plan: null,
            status: this.client.getAuthState().status === 'logged_out' ? 'logged_out' : 'unavailable',
          });
      return structuredClone(this.connection.account);
    } catch (error) {
      if (generation === this.connectionGeneration && revision === this.accountRevision) {
        this.invalidateConnection(`无法读取本机 Codex 连接：${error instanceof Error ? error.message : String(error)}`);
      }
      throw error;
    }
  }
  subscribeConnection(listener: (state: ConnectionSummary) => void): () => void {
    this.connectionListeners.add(listener);
    listener(structuredClone(this.connection));
    return () => { this.connectionListeners.delete(listener); };
  }
  async startLogin(): Promise<{ message: string; authUrl: string }> {
    await this.connectService();
    const response = await this.client.startChatGptLogin();
    const url = new URL(response.authUrl);
    if (url.protocol !== 'https:') throw new Error('Codex 返回了不安全的 ChatGPT 登录地址。');
    return { message: '已发起登录，请在浏览器中继续。', authUrl: url.toString() };
  }
  async startTask(prompt: string): Promise<TaskSummary> {
    await this.requireActiveChatGptAccount();
    const cwd = await this.callNative<string>('workspace_directory');
    if (!isCanonicalAbsolutePath(cwd)) {
      throw new Error('没有可用的 Rust 验证绝对工作区；请先在设置中选择合法工作区。');
    }
    const id = `desktop-task-${this.taskCounter++}`;
    const task = await this.tasks.startTask({ id, cwd, prompt, createdAt: new Date().toISOString() });
    this.taskIds.add(id);
    this.taskPrompts.set(id, prompt);
    return this.toTaskSummary(task);
  }
  async cancelTask(taskId: string): Promise<TaskSummary> {
    await this.tasks.cancelTask(taskId);
    this.publish(taskId);
    return this.toTaskSummary(this.requireTask(taskId));
  }
  async recoverTask(taskId: string): Promise<TaskSummary> {
    await this.tasks.recoverTask(taskId);
    this.publish(taskId);
    await this.connectAccount();
    return this.toTaskSummary(this.requireTask(taskId));
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
  async loadProjectPipeline(projectId: string): Promise<NativePptPipeline> {
    const pipeline = await this.callNative<NativePptPipeline>('ppt_load_pipeline', { projectId });
    await this.worker.restoreProject(pipeline);
    return pipeline;
  }
  getProjectGeneration(projectId: string): ProjectGeneration | null { return this.generations.get(projectId); }
  subscribeProjectGeneration(projectId: string, listener: (state: ProjectGeneration | null) => void): () => void {
    return this.generations.subscribe(projectId, listener);
  }
  getProjectEdit(projectId: string): ProjectEdit | null { return this.edits.get(projectId); }
  retryProjectEdit(projectId: string): Promise<NativePptPipeline> {
    const pending = this.uncertainEdits.get(projectId);
    if (!pending) return Promise.reject(new Error('没有待核实的编辑提交，请重新载入检查点。'));
    return this.runEdit(projectId, pending.identity, pending.action);
  }
  subscribeProjectEdit(projectId: string, listener: (state: ProjectEdit | null) => void): () => void {
    return this.edits.subscribe(projectId, listener);
  }
  async attachSource(projectId: string, input: SourceFileInput): Promise<NativePptPipeline> {
    const pipeline = await this.callNative<NativePptPipeline>('ppt_attach_source', {
      input: { projectId, ...input },
    });
    await this.worker.restoreProject(pipeline);
    return pipeline;
  }
  analyzeProject(projectId: string): Promise<NativePptPipeline> {
    if (this.editBlocksGeneration(projectId)) return Promise.reject(new Error('当前项目已有编辑操作，请等待保存或核实结果后再生成。'));
    return this.generations.run(projectId, 'analysis', async () => {
      const pipeline = await this.loadProjectPipeline(projectId);
      if (pipeline.project.workflowStatus !== 'intake' || pipeline.sources.length === 0) {
        throw new Error('请先附加材料；重新分析前请保存本次说明并确认返回材料阶段。');
      }
      const output = await this.runStructured<SourceAnalysis>(projectId, buildPptPrompt(pipeline, 'analysis'));
      return this.applyPipeline(projectId, pipeline, {
        kind: 'analysis.commit', at: new Date().toISOString(),
        requestId: `analysis-${pipeline.revision + 1}`, output,
      });
    });
  }
  async saveProjectContext(projectId: string, context: NativePromptContext): Promise<NativePptPipeline> {
    const pipeline = await this.loadProjectPipeline(projectId);
    const error = promptContextError(pipeline, context);
    if (error) throw new Error(error);
    return this.applyPipeline(projectId, pipeline, {
      kind: 'context.update', at: new Date().toISOString(), context,
    });
  }
  async saveOutline(projectId: string, outline: PptOutline): Promise<NativePptPipeline> {
    return this.applyCurrent(projectId, { kind: 'outline.submit', at: new Date().toISOString(), outline });
  }
  generateOutline(projectId: string): Promise<NativePptPipeline> {
    if (this.editBlocksGeneration(projectId)) return Promise.reject(new Error('当前项目已有编辑操作，请等待保存或核实结果后再生成。'));
    return this.generations.run(projectId, 'outline', async () => {
      const pipeline = await this.loadProjectPipeline(projectId);
      if (!pipeline.analysis || pipeline.project.workflowStatus !== 'source_analysis') {
        throw new Error('请先完成材料分析；已有大纲请先审核，或修改说明后重新生成。');
      }
      const outline = await this.runStructured<PptOutline>(projectId, buildPptPrompt(pipeline, 'outline'));
      return this.applyPipeline(projectId, pipeline, { kind: 'outline.submit', at: new Date().toISOString(), outline });
    });
  }
  async approveOutline(projectId: string): Promise<NativePptPipeline> {
    return this.applyCurrent(projectId, { kind: 'outline.approve', at: new Date().toISOString() });
  }
  saveDetails(projectId: string, specs: readonly SlideSpec[], expectedRevision: number): Promise<NativePptPipeline> {
    return this.runEdit(projectId, { kind: 'details.save', expectedRevision, payloadKey: JSON.stringify(specs) },
      { kind: 'details.submit', at: new Date().toISOString(), specs, expectedRevision });
  }
  saveOutlineRevision(projectId: string, draft: NativeOutlineRevisionDraft, expectedRevision: number): Promise<NativePptPipeline> {
    const { id: revisionId, baseOutlineVersionId, outline, specs } = draft;
    return this.runEdit(projectId, { kind: 'outline.revision.save', expectedRevision, revisionId, baseOutlineVersionId,
      payloadKey: JSON.stringify({ outline, specs }) },
    { kind: 'outline.revision.save', at: new Date().toISOString(), expectedRevision, revisionId, baseOutlineVersionId, outline, specs });
  }
  approveOutlineRevision(projectId: string, revisionId: string, baseOutlineVersionId: string, expectedRevision: number): Promise<NativePptPipeline> {
    const identity = { kind: 'outline.revision.approve' as const, expectedRevision, revisionId, baseOutlineVersionId };
    return this.runEdit(projectId, identity, { ...identity, at: new Date().toISOString() });
  }
  cancelOutlineRevision(projectId: string, revisionId: string, baseOutlineVersionId: string, expectedRevision: number): Promise<NativePptPipeline> {
    const identity = { kind: 'outline.revision.cancel' as const, expectedRevision, revisionId, baseOutlineVersionId };
    return this.runEdit(projectId, identity, { ...identity, at: new Date().toISOString() });
  }
  generateDetails(projectId: string): Promise<NativePptPipeline> {
    if (this.editBlocksGeneration(projectId)) return Promise.reject(new Error('当前项目已有编辑操作，请等待保存或核实结果后再生成。'));
    return this.generations.run(projectId, 'details', async () => {
      const pipeline = await this.loadProjectPipeline(projectId);
      if (pipeline.outline?.version.status !== 'frozen' || pipeline.project.workflowStatus !== 'detail_review') {
        throw new Error('请先批准整份大纲，并在逐页细化阶段生成内容。');
      }
      if (pipeline.slideSpecs) throw new Error('已有逐页细化，请审核或保存修改，不要重复生成。');
      const output = await this.runStructured<unknown>(projectId, buildPptPrompt(pipeline, 'details'));
      const specs = normalizeGeneratedSlideSpecs(output, pipeline.outline.value, pipeline.analysis!.output);
      return this.applyPipeline(projectId, pipeline, { kind: 'details.submit', at: new Date().toISOString(), specs });
    });
  }
  approveDetails(projectId: string, expectedRevision: number): Promise<NativePptPipeline> {
    return this.runEdit(projectId, { kind: 'details.approve', expectedRevision },
      { kind: 'details.approve', at: new Date().toISOString(), expectedRevision });
  }
  requestVisual(projectId: string, slideId: string, feedback?: string): Promise<NativePptPipeline> {
    if (this.editBlocksGeneration(projectId)) {
      return Promise.reject(new Error('当前项目已有编辑操作，请等待保存或核实结果后再生成。'));
    }
    return this.generations.run(projectId, 'visual', async () => {
      const pipeline = await this.callNative<NativePptPipeline>('ppt_load_pipeline', { projectId });
      const recoverableImageGenBlock = pipeline.project.workflowStatus === 'blocked'
        && pipeline.blockedCondition?.kind === 'capability_unavailable'
        && pipeline.blockedCondition.capability === 'image_gen.imagegen'
        && pipeline.blockedCondition.recoverable === true
        && pipeline.blockedCondition.resumeStage === 'visual_review'
        && pipeline.blockedCondition.slideId === slideId;
      if (pipeline.project.workflowStatus !== 'visual_review' && !recoverableImageGenBlock) {
        throw new Error('项目当前不在逐页视觉审核阶段，不能生成视觉。');
      }
      if (pipeline.slideSpecs?.version.status !== 'frozen') {
        throw new Error('逐页规格尚未批准冻结，不能生成视觉。');
      }
      if (pipeline.currentSlideId !== slideId) {
        throw new Error('请求页与当前待审核页不匹配，未启动 ImageGen。');
      }
      const spec = pipeline.slideSpecs.value.find(({ id }) => id === slideId);
      if (!spec) throw new Error('当前页没有已批准的逐页规格，未启动 ImageGen。');
      const operationId = this.generations.get(projectId)?.operationId;
      this.generations.updateVisualContext(projectId, {
        slideId,
        baseRevision: pipeline.revision,
      }, operationId);
      await withTimeout(
        this.requireActiveChatGptAccount(),
        VISUAL_ACCOUNT_CHECK_TIMEOUT_MS,
        '读取 ChatGPT 账号状态超时，未启动 ImageGen。',
      );
      const cwd = await this.callNative<string>('ppt_project_directory', { projectId });
      if (!isCanonicalAbsolutePath(cwd)) throw new Error('Rust 未返回合法的项目绝对路径。');
      const generated = await this.imageTurns.generate({
        cwd,
        prompt: buildPageVisualPrompt({ slideId, spec: structuredClone(spec) }, feedback),
        onProgress: (message) => this.generations.updateProgress(projectId, message, operationId),
      });
      this.generations.updateProgress(projectId, '正在校验并保存视觉候选…', operationId);
      return this.applyGeneratedVisual(projectId, pipeline, {
        kind: 'visual.replace',
        at: new Date().toISOString(),
        slideId,
        imageBase64: generated.imageBase64,
        altText: `ImageGen 生成的“${spec.title}”视觉候选`,
      });
    }, slideId);
  }
  readProjectVisual(projectId: string, relativePath: string): Promise<string> {
    return this.callNative('ppt_read_artifact', { projectId, relativePath });
  }
  async replaceVisual(projectId: string, slideId: string, imageBase64: string, altText: string): Promise<NativePptPipeline> {
    return this.applyCurrent(projectId, { kind: 'visual.replace', at: new Date().toISOString(), slideId, imageBase64, altText });
  }
  async approveVisual(projectId: string, slideId: string): Promise<NativePptPipeline> {
    return this.applyCurrent(projectId, { kind: 'visual.approve', at: new Date().toISOString(), slideId });
  }
  async reopenVisual(projectId: string, slideId: string): Promise<NativePptPipeline> {
    return this.applyCurrent(projectId, { kind: 'visual.reopen', at: new Date().toISOString(), slideId });
  }
  async runProjectQa(projectId: string): Promise<NativePptPipeline> {
    const pipeline = await this.loadProjectPipeline(projectId);
    const preparation = await this.callNative<Extract<NativePipelineAction, { kind: 'deck.qa' }>['preparation']>(
      'ppt_prepare_qa',
      { projectId },
    );
    return this.applyPipeline(projectId, pipeline, {
      kind: 'deck.qa', at: new Date().toISOString(), preparation,
    });
  }
  proposeProjectMemory(projectId: string): Promise<{ status: string }> {
    if (this.editBlocksGeneration(projectId)) return Promise.reject(new Error('当前项目已有编辑操作，请等待保存或核实结果后再生成。'));
    return this.generations.run(projectId, 'memory', async () => {
      const pipeline = await this.loadProjectPipeline(projectId);
      const proposal = await this.runStructured<{ title: string; content: string }>(
        projectId,
        memoryProposalPrompt(pipeline),
      );
      return this.callNative('memory_propose', proposal);
    });
  }
  renameProject(projectId: string, name: string): Promise<{ status: string }> { return this.callNative('ppt_rename_project', { projectId, name }); }
  async regenerateSlide(projectId: string, slide: number, comment: string): Promise<RegenerateResult> {
    const pipeline = await this.loadProjectPipeline(projectId);
    const slideId = pipeline.slideSpecs?.value[slide - 1]?.id;
    if (!slideId) throw new Error('页码与已批准规格不匹配。');
    if (pipeline.currentSlideId !== slideId) throw new Error('页码与当前待审核页不匹配。');
    const next = await this.requestVisual(projectId, slideId, comment);
    return { status: next.blockedCondition?.message ?? '视觉候选已生成。', selectedSlide: slide };
  }
  async approveSlide(projectId: string, slide: number, comment: string): Promise<ApprovalResult> {
    void comment;
    const pipeline = await this.loadProjectPipeline(projectId);
    const slideId = pipeline.slideSpecs?.value[slide - 1]?.id;
    if (!slideId) throw new Error('页码与已批准规格不匹配。');
    const next = await this.applyPipeline(projectId, pipeline, { kind: 'visual.approve', at: new Date().toISOString(), slideId });
    const nextSlide = Math.max(1, (next.slideSpecs?.value.findIndex(({ id }) => id === next.currentSlideId) ?? 0) + 1);
    return { status: next.project.workflowStatus === 'conversion' ? '最后一页已批准，进入可编辑转换。' : `已批准，进入第 ${nextSlide} 页`, nextSlide,
      ...(next.project.workflowStatus === 'conversion' ? { stage: 'conversion', exportReady: true } : {}) };
  }
  async reopenSlide(projectId: string, slide: number): Promise<{ status: string }> {
    const pipeline = await this.loadProjectPipeline(projectId);
    const slideId = pipeline.slideSpecs?.value[slide - 1]?.id;
    if (!slideId) throw new Error('页码与已批准规格不匹配。');
    await this.applyPipeline(projectId, pipeline, { kind: 'visual.reopen', at: new Date().toISOString(), slideId });
    return { status: `第 ${slide} 页已重新打开，等待新候选。` };
  }
  async exportProject(projectId: string, name: string): Promise<{ message: string }> {
    const pipeline = await this.loadProjectPipeline(projectId);
    if (!pipeline.slideSpecs) throw new Error('项目尚无已批准的逐页细化。');
    const visualBytes: Record<string, string> = {};
    for (const [index, spec] of pipeline.slideSpecs.value.entries()) {
      const visual = pipeline.visuals[spec.id]?.at(-1);
      if (!visual) throw new Error(`第 ${index + 1} 页尚无已批准视觉。`);
      visualBytes[spec.id] = await this.callNative<string>('ppt_read_artifact', {
        projectId, relativePath: visual.relativePath,
      });
    }
    const fileName = name.toLowerCase().endsWith('.pptx') ? name : `${name}.pptx`;
    const completed = await this.applyPipeline(projectId, pipeline, {
      kind: 'deck.export', at: new Date().toISOString(), fileName, visualBytes,
    });
    return { message: `已安全导出 ${completed.exportReceipt?.relativePath ?? fileName}，等待 QA。` };
  }
  decideApproval(approvalId: string, decision: 'approved' | 'rejected'): Promise<{ status: string }> { return this.callNative('approval_decide', { approvalId, decision }); }
  decideMemory(proposalId: string, decision: 'approved' | 'rejected'): Promise<{ status: string }> { return this.callNative('memory_decide', { proposalId, decision }); }
  async saveSettings(input: { workspacePath: string; codexPath: string; pdfRendererPath?: string }): Promise<{ status: string }> {
    const result = await this.callNative<{ status: string }>('save_desktop_settings', {
      ...input,
      pdfRendererPath: input.pdfRendererPath ?? '',
    });
    if (this.codexPath.trim() !== input.codexPath.trim()) {
      this.invalidateConnection('Codex 路径已更新，请重新检测连接。');
    }
    this.codexPath = input.codexPath;
    if (this.transport instanceof TauriCodexTransport) await this.transport.setConfiguredPath(input.codexPath);
    return result;
  }

  private editBlocksGeneration(projectId: string): boolean {
    return this.edits.get(projectId)?.status === 'running' || this.uncertainEdits.has(projectId);
  }

  private runEdit(projectId: string, identity: ProjectEditIdentity, action: NativePipelineAction): Promise<NativePptPipeline> {
    const ownedAction = structuredClone(action);
    const previous = this.uncertainEdits.get(projectId);
    if (previous && JSON.stringify(previous.identity) !== JSON.stringify(identity)) {
      return Promise.reject(new Error('上次编辑提交结果尚未核实，请先重试原操作核实检查点。'));
    }
    return this.edits.run(projectId, identity, async () => {
      const uncertain = this.uncertainEdits.get(projectId);
      let current: NativePptPipeline;
      try { current = await this.loadProjectPipeline(projectId); }
      catch (reason) {
        if (uncertain) throw new Error(`提交结果尚未核实，请重试原操作以重新读取检查点。${reason instanceof Error ? reason.message : String(reason)}`);
        throw reason;
      }
      if (uncertain) {
        this.uncertainEdits.delete(projectId);
        if (sameCheckpoint(current, uncertain.pipeline)) return current;
      }
      if (current.revision !== identity.expectedRevision) {
        throw new Error('版本冲突：其他操作已更新项目。你的输入已保留，请明确放弃修改并载入最新版本。');
      }
      const result = await this.worker.executeProject(projectId, ownedAction);
      this.uncertainEdits.set(projectId, { identity: structuredClone(identity), action: ownedAction, pipeline: result.pipeline });
      try {
        const saved = await this.callNative<NativePptPipeline>('ppt_commit_pipeline', {
          input: { projectId, expectedRevision: identity.expectedRevision, pipeline: result.pipeline, writes: result.writes },
        });
        this.uncertainEdits.delete(projectId);
        return saved;
      } catch (reason) {
        let persisted: NativePptPipeline;
        try { persisted = await this.loadProjectPipeline(projectId); }
        catch { throw new Error(`提交结果尚未核实，请重试原操作以重新读取检查点。${reason instanceof Error ? reason.message : String(reason)}`); }
        this.uncertainEdits.delete(projectId);
        if (sameCheckpoint(persisted, result.pipeline)) return persisted;
        if (persisted.revision !== identity.expectedRevision) {
          throw new Error('版本冲突：其他操作已更新项目，当前输入仍保留。请放弃修改并载入最新版本。');
        }
        throw reason;
      }
    });
  }

  private async applyCurrent(projectId: string, action: NativePipelineAction): Promise<NativePptPipeline> {
    const pipeline = await this.loadProjectPipeline(projectId);
    return this.applyPipeline(projectId, pipeline, action);
  }
  private async applyPipeline(projectId: string, current: NativePptPipeline, action: NativePipelineAction): Promise<NativePptPipeline> {
    await this.worker.restoreProject(current);
    const result: NativePipelineResult = await this.worker.executeProject(projectId, action);
    return this.callNative<NativePptPipeline>('ppt_commit_pipeline', {
      input: { projectId, expectedRevision: current.revision, pipeline: result.pipeline, writes: result.writes },
    });
  }
  private async applyGeneratedVisual(
    projectId: string,
    current: NativePptPipeline,
    action: Extract<NativePipelineAction, { kind: 'visual.replace' }>,
  ): Promise<NativePptPipeline> {
    await this.worker.restoreProject(current);
    const result = await this.worker.executeProject(projectId, action);
    try {
      return await this.callNative<NativePptPipeline>('ppt_commit_pipeline', {
        input: { projectId, expectedRevision: current.revision, pipeline: result.pipeline, writes: result.writes },
      });
    } catch (reason) {
      let persisted: NativePptPipeline;
      try { persisted = await this.loadProjectPipeline(projectId); }
      catch {
        throw new Error(`视觉候选保存结果尚未核实；请重新载入项目检查，系统不会自动再次生成。${reason instanceof Error ? reason.message : String(reason)}`);
      }
      if (sameCheckpoint(persisted, result.pipeline)) return persisted;
      if (persisted.revision !== current.revision) {
        throw new Error('版本冲突：其他操作已更新项目；生成的视觉未覆盖新检查点。');
      }
      throw reason;
    }
  }
  private async runStructured<T>(projectId: string, prompt: string): Promise<T> {
    await this.requireActiveChatGptAccount();
    const cwd = await this.callNative<string>('ppt_project_directory', { projectId });
    if (!isCanonicalAbsolutePath(cwd)) throw new Error('Rust 未返回合法的项目绝对路径。');
    const id = `ppt-structured-${this.taskCounter++}`;
    const task = await this.tasks.startTask({ id, cwd, prompt, createdAt: new Date().toISOString() });
    this.taskIds.add(id);
    this.taskPrompts.set(id, prompt);
    const completed = await new Promise<GeneralTask>((resolve, reject) => {
      let stop = () => {};
      let stopExit = () => {};
      const finish = (result: GeneralTask | Error) => {
        stop(); stopExit();
        if (result instanceof Error) reject(result); else resolve(result);
      };
      const inspect = () => {
        const current = this.tasks.getTask(task.id);
        if (!current) return;
        if (current.status === 'completed') finish(current);
        else if (['failed', 'cancelled', 'interrupted'].includes(current.status)) finish(new Error(current.error ?? `Codex 任务未完成：${current.status}`));
      };
      stop = this.client.onServerMessage(() => inspect());
      stopExit = this.client.onExit(() => finish(new Error('Codex App Server 在生成结构化内容时退出。')));
      void Promise.resolve().then(inspect);
    });
    const text = completed.transcript.filter(({ role }) => role === 'assistant').at(-1)?.text;
    if (!text) throw new Error('Codex 没有返回可解析的内容。');
    try { return JSON.parse(text.replace(/^```json\s*|\s*```$/g, '')) as T; }
    catch { throw new Error('Codex 返回的内容不是严格 JSON，项目保持在原检查点。'); }
  }

  private callNative<T>(command: string, args?: Record<string, unknown>): Promise<T> { return this.nativeInvoke(command, args) as Promise<T>; }
  private async connectService(): Promise<void> {
    const generation = this.connectionGeneration;
    try {
      await this.client.connect();
      if (generation !== this.connectionGeneration) throw new Error('Codex 连接已失效，请重新检测连接。');
      this.serviceConnected = true;
      this.publishConnection(this.connection.account);
    } catch (error) {
      if (generation === this.connectionGeneration) {
        this.invalidateConnection(`无法连接本机 Codex：${error instanceof Error ? error.message : String(error)}`);
      }
      throw error;
    }
  }
  private publishConnection(account: AccountSummary): void {
    const detail = account.status === 'connected'
      ? `已连接本机 Codex App Server · ChatGPT ${account.plan}`
      : account.status === 'logged_out'
        ? '已连接本机 Codex App Server，等待 ChatGPT 登录。'
        : '已连接本机 Codex App Server，等待有效的 ChatGPT 账号。';
    this.connection = {
      account: { ...account },
      runtime: this.serviceConnected
        ? { status: 'connected', detail, address: 'stdio（本机进程）', model: null, uptime: null, queue: null }
        : this.connection.runtime,
    };
    for (const listener of this.connectionListeners) listener(structuredClone(this.connection));
  }
  private invalidateConnection(detail: string): void {
    this.connectionGeneration += 1;
    this.accountRevision += 1;
    this.serviceConnected = false;
    this.connection.runtime = { status: 'unavailable', detail, address: null, model: null, uptime: null, queue: null };
    this.publishConnection({ email: null, plan: null, status: 'unavailable' });
  }
  private async requireActiveChatGptAccount(): Promise<void> {
    const account = await this.connectAccount();
    if (account.status !== 'connected') {
      const auth = this.client.getAuthState();
      if (auth.status === 'invalidated' && /apikey/i.test(auth.reason)) {
        throw new Error('API-key authentication is not supported; sign in with an active ChatGPT account.');
      }
      throw new Error('An active ChatGPT login is required before starting a model task.');
    }
  }
  private requireTask(taskId: string): GeneralTask {
    const task = this.tasks.getTask(taskId);
    if (!task) throw new Error('Task does not exist');
    return task;
  }
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
    return {
      id: task.id,
      prompt: this.taskPrompts.get(task.id) ?? task.transcript[0]?.text ?? '',
      status: task.status,
      transcript: task.transcript.map(({ role, text }) => ({ role, text })),
      usage: formatUsage(task.tokenUsage),
      pendingInteraction: task.pendingInteraction ? { ...task.pendingInteraction } : null,
      error: task.error,
      recoverable: task.recoverable,
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

function memoryProposalPrompt(pipeline: NativePptPipeline): string {
  const approvedVisuals = Object.values(pipeline.visuals).flatMap((versions) => versions
    .filter(({ version }) => version.status === 'frozen')
    .map(({ slideId, version, relativePath, usage, textFree, altText }) => ({
      slideId, versionId: version.id, approvedAt: version.frozenAt,
      relativePath, usage, textFree, altText,
    })));
  const approvedSnapshot = {
    project: {
      id: pipeline.project.id,
      name: pipeline.project.name,
      goal: pipeline.project.goal,
      workflowStatus: pipeline.project.workflowStatus,
      revision: pipeline.revision,
    },
    savedInstructions: pipeline.promptContext ?? null,
    approvedOutline: pipeline.outline?.version.status === 'frozen' ? pipeline.outline : null,
    approvedSlideSpecs: pipeline.slideSpecs?.version.status === 'frozen' ? pipeline.slideSpecs : null,
    approvedVisuals,
    approvedDecisions: pipeline.approvals.filter(({ status }) => status === 'approved'),
    passedQa: pipeline.qaReport?.status === 'passed' ? pipeline.qaReport : null,
  };
  return [
    '根据下方由 Rust 加载的真实 PPT 项目检查点，提议一条未来可复用的工作偏好。',
    '只根据明确批准或冻结的内容归纳工作方式；不要把项目事实、指标或专有名称写成长期偏好。',
    '只返回严格 JSON：{title,content}。不要 Markdown。',
    '这只是建议，必须由用户后续明确批准，不要声称已保存为记忆。',
    JSON.stringify(approvedSnapshot, null, 2),
  ].join('\n');
}

// Rust JSON objects may return keys in a different order. Arrays, strings and
// numeric values must still match exactly before acknowledging a lost response.
function sameCheckpoint(left: NativePptPipeline, right: NativePptPipeline): boolean {
  const canonical = (value: NativePptPipeline) => JSON.stringify(value, (_key, entry: unknown) =>
    entry !== null && typeof entry === 'object' && !Array.isArray(entry)
      ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)))
      : entry);
  return canonical(left) === canonical(right);
}

function cloneTask(task: TaskSummary): TaskSummary { return structuredClone(task); }
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null;
}

function isCanonicalAbsolutePath(value: string): boolean {
  return value.startsWith('/') && !value.includes('\0') && !value.split('/').includes('..');
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try { return await Promise.race([operation, timeout]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
