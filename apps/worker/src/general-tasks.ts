import {
  CodexAppServerClient,
  type AppServerExit,
  type JsonRpcId,
  type JsonRpcMessage,
} from './app-server.js';

export type GeneralTaskStatus =
  | 'queued'
  | 'running'
  | 'waiting_for_approval'
  | 'waiting_for_input'
  | 'completed'
  | 'cancelled'
  | 'failed'
  | 'interrupted'
  | 'recovering'
  | 'ready';

export interface TranscriptItem {
  id: string;
  role: 'user' | 'assistant';
  text: string;
}

export interface PendingInteraction {
  requestId: JsonRpcId;
  kind: 'command_approval' | 'file_change_approval' | 'user_input';
  params: unknown;
}

export interface GeneralTask {
  id: string;
  cwd: string;
  threadId: string | null;
  turnId: string | null;
  status: GeneralTaskStatus;
  transcript: TranscriptItem[];
  tokenUsage: Record<string, unknown> | null;
  pendingInteraction: PendingInteraction | null;
  error: string | null;
  recoverable: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface StartGeneralTask {
  id: string;
  cwd: string;
  prompt: string;
  createdAt: string;
}

type RateLimitSnapshot = Record<string, unknown>;
type ApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel';

export class GeneralTaskManager {
  private readonly tasks = new Map<string, GeneralTask>();
  private rateLimits: RateLimitSnapshot | null = null;

  constructor(private readonly client: CodexAppServerClient) {
    client.onServerMessage((message) => this.receiveServerMessage(message));
    client.onExit((detail) => this.receiveExit(detail));
  }

  async startTask(input: StartGeneralTask): Promise<GeneralTask> {
    const task: GeneralTask = {
      id: input.id,
      cwd: input.cwd,
      threadId: null,
      turnId: null,
      status: 'queued',
      transcript: [{ id: `user-${input.id}`, role: 'user', text: input.prompt }],
      tokenUsage: null,
      pendingInteraction: null,
      error: null,
      recoverable: false,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    };
    this.tasks.set(task.id, task);

    try {
      task.threadId = await this.client.startThread(task.cwd);
      task.turnId = await this.client.startTurn(task.threadId, input.prompt);
      task.status = 'running';
      return this.copyTask(task);
    } catch (error) {
      task.status = 'failed';
      task.error = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  async cancelTask(taskId: string): Promise<void> {
    const task = this.requireTask(taskId);
    if (!task.threadId || !task.turnId) {
      throw new Error('Task has no active Codex turn');
    }

    await this.client.interruptTurn(task.threadId, task.turnId);
    task.status = 'cancelled';
    task.pendingInteraction = null;
  }

  async respondToApproval(taskId: string, decision: ApprovalDecision): Promise<void> {
    const task = this.requireTask(taskId);
    const interaction = task.pendingInteraction;
    if (!interaction || interaction.kind === 'user_input') {
      throw new Error('Task is not waiting for an approval');
    }

    await this.client.respond(interaction.requestId, { decision });
    task.pendingInteraction = null;
    task.status = 'running';
  }

  async respondToUserInput(
    taskId: string,
    answers: Record<string, string[]>,
  ): Promise<void> {
    const task = this.requireTask(taskId);
    const interaction = task.pendingInteraction;
    if (!interaction || interaction.kind !== 'user_input') {
      throw new Error('Task is not waiting for user input');
    }

    const protocolAnswers = Object.fromEntries(
      Object.entries(answers).map(([questionId, values]) => [questionId, { answers: values }]),
    );
    await this.client.respond(interaction.requestId, { answers: protocolAnswers });
    task.pendingInteraction = null;
    task.status = 'running';
  }

  async recoverTask(taskId: string): Promise<void> {
    const task = this.requireTask(taskId);
    if (!task.recoverable || !task.threadId) {
      throw new Error('Task has no recoverable Codex thread');
    }

    task.status = 'recovering';
    try {
      task.threadId = await this.resumeAfterReconnect(task.threadId);
      task.turnId = null;
      task.status = 'ready';
      task.recoverable = false;
      task.error = null;
    } catch (error) {
      task.status = 'failed';
      task.error = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  getTask(taskId: string): GeneralTask | undefined {
    const task = this.tasks.get(taskId);
    return task ? this.copyTask(task) : undefined;
  }

  getRateLimits(): RateLimitSnapshot | null {
    return this.rateLimits ? { ...this.rateLimits } : null;
  }

  private async resumeAfterReconnect(threadId: string): Promise<string> {
    await this.client.reconnect();
    return this.client.resumeThread(threadId);
  }

  private receiveServerMessage(message: JsonRpcMessage): void {
    const params = asRecord(message.params);
    if (!message.method || !params) return;

    if (message.method === 'account/rateLimits/updated') {
      const rateLimits = asRecord(params.rateLimits);
      if (rateLimits) this.rateLimits = { ...rateLimits };
      return;
    }

    const threadId = typeof params.threadId === 'string' ? params.threadId : null;
    const task = threadId ? this.findByThreadId(threadId) : undefined;
    if (!task) return;

    switch (message.method) {
      case 'item/agentMessage/delta':
        this.appendAssistantDelta(task, params);
        break;
      case 'turn/completed':
        this.completeTurn(task, params);
        break;
      case 'thread/tokenUsage/updated':
        task.tokenUsage = asRecord(params.tokenUsage);
        break;
      case 'error':
        this.recordError(task, params);
        break;
      case 'item/commandExecution/requestApproval':
        this.blockForInteraction(task, message, 'command_approval', 'waiting_for_approval');
        break;
      case 'item/fileChange/requestApproval':
        this.blockForInteraction(task, message, 'file_change_approval', 'waiting_for_approval');
        break;
      case 'item/tool/requestUserInput':
        this.blockForInteraction(task, message, 'user_input', 'waiting_for_input');
        break;
    }
  }

  private appendAssistantDelta(task: GeneralTask, params: Record<string, unknown>): void {
    const itemId = typeof params.itemId === 'string' ? params.itemId : null;
    const delta = typeof params.delta === 'string' ? params.delta : null;
    if (!itemId || delta === null) return;

    const existing = task.transcript.find((item) => item.id === itemId);
    if (existing) existing.text += delta;
    else task.transcript.push({ id: itemId, role: 'assistant', text: delta });
  }

  private completeTurn(task: GeneralTask, params: Record<string, unknown>): void {
    const turn = asRecord(params.turn);
    const status = turn?.status;
    if (status === 'completed') task.status = 'completed';
    else if (status === 'interrupted') task.status = task.status === 'cancelled' ? 'cancelled' : 'interrupted';
    else if (status === 'failed') {
      task.status = 'failed';
      const error = asRecord(turn?.error);
      task.error = typeof error?.message === 'string' ? error.message : 'Codex turn failed';
    }
  }

  private recordError(task: GeneralTask, params: Record<string, unknown>): void {
    if (params.willRetry === true) return;
    const error = asRecord(params.error);
    task.status = 'failed';
    task.error = typeof error?.message === 'string' ? error.message : 'Codex App Server error';
  }

  private blockForInteraction(
    task: GeneralTask,
    message: JsonRpcMessage,
    kind: PendingInteraction['kind'],
    status: 'waiting_for_approval' | 'waiting_for_input',
  ): void {
    if (message.id === undefined) return;
    task.pendingInteraction = { requestId: message.id, kind, params: message.params };
    task.status = status;
  }

  private receiveExit(detail: AppServerExit): void {
    const message = detail.code === null
      ? `Codex App Server exited${detail.signal ? ` from signal ${detail.signal}` : ''}`
      : `Codex App Server exited with code ${detail.code}`;

    for (const task of this.tasks.values()) {
      if (['completed', 'cancelled'].includes(task.status)) continue;
      task.status = 'interrupted';
      task.error = message;
      task.recoverable = task.threadId !== null;
      task.pendingInteraction = null;
    }
  }

  private findByThreadId(threadId: string): GeneralTask | undefined {
    return [...this.tasks.values()].find((task) => task.threadId === threadId);
  }

  private requireTask(taskId: string): GeneralTask {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Unknown general task: ${taskId}`);
    return task;
  }

  private copyTask(task: GeneralTask): GeneralTask {
    return {
      ...task,
      transcript: task.transcript.map((item) => ({ ...item })),
      pendingInteraction: task.pendingInteraction ? { ...task.pendingInteraction } : null,
    };
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : null;
}
