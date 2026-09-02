import { invoke } from '@tauri-apps/api/core';
import { TauriCodexTransport } from './codex-transport.js';

export type DesktopAdapterMode = 'demo' | 'tauri';

export interface AccountSummary {
  email: string | null;
  plan: string | null;
  status: 'connected' | 'logged_out' | 'unavailable';
}

export interface ProjectSummary {
  id: string;
  name: string;
  stage: string;
  progress: number;
  updatedAt: string;
}

export interface TaskSummary {
  id: string;
  prompt: string;
  status:
    | 'running'
    | 'waiting_for_approval'
    | 'waiting_for_input'
    | 'completed'
    | 'failed';
  transcript: Array<{ role: 'user' | 'assistant'; text: string }>;
  usage: string;
}

export interface RegenerateResult {
  status: string;
  selectedSlide: number;
}

export interface ApprovalResult {
  status: string;
  nextSlide: number;
}

export interface DesktopAdapter {
  readonly mode: DesktopAdapterMode;
  connectAccount(): Promise<AccountSummary>;
  startLogin(): Promise<{ message: string }>;
  startTask(prompt: string): Promise<TaskSummary>;
  respondToTask(decision: 'approve' | 'decline'): Promise<{ status: string }>;
  createProject(name: string): Promise<ProjectSummary>;
  regenerateSlide(
    projectId: string,
    slide: number,
    comment: string,
  ): Promise<RegenerateResult>;
  approveSlide(
    projectId: string,
    slide: number,
    comment: string,
  ): Promise<ApprovalResult>;
  reopenSlide(projectId: string, slide: number): Promise<{ status: string }>;
  exportProject(projectId: string, name: string): Promise<{ message: string }>;
  decideMemory(
    proposalId: string,
    decision: 'approved' | 'rejected',
  ): Promise<{ status: string }>;
  saveSettings(input: {
    workspacePath: string;
    codexPath: string;
  }): Promise<{ status: string }>;
}

export interface DemoAdapterOptions {
  createProjectError?: string;
}

export function createDemoDesktopAdapter(
  options: DemoAdapterOptions = {},
): DesktopAdapter {
  let counter = 1;

  return {
    mode: 'demo',
    async connectAccount() {
      return {
        email: 'demo@workbench.local',
        plan: 'Plus',
        status: 'connected',
      };
    },
    async startLogin() {
      return { message: '演示数据：浏览器登录流程已准备好。' };
    },
    async startTask(prompt) {
      return {
        id: `demo-task-${counter++}`,
        prompt,
        status: 'waiting_for_approval',
        transcript: [
          { role: 'user', text: prompt },
          {
            role: 'assistant',
            text: '我已分析任务范围，准备写入项目说明，等待你的批准。',
          },
        ],
        usage: '2.6K / 5.0K tokens',
      };
    },
    async respondToTask(decision) {
      return {
        status:
          decision === 'approve'
            ? '已批准，Codex 正在继续执行。'
            : '已拒绝，任务保持为草稿。',
      };
    },
    async createProject(name) {
      if (options.createProjectError)
        throw new Error(options.createProjectError);
      return {
        id: `ppt-demo-${counter++}`,
        name,
        stage: '材料',
        progress: 10,
        updatedAt: '刚刚',
      };
    },
    async regenerateSlide(_projectId, slide) {
      return { status: '已生成候选版本', selectedSlide: slide };
    },
    async approveSlide(_projectId, slide) {
      return { status: `已批准，进入第 ${slide + 1} 页`, nextSlide: slide + 1 };
    },
    async reopenSlide(_projectId, slide) {
      return { status: `第 ${slide} 页已重新打开，等待修改。` };
    },
    async exportProject(_projectId, name) {
      return { message: `演示数据：已准备好“${name}.pptx”导出。` };
    },
    async decideMemory(_proposalId, decision) {
      return { status: decision === 'approved' ? '已批准' : '已拒绝' };
    },
    async saveSettings() {
      return { status: '演示数据：设置已保存在当前浏览器会话。' };
    },
  };
}

interface JsonRpcMessage {
  id?: number;
  result?: unknown;
  error?: { message?: string };
}

class TauriAppServerSession {
  private readonly transport = new TauriCodexTransport(null);
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (reason: Error) => void }
  >();
  private nextId = 1;
  private started = false;
  private unlisten: (() => void) | null = null;

  async connect(): Promise<void> {
    if (this.started) return;
    this.unlisten = this.transport.onLine((line) => this.receive(line));
    await this.transport.start();
    await this.request('initialize', {
      clientInfo: {
        name: 'digital-twin-workbench',
        title: 'Digital Twin Workbench',
        version: '0.1.0',
      },
      capabilities: { experimentalApi: false, requestAttestation: false },
    });
    await this.transport.send(JSON.stringify({ method: 'initialized' }));
    this.started = true;
  }

  async request<T>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<T> {
    const id = this.nextId++;
    const response = new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
    });
    await this.transport.send(JSON.stringify({ id, method, params }));
    return response;
  }

  async respond(id: number, result: unknown): Promise<void> {
    await this.transport.send(JSON.stringify({ id, result }));
  }

  dispose(): void {
    this.unlisten?.();
    this.unlisten = null;
    for (const pending of this.pending.values())
      pending.reject(new Error('Codex App Server connection closed'));
    this.pending.clear();
    void this.transport.dispose();
  }

  private receive(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return;
    }
    if (message.id === undefined) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error)
      pending.reject(
        new Error(message.error.message ?? 'Codex App Server request failed'),
      );
    else pending.resolve(message.result);
  }
}

class TauriDesktopAdapter implements DesktopAdapter {
  readonly mode = 'tauri' as const;
  private readonly session = new TauriAppServerSession();

  async connectAccount(): Promise<AccountSummary> {
    await this.session.connect();
    const response = await this.session.request<{
      account: {
        type?: string;
        email?: string | null;
        planType?: string;
      } | null;
    }>('account/read', {
      refreshToken: false,
    });
    if (response.account?.type === 'chatgpt') {
      return {
        email: response.account.email ?? null,
        plan: response.account.planType ?? null,
        status: 'connected',
      };
    }
    return { email: null, plan: null, status: 'logged_out' };
  }

  async startLogin(): Promise<{ message: string }> {
    await this.session.connect();
    const response = await this.session.request<{ authUrl?: string }>(
      'account/login/start',
      {
        type: 'chatgpt',
        useHostedLoginSuccessPage: true,
        appBrand: 'chatgpt',
      },
    );
    return {
      message: response.authUrl
        ? `已发起登录，请在浏览器中继续：${response.authUrl}`
        : '已发起 Codex 登录流程。',
    };
  }

  async startTask(prompt: string): Promise<TaskSummary> {
    await this.session.connect();
    const thread = await this.session.request<{ thread: { id: string } }>(
      'thread/start',
      {
        cwd: '.',
        approvalPolicy: 'on-request',
        sandbox: 'workspace-write',
      },
    );
    await this.session.request<{ turn: { id: string } }>('turn/start', {
      threadId: thread.thread.id,
      input: [{ type: 'text', text: prompt, text_elements: [] }],
    });
    return {
      id: thread.thread.id,
      prompt,
      status: 'running',
      transcript: [
        { role: 'user', text: prompt },
        { role: 'assistant', text: '任务已发送至本地 Codex App Server。' },
      ],
      usage: '等待 App Server 使用量更新',
    };
  }

  async respondToTask(
    decision: 'approve' | 'decline',
  ): Promise<{ status: string }> {
    await this.session.respond(0, { decision });
    return { status: '已将任务决定发送到 Codex App Server。' };
  }

  async createProject(name: string): Promise<ProjectSummary> {
    return this.callPptCommand('ppt_create_project', { name });
  }

  async regenerateSlide(
    projectId: string,
    slide: number,
    comment: string,
  ): Promise<RegenerateResult> {
    return this.callPptCommand('ppt_regenerate_slide', {
      projectId,
      slide,
      comment,
    });
  }

  async approveSlide(
    projectId: string,
    slide: number,
    comment: string,
  ): Promise<ApprovalResult> {
    return this.callPptCommand('ppt_approve_slide', {
      projectId,
      slide,
      comment,
    });
  }

  async reopenSlide(
    projectId: string,
    slide: number,
  ): Promise<{ status: string }> {
    return this.callPptCommand('ppt_reopen_slide', { projectId, slide });
  }

  async exportProject(
    projectId: string,
    name: string,
  ): Promise<{ message: string }> {
    return this.callPptCommand('ppt_export_project', { projectId, name });
  }

  async decideMemory(
    proposalId: string,
    decision: 'approved' | 'rejected',
  ): Promise<{ status: string }> {
    return this.callPptCommand('memory_decide', { proposalId, decision });
  }

  async saveSettings(input: {
    workspacePath: string;
    codexPath: string;
  }): Promise<{ status: string }> {
    return this.callPptCommand('save_desktop_settings', input);
  }

  private callPptCommand<T>(
    command: string,
    args: Record<string, unknown>,
  ): Promise<T> {
    return invoke<T>(command, args);
  }
}

export function createDesktopAdapter(): DesktopAdapter {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
    ? new TauriDesktopAdapter()
    : createDemoDesktopAdapter();
}
