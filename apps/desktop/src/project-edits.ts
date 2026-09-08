import type { NativePptPipeline } from '../../worker/src/native-pipeline.js';

export type ProjectEditKind =
  | 'details.save'
  | 'details.approve'
  | 'outline.revision.save'
  | 'outline.revision.approve'
  | 'outline.revision.cancel';

export interface ProjectDetailsSaveIdentity {
  kind: 'details.save';
  expectedRevision: number;
  payloadKey: string;
}

export interface ProjectDetailsApproveIdentity {
  kind: 'details.approve';
  expectedRevision: number;
}

export interface ProjectOutlineRevisionSaveIdentity {
  kind: 'outline.revision.save';
  expectedRevision: number;
  revisionId: string;
  baseOutlineVersionId: string;
  payloadKey: string;
}

export interface ProjectOutlineRevisionDecisionIdentity {
  kind: 'outline.revision.approve' | 'outline.revision.cancel';
  expectedRevision: number;
  revisionId: string;
  baseOutlineVersionId: string;
}

export type ProjectEditIdentity =
  | ProjectDetailsSaveIdentity
  | ProjectDetailsApproveIdentity
  | ProjectOutlineRevisionSaveIdentity
  | ProjectOutlineRevisionDecisionIdentity;

export interface ProjectEdit {
  projectId: string;
  operationId: string;
  kind: ProjectEditKind;
  identity: ProjectEditIdentity;
  status: 'running' | 'completed' | 'failed';
  startedAt: string;
  updatedAt: string;
  error: string | null;
  pipeline: NativePptPipeline | null;
}

export type ProjectEditListener = (state: ProjectEdit | null) => void;
export type ProjectEditAvailability = (projectId: string) => boolean;

interface ActiveEdit {
  identityKey: string;
  promise: Promise<NativePptPipeline>;
}

/** Adapter-lifetime navigation recovery for persisted edit operations. */
export class ProjectEditRegistry {
  private readonly states = new Map<string, ProjectEdit>();
  private readonly active = new Map<string, ActiveEdit>();
  private readonly listeners = new Map<string, Set<ProjectEditListener>>();
  private counter = 0;

  constructor(private readonly isAvailable: ProjectEditAvailability = () => true) {}

  get(projectId: string): ProjectEdit | null {
    return structuredClone(this.states.get(projectId) ?? null);
  }

  subscribe(projectId: string, listener: ProjectEditListener): () => void {
    const listeners = this.listeners.get(projectId) ?? new Set<ProjectEditListener>();
    listeners.add(listener);
    this.listeners.set(projectId, listeners);
    this.notify(listener, this.get(projectId));
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(projectId);
    };
  }

  run(
    projectId: string,
    identity: ProjectEditIdentity,
    operation: () => Promise<NativePptPipeline>,
  ): Promise<NativePptPipeline> {
    const ownedIdentity = structuredClone(identity);
    const identityKey = stableKey(ownedIdentity);
    const pending = this.active.get(projectId);
    if (pending) {
      return pending.identityKey === identityKey
        ? pending.promise
        : Promise.reject(new Error('当前项目已有编辑操作，请等待完成后再继续。'));
    }
    if (!this.isAvailable(projectId)) {
      return Promise.reject(new Error('当前项目暂不可用于编辑操作。'));
    }

    const at = new Date().toISOString();
    const state: ProjectEdit = {
      projectId,
      operationId: `edit-${++this.counter}`,
      kind: ownedIdentity.kind,
      identity: ownedIdentity,
      status: 'running',
      startedAt: at,
      updatedAt: at,
      error: null,
      pipeline: null,
    };

    const promise = Promise.resolve().then(operation).then((pipeline) => {
      this.publish({
        ...state,
        status: 'completed',
        updatedAt: new Date().toISOString(),
        pipeline,
      });
      return pipeline;
    }, (error: unknown) => {
      this.publish({
        ...state,
        status: 'failed',
        updatedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    });

    // Install the lock before notifying subscribers. Cleanup observes the settled
    // public promise, so completion/failure notifications still run under lock.
    this.active.set(projectId, { identityKey, promise });
    void promise.then(
      () => this.release(projectId, promise),
      () => this.release(projectId, promise),
    );
    this.publish(state);
    return promise;
  }

  private release(projectId: string, promise: Promise<NativePptPipeline>): void {
    if (this.active.get(projectId)?.promise === promise) this.active.delete(projectId);
  }

  private publish(state: ProjectEdit): void {
    this.states.set(state.projectId, structuredClone(state));
    for (const listener of [...this.listeners.get(state.projectId) ?? []]) {
      this.notify(listener, this.get(state.projectId));
    }
  }

  private notify(listener: ProjectEditListener, state: ProjectEdit | null): void {
    try { listener(state); } catch { /* State remains replayable for healthy subscribers. */ }
  }
}

function stableKey(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableKey(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
