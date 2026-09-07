import type { NativePptPipeline } from '../../worker/src/native-pipeline.js';

export type ProjectGenerationKind = 'analysis' | 'outline' | 'details';
export interface ProjectGeneration {
  projectId: string;
  operationId: string;
  kind: ProjectGenerationKind;
  status: 'running' | 'completed' | 'failed';
  startedAt: string;
  updatedAt: string;
  error: string | null;
  pipeline: NativePptPipeline | null;
}
type Listener = (state: ProjectGeneration | null) => void;

/** Lives with the desktop adapter, not with a route. This is navigation recovery,
 * not a promise of continuing generation after the application exits. */
export class ProjectGenerationRegistry {
  private readonly states = new Map<string, ProjectGeneration>();
  private readonly active = new Map<string, { kind: ProjectGenerationKind; promise: Promise<NativePptPipeline> }>();
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

  run(projectId: string, kind: ProjectGenerationKind, operation: () => Promise<NativePptPipeline>): Promise<NativePptPipeline> {
    const pending = this.active.get(projectId);
    if (pending) return pending.kind === kind
      ? pending.promise
      : Promise.reject(new Error('当前项目已有生成任务，请等待完成后再进行下一步。'));
    const at = new Date().toISOString();
    const state: ProjectGeneration = {
      projectId, kind, operationId: `generation-${++this.counter}`, status: 'running',
      startedAt: at, updatedAt: at, error: null, pipeline: null,
    };
    // Install the single-flight lock before both the first await and notification.
    const promise = Promise.resolve().then(operation).then((pipeline) => {
      this.active.delete(projectId);
      this.publish({ ...state, status: 'completed', updatedAt: new Date().toISOString(), pipeline });
      return pipeline;
    }, (error: unknown) => {
      this.active.delete(projectId);
      this.publish({ ...state, status: 'failed', updatedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error) });
      throw error;
    });
    this.active.set(projectId, { kind, promise });
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
