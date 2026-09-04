import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type {
  NativePipelineAction,
  NativePipelineResult,
  NativePptPipeline,
  NativePreferenceSnapshot,
} from '../../worker/src/native-pipeline.js';

export interface WorkflowWorkerHealth {
  protocolVersion: 1;
  worker: 'digital-twin-workflow-worker';
  status: 'ready';
}

export interface WorkflowWorkerGateway {
  health(): Promise<WorkflowWorkerHealth>;
  createProject(input: {
    id: string;
    name: string;
    goal: string;
    createdAt: string;
    preferenceSnapshot: NativePreferenceSnapshot[];
  }): Promise<NativePipelineResult>;
  restoreProject(pipeline: NativePptPipeline): Promise<NativePptPipeline>;
  executeProject(projectId: string, action: NativePipelineAction): Promise<NativePipelineResult>;
  snapshotProject(projectId: string): Promise<NativePptPipeline>;
}

export interface WorkflowWorkerBridge {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  listen<T>(event: string, handler: (event: { payload: T }) => void): Promise<() => void>;
}

interface WorkerStarted {
  generation: number;
  pid: number;
  protocolVersion: number;
}

interface WorkerLine {
  generation: number;
  line: string;
}

interface WorkerExit {
  generation: number;
  code: number | null;
  signal: number | null;
}

type WorkerStartupEvent =
  | { kind: 'stdout'; payload: WorkerLine }
  | { kind: 'exit'; payload: WorkerExit };

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

const defaultBridge: WorkflowWorkerBridge = {
  invoke,
  listen: (event, handler) => listen(event, handler),
};

export class TauriWorkflowWorkerClient implements WorkflowWorkerGateway {
  private generation: number | null = null;
  private starting: Promise<void> | null = null;
  private binding: Promise<void> | null = null;
  private nextId = 1;
  private stdoutBuffer = '';
  private pending = new Map<number, PendingRequest>();
  private pendingStartEvents: WorkerStartupEvent[] | null = null;

  constructor(private readonly bridge: WorkflowWorkerBridge = defaultBridge) {}

  async health(): Promise<WorkflowWorkerHealth> {
    const result = await this.request('system.health');
    if (!isHealth(result)) {
      throw new Error('Workflow worker returned an incompatible health response');
    }
    return result;
  }

  createProject(input: {
    id: string;
    name: string;
    goal: string;
    createdAt: string;
    preferenceSnapshot: NativePreferenceSnapshot[];
  }): Promise<NativePipelineResult> {
    return this.request('ppt.project.create', input) as Promise<NativePipelineResult>;
  }

  restoreProject(pipeline: NativePptPipeline): Promise<NativePptPipeline> {
    return this.request('ppt.project.restore', { pipeline }) as Promise<NativePptPipeline>;
  }

  executeProject(projectId: string, action: NativePipelineAction): Promise<NativePipelineResult> {
    return this.request('ppt.project.execute', { projectId, action }) as Promise<NativePipelineResult>;
  }

  snapshotProject(projectId: string): Promise<NativePptPipeline> {
    return this.request('ppt.project.snapshot', { projectId }) as Promise<NativePptPipeline>;
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    await this.ensureStarted();
    const generation = this.generation;
    if (generation === null) throw new Error('Workflow worker is not running');
    const id = this.nextId++;
    const response = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    const request = JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      ...(params === undefined ? {} : { params }),
    });
    try {
      await this.bridge.invoke<void>('send_worker_sidecar_line', {
        generation,
        line: request,
      });
    } catch (error) {
      this.pending.delete(id);
      throw error;
    }
    return response;
  }

  private async ensureStarted(): Promise<void> {
    if (this.generation !== null) return;
    if (!this.starting) {
      this.starting = this.start().finally(() => {
        this.starting = null;
      });
    }
    return this.starting;
  }

  private async start(): Promise<void> {
    await this.bindEvents();
    this.stdoutBuffer = '';
    this.pendingStartEvents = [];
    let started: WorkerStarted;
    try {
      started = await this.bridge.invoke<WorkerStarted>('start_worker_sidecar');
    } catch (error) {
      this.pendingStartEvents = null;
      throw error;
    }
    if (started.protocolVersion !== 1) {
      this.pendingStartEvents = null;
      throw new Error(`Unsupported workflow worker protocol ${started.protocolVersion}`);
    }
    this.generation = started.generation;
    const buffered = this.pendingStartEvents;
    this.pendingStartEvents = null;
    for (const event of buffered ?? []) {
      if (event.payload.generation !== started.generation) continue;
      if (event.kind === 'stdout') {
        this.receiveLine(event.payload);
        continue;
      }
      this.handleExit(event.payload);
      throw new Error(
        `Workflow worker exited during startup (code ${event.payload.code ?? 'unknown'}, signal ${event.payload.signal ?? 'none'})`,
      );
    }
  }

  private bindEvents(): Promise<void> {
    if (!this.binding) {
      this.binding = Promise.all([
        this.bridge.listen<WorkerLine>('workflow-worker://stdout', ({ payload }) => {
          if (payload.generation === this.generation) this.receiveLine(payload);
          else if (this.pendingStartEvents !== null) {
            this.pendingStartEvents.push({ kind: 'stdout', payload });
          }
        }),
        this.bridge.listen<WorkerExit>('workflow-worker://exit', ({ payload }) => {
          if (payload.generation === this.generation) this.handleExit(payload);
          else if (this.pendingStartEvents !== null) {
            this.pendingStartEvents.push({ kind: 'exit', payload });
          }
        }),
      ]).then(() => undefined);
    }
    return this.binding;
  }

  private handleExit(payload: WorkerExit): void {
    if (payload.generation !== this.generation) return;
    this.generation = null;
    this.stdoutBuffer = '';
    const error = new Error(
      `Workflow worker exited unexpectedly (code ${payload.code ?? 'unknown'}, signal ${payload.signal ?? 'none'})`,
    );
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }

  private receiveLine(payload: WorkerLine): void {
    if (payload.generation !== this.generation) return;
    this.stdoutBuffer += payload.line;
    let newline = this.stdoutBuffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line) this.receiveResponse(line);
      newline = this.stdoutBuffer.indexOf('\n');
    }
  }

  private receiveResponse(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(message) || typeof message.id !== 'number') return;
    const request = this.pending.get(message.id);
    if (!request) return;
    this.pending.delete(message.id);
    if (isRecord(message.error)) {
      request.reject(new Error(
        typeof message.error.message === 'string'
          ? message.error.message
          : 'Workflow worker request failed',
      ));
      return;
    }
    request.resolve(message.result);
  }
}

function isHealth(value: unknown): value is WorkflowWorkerHealth {
  return isRecord(value) && value.protocolVersion === 1 &&
    value.worker === 'digital-twin-workflow-worker' && value.status === 'ready';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
