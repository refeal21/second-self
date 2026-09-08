import type { Approval, Version } from '@digital-twin/core';
import type { NativePptPipeline, NativeVersioned } from './native-pipeline.js';
import type { PptOutline, SlideSpec } from './ppt-project.js';

export interface NativeOutlineRevisionDraft {
  id: string;
  baseOutlineVersionId: string;
  outline: PptOutline;
  specs: readonly SlideSpec[];
  createdAt: string;
  updatedAt: string;
}

export interface NativeOutlineRevisionHistory {
  id: string;
  status: 'confirmed' | 'cancelled';
  baseOutline: NativeVersioned<PptOutline>;
  baseSlideSpecs: NativeVersioned<readonly SlideSpec[]>;
  draft: NativeOutlineRevisionDraft;
  decidedAt: string;
  newOutlineVersionId: string | null;
}

export type NativeOutlineRevisionAction =
  | { kind: 'outline.revision.save'; at: string; expectedRevision: number; revisionId: string;
      baseOutlineVersionId: string; outline: PptOutline; specs: readonly SlideSpec[] }
  | { kind: 'outline.revision.approve' | 'outline.revision.cancel'; at: string; expectedRevision: number;
      revisionId: string; baseOutlineVersionId: string };

export type NativeRevisionEvent = NativeOutlineRevisionAction
  | { kind: 'details.submit'; at: string; expectedRevision: number; specs: readonly SlideSpec[] };

export function requireRevisionBaseline(state: NativePptPipeline, expectedRevision: number | undefined): void {
  if (expectedRevision !== state.revision) throw new Error('Editor baseline revision conflict; reload the saved checkpoint');
}

function requireEditable(state: NativePptPipeline): void {
  if (state.project.workflowStatus !== 'detail_review' || state.outline?.version.status !== 'frozen'
    || state.slideSpecs?.version.status !== 'draft' || Object.keys(state.visuals).length
    || state.exportReceipt || state.qaReport || state.currentSlideId || state.blockedCondition) {
    throw new Error('Outline revisions require unfrozen details at detail_review');
  }
}

function version(state: NativePptPipeline, kind: string, sequence: number, at: string, frozen: boolean): Version {
  return { id: `${state.project.id}-${kind}-v${sequence}`, projectId: state.project.id, sequence,
    status: frozen ? 'frozen' : 'draft', createdAt: at, frozenAt: frozen ? at : null };
}

export function structureApproval(state: NativePptPipeline, versionId: string, at: string): Approval {
  return { id: `${state.project.id}-outline_review-${state.approvals.length + 1}`,
    projectId: state.project.id, versionId, stage: 'outline_review', status: 'approved', decidedAt: at };
}

/** Mutates only a private candidate/replay copy; callers commit after complete validation. */
export function applyRevisionEvent(
  state: NativePptPipeline,
  action: NativeRevisionEvent,
  validateDocument: (outline: PptOutline, specs: readonly SlideSpec[], state: NativePptPipeline, preserveExistingTitles?: boolean) => void,
): void {
  requireEditable(state);
  requireRevisionBaseline(state, action.expectedRevision);
  if (!Number.isFinite(Date.parse(action.at)) || Date.parse(action.at) < Date.parse(state.project.updatedAt)) {
    throw new Error('Revision event timestamp must follow the saved checkpoint');
  }
  if (action.kind === 'details.submit') {
    if (state.outlineRevisionDraft) throw new Error('Pending outline revision must be confirmed or cancelled before saving details');
    validateDocument(state.outline!.value, action.specs, state, true);
    state.slideSpecs = { version: version(state, 'slide-specs', state.slideSpecs!.version.sequence + 1, action.at, false), value: structuredClone(action.specs) };
    return;
  }
  if (action.baseOutlineVersionId !== state.outline!.version.id) throw new Error('Stale base outline version');
  const pending = state.outlineRevisionDraft;
  if (pending && pending.id !== action.revisionId) throw new Error('A different outline revision is already pending');
  if (state.revisionHistory?.some(({ id }) => id === action.revisionId)) throw new Error('Outline revision identifier has already been used');
  if (action.kind === 'outline.revision.save') {
    validateDocument(action.outline, action.specs, state);
    state.outlineRevisionDraft = { id: action.revisionId, baseOutlineVersionId: action.baseOutlineVersionId,
      outline: structuredClone(action.outline), specs: structuredClone(action.specs),
      createdAt: pending?.createdAt ?? action.at, updatedAt: action.at };
    return;
  }
  if (!pending || pending.baseOutlineVersionId !== action.baseOutlineVersionId) throw new Error('No matching outline revision is pending');
  validateDocument(pending.outline, pending.specs, state);
  const history: NativeOutlineRevisionHistory = {
    id: pending.id, status: action.kind === 'outline.revision.approve' ? 'confirmed' : 'cancelled',
    baseOutline: structuredClone(state.outline!), baseSlideSpecs: structuredClone(state.slideSpecs!),
    draft: structuredClone(pending), decidedAt: action.at, newOutlineVersionId: null,
  };
  if (action.kind === 'outline.revision.approve') {
    const sequence = state.outline!.version.sequence + 1;
    state.outline = { version: version(state, 'outline', sequence, action.at, true), value: structuredClone(pending.outline) };
    state.slideSpecs = { version: version(state, 'slide-specs', state.slideSpecs!.version.sequence + 1, action.at, false), value: structuredClone(pending.specs) };
    state.approvals.push(structureApproval(state, state.outline.version.id, action.at));
    history.newOutlineVersionId = state.outline.version.id;
  }
  state.revisionHistory!.push(history);
  state.outlineRevisionDraft = null;
}

export function equalRevisionValue(left: unknown, right: unknown): boolean {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value !== null && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)]))
      : value;
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

/** Reconstructs all edit provenance from a separately validated, immutable v1 origin. */
export function validateRevisionProvenance(
  state: NativePptPipeline,
  validateOrigin: (origin: NativePptPipeline) => void,
  parseEvent: (event: unknown) => unknown,
  validateDocument: (outline: PptOutline, specs: readonly SlideSpec[], state: NativePptPipeline, preserveExistingTitles?: boolean) => void,
): NativePptPipeline {
  if (!state.revisionOrigin || state.revisionOrigin.schemaVersion !== 1) throw new Error('Revision origin must be an immutable v1 checkpoint');
  validateOrigin(state.revisionOrigin);
  requireEditable(state.revisionOrigin);
  if (!Array.isArray(state.revisionEvents) || !state.revisionEvents.length || !Array.isArray(state.revisionHistory)
    || state.revisionEvents[0]?.kind !== 'outline.revision.save') throw new Error('Revision event history is invalid');
  const replay = structuredClone(state.revisionOrigin);
  replay.schemaVersion = 2;
  replay.outlineRevisionDraft = null;
  replay.revisionHistory = [];
  for (const raw of state.revisionEvents) {
    const event = parseEvent(raw) as NativeRevisionEvent;
    if (!['outline.revision.save', 'outline.revision.approve', 'outline.revision.cancel', 'details.submit'].includes(event.kind)) {
      throw new Error('Revision event kind is invalid');
    }
    applyRevisionEvent(replay, event, validateDocument);
    replay.revision += 1;
    replay.project.updatedAt = event.at;
    if (event.kind === 'details.submit') replay.tasks.push({
      id: `${replay.project.id}-task-${replay.revision}-detail_generation`, kind: 'detail_generation',
      status: 'completed', createdAt: event.at, updatedAt: event.at, error: null,
    });
  }
  if (replay.revision > state.revision) throw new Error('Revision events exceed checkpoint revision');
  for (const key of ['sources', 'analysis', 'preferenceSnapshot', 'promptContext', 'outline', 'outlineRevisionDraft', 'revisionHistory'] as const) {
    if (!equalRevisionValue(state[key], replay[key])) throw new Error(`Revision provenance does not match ${key}`);
  }
  // Display names can change independently; the origin retains its original name.
  for (const key of ['id', 'goal', 'createdAt'] as const) {
    if (state.project[key] !== replay.project[key]) throw new Error('Revision origin project is inconsistent');
  }
  const expectedDetails = structuredClone(replay.slideSpecs!);
  if (state.slideSpecs?.version.status === 'frozen') {
    if (state.outlineRevisionDraft) throw new Error('Pending outline revision cannot coexist with frozen details');
    expectedDetails.version.status = 'frozen';
    expectedDetails.version.frozenAt = state.slideSpecs.version.frozenAt;
    if (!expectedDetails.version.frozenAt || !Number.isFinite(Date.parse(expectedDetails.version.frozenAt))
      || Date.parse(expectedDetails.version.frozenAt) < Date.parse(replay.project.updatedAt)) {
      throw new Error('Detail approval timestamp is invalid or precedes revision history');
    }
  } else if (state.revision !== replay.revision || state.project.updatedAt !== replay.project.updatedAt) {
    throw new Error('Draft detail revision chronology is invalid');
  }
  const end = Date.parse(state.project.updatedAt);
  if (!Number.isFinite(end)) throw new Error('Revision checkpoint timestamp is invalid');
  const detailApprovalTime = state.slideSpecs?.version.frozenAt ? Date.parse(state.slideSpecs.version.frozenAt) : null;
  if (detailApprovalTime !== null && detailApprovalTime > end) throw new Error('Detail approval timestamp exceeds checkpoint');
  for (const history of Object.values(state.visuals)) {
    let previous = detailApprovalTime ?? Infinity;
    for (const visual of history) {
      const created = Date.parse(visual.version.createdAt);
      const frozen = visual.version.frozenAt === null ? created : Date.parse(visual.version.frozenAt);
      if (!Number.isFinite(created) || !Number.isFinite(frozen) || created < previous || frozen < created || frozen > end) {
        throw new Error('Visual version timestamp chronology is invalid');
      }
      previous = frozen;
    }
  }
  let previousTaskTime = Date.parse(replay.project.updatedAt);
  for (const task of state.tasks.slice(replay.tasks.length)) {
    const time = Date.parse(task.createdAt);
    if (!Number.isFinite(time) || time < previousTaskTime || time > end || (detailApprovalTime !== null && time < detailApprovalTime)) {
      throw new Error('Task timestamp chronology is invalid');
    }
    previousTaskTime = time;
  }
  if (!equalRevisionValue(expectedDetails, state.slideSpecs)
    || !equalRevisionValue(replay.approvals, state.approvals.slice(0, replay.approvals.length))
    || !equalRevisionValue(replay.tasks, state.tasks.slice(0, replay.tasks.length))) {
    throw new Error('Revision detail, approval or task provenance is invalid');
  }
  return replay;
}
