import type { NativePptPipeline } from '../../worker/src/native-pipeline.js';

export type ProjectGenerationKind = 'analysis' | 'outline' | 'details' | 'visual' | 'memory' | 'style';
export interface ProjectMemoryProposalResult { status: string }
export interface ProjectVisualGenerationContext { slideId: string; baseRevision: number }
export type ProjectGenerationResult = NativePptPipeline | ProjectMemoryProposalResult;
export interface ProjectGeneration {
  projectId: string;
  operationId: string;
  kind: ProjectGenerationKind;
  status: 'running' | 'completed' | 'failed';
  startedAt: string;
  updatedAt: string;
  error: string | null;
  pipeline: NativePptPipeline | null;
  result: ProjectMemoryProposalResult | null;
  progress?: string;
  visualContext?: ProjectVisualGenerationContext;
}
type Listener = (state: ProjectGeneration | null) => void;

/** Lives with the desktop adapter, not with a route. This is navigation recovery,
 * not a promise of continuing generation after the application exits. */
export class ProjectGenerationRegistry {
  private readonly states = new Map<string, ProjectGeneration>();
  private readonly active = new Map<string, {
    kind: ProjectGenerationKind;
    operationId: string;
    identity?: string;
    promise: Promise<ProjectGenerationResult>;
  }>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private counter = 0;

  get(projectId: string): ProjectGeneration | null {
    return structuredClone(this.states.get(projectId) ?? null);
  }

  subscribe(projectId: string, listener: Listener): () => void {
    const listeners = this.listeners.get(projectId) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(projectId, listeners);
    this.notify(listener, this.get(projectId));
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(projectId);
    };
  }

  updateProgress(projectId: string, message: string, operationId?: string): void {
    const active = this.active.get(projectId);
    const state = this.states.get(projectId);
    if (!active || !state || state.status !== 'running') return;
    if (operationId !== undefined && operationId !== active.operationId) return;
    if (state.operationId !== active.operationId || !message.trim()) return;
    this.publish({ ...state, progress: message, updatedAt: new Date().toISOString() });
  }

  updateVisualContext(
    projectId: string,
    context: ProjectVisualGenerationContext,
    operationId?: string,
  ): void {
    const active = this.active.get(projectId);
    const state = this.states.get(projectId);
    if (!active || active.kind !== 'visual' || !state || state.status !== 'running') return;
    if (operationId !== undefined && operationId !== active.operationId) return;
    if (state.operationId !== active.operationId || active.identity !== context.slideId) return;
    this.publish({ ...state, visualContext: structuredClone(context), updatedAt: new Date().toISOString() });
  }

  run(projectId: string, kind: Exclude<ProjectGenerationKind, 'memory'>,
    operation: () => Promise<NativePptPipeline>, identity?: string): Promise<NativePptPipeline>;
  run(projectId: string, kind: 'memory',
    operation: () => Promise<ProjectMemoryProposalResult>): Promise<ProjectMemoryProposalResult>;
  run(projectId: string, kind: ProjectGenerationKind,
    operation: () => Promise<ProjectGenerationResult>, identity?: string): Promise<ProjectGenerationResult> {
    const pending = this.active.get(projectId);
    if (pending) {
      if (pending.kind !== kind) {
        return Promise.reject(new Error('当前项目已有生成任务，请等待完成后再进行下一步。'));
      }
      if (kind === 'visual' && pending.identity !== identity) {
        return Promise.reject(new Error('当前页视觉正在生成，不能将结果复用于另一页。'));
      }
      return pending.promise;
    }
    const at = new Date().toISOString();
    const operationId = `generation-${++this.counter}`;
    const state: ProjectGeneration = {
      projectId, kind, operationId, status: 'running',
      startedAt: at, updatedAt: at, error: null, pipeline: null, result: null,
    };
    // Install the single-flight lock before both the first await and notification.
    const promise = Promise.resolve().then(operation).then((result) => {
      if (this.active.get(projectId)?.operationId === operationId) {
        this.active.delete(projectId);
        const latest = this.states.get(projectId) ?? state;
        this.publish({ ...latest, status: 'completed', updatedAt: new Date().toISOString(),
          result: kind === 'memory' ? result as ProjectMemoryProposalResult : null,
          pipeline: kind === 'memory' ? null : result as NativePptPipeline });
      }
      return result;
    }, (error: unknown) => {
      if (this.active.get(projectId)?.operationId === operationId) {
        this.active.delete(projectId);
        const latest = this.states.get(projectId) ?? state;
        this.publish({ ...latest, status: 'failed', updatedAt: new Date().toISOString(),
          error: error instanceof Error ? error.message : String(error) });
      }
      throw error;
    });
    this.active.set(projectId, { kind, operationId, identity, promise });
    this.publish(state);
    return promise;
  }

  private publish(state: ProjectGeneration): void {
    this.states.set(state.projectId, structuredClone(state));
    for (const listener of [...this.listeners.get(state.projectId) ?? []]) {
      this.notify(listener, this.get(state.projectId));
    }
  }

  private notify(listener: Listener, state: ProjectGeneration | null): void {
    // UI subscriber failures cannot change a committed result or block others.
    try { listener(state); } catch { /* A later subscription can replay the state. */ }
  }
}
