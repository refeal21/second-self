import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { VisualStyleProfile, VisualStyleState } from '../../../worker/src/visual-style.js';
import type { OutlineEnvelope, DetailsEnvelope } from '../../../worker/src/presales/contracts.js';

export type V3Stage = 'outline' | 'details';
export type V3Kind = 'frozen' | 'history_only' | 'draft';
export interface V3Summary { projectId: string; name: string; pageCount: number; revision: number; createdAt: string }
export interface V3Origin { sourceProjectId: string; sourceRevision: number; hashAlgorithm: string; snapshotDigest: string }
export interface V3CatalogEntry { kind: V3Kind; summary: V3Summary }
export interface V3Hash { version: string; sha256: string }
export interface V3Basis { hashAlgorithm: string; spec: V3Hash; design: V3Hash; skill: V3Hash; palette: V3Hash }
export interface V3Image { assetId: string; sha256: string }
export interface V3Reference { image: V3Image; relativePath: string; byteLength: number; purpose: 'style' | 'layout' | 'composition' }
export interface V3VisualVersion { versionId: string; sequence: number; requestId: string | null; attemptId: string | null; basis: V3Basis | null; image: V3Image | null; provenance: unknown; createdAt: string; missingImage?: string | null }
export interface V3Approval { approvalId: string; versionId: string; imageSha256: string; basis: V3Basis; decidedAt: string }
export interface V3Feedback { baseVersionId: string | null; revision: number; text: string; updatedAt: string }
export interface V3OriginApproval { versionId: string; image: V3Image; referenceId: string; [key: string]: unknown }
export interface V3Page { slideId: string; ordinal: number; spec: unknown; design: unknown | null; visualBasis: V3Basis | null; currentVersionId: string | null; versions: V3VisualVersion[]; approval: V3Approval | null; feedback: V3Feedback | null; revision: number; intentRequestId: string | null; approvals: V3Approval[]; feedbackDrafts: V3Feedback[]; references: V3Reference[]; originApprovals?: V3OriginApproval[]; originApproval?: V3OriginApproval | null }
export interface V3ProjectSnapshot { summary: V3Summary; origin: V3Origin; frozenCheckpoint: unknown; palette: VisualStyleState; pages: V3Page[]; deliverySnapshot: unknown | null }
export interface V3HistoryProject { summary: V3Summary; origin: V3Origin; importId: string; palette: VisualStyleState; pages: V3Page[]; reasons: string[]; deliverySnapshot: unknown | null }
export interface V3PromptContext { taskBrief: string; sourceInstructions: Record<string, string>; outlineRequirements: string }
export interface V3DraftSettings { brief: string; context: V3PromptContext; palette: VisualStyleState; paletteOrigin: 'imported' | 'manual' }
export interface V3AuthoredDraft { schemaVersion: number; skill: unknown; events: Array<{ revision: number; at: string; action: { kind: string; stage?: V3Stage; envelope?: unknown } }>; checkpoint: { schemaVersion: number; draft: { schemaVersion: number; outline: OutlineEnvelope; details: DetailsEnvelope | null }; approvalBindings: Array<{ stage: V3Stage }> } | null; settings: V3DraftSettings }
export interface V3ImportedDraft { schemaVersion: number; summary: V3Summary; origin: V3Origin; importId: string; sources: unknown[]; brief: string; analysis: unknown | null; context: unknown | null; preferences: unknown; originalOutline: unknown | null; palette: VisualStyleState; comparisonPages: V3Page[]; authored?: V3AuthoredDraft | null }
export type V3Project = { kind: 'frozen'; project: V3ProjectSnapshot } | { kind: 'history_only'; project: V3HistoryProject } | { kind: 'draft'; project: V3ImportedDraft };
export interface V3QueueJob { kind: 'image' | 'text'; requestId: string; projectId: string; slideId: string | null; status: string; sequence: number; error: string | null }
export interface V3QueueSnapshot { dispatchAvailable: boolean; settings: { concurrency: number; paused: boolean; epoch: number }; remoteActive: number; succeeded: number; jobs: V3QueueJob[]; capabilities?: { generation: boolean; referenceEditing: boolean; reason?: string } }
export interface V3TextOperation { sequence: number; operationId: string; attemptId: string; target: { stage: V3Stage; prompt: string; promptVersion: string; brief: string; context: V3PromptContext; palette: VisualStyleState }; status: string; result: { completion: { envelope: OutlineEnvelope | DetailsEnvelope } } | null; commit: unknown | null; error: string | null; createdAtMs: number; updatedAtMs: number }
export interface V3PreparedCopy { preparationId: string; sourceProjectId: string; sourceRevision: number; kind: V3Kind; destination: V3Summary; reasons: string[] }
export interface V3PageRequest { slideId: string; requestId: string; attemptId: string; expectedRevision: number; parentVersionId: string | null; feedback: string }
export interface V3EnqueueOutcome { jobs: Array<{ requestId: string; target: { projectId: string; slideId: string } }>; reusedRequestIds: string[] }
export interface PresalesAdapter {
  list(): Promise<V3CatalogEntry[]>; load(projectId: string): Promise<V3Project>; queue(): Promise<V3QueueSnapshot>;
  subscribe(listener: (revision: number) => void): () => void;
  prepareCopy(sourceProjectId: string, mode: 'format_copy' | 'presales_content_revision'): Promise<V3PreparedCopy>;
  publishCopy(preparationId: string): Promise<V3Project>; discardCopy(preparationId: string): Promise<void>;
  enqueue(projectId: string, batchId: string, pages: V3PageRequest[]): Promise<V3EnqueueOutcome>;
  settings(concurrency: number, paused: boolean): Promise<V3QueueSnapshot['settings']>;
  saveFeedback(input: { projectId: string; slideId: string; baseVersionId: string | null; expectedRevision: number; text: string }): Promise<V3Feedback>;
  approveVersion(input: { projectId: string; slideId: string; versionId: string; imageSha256: string; basis: V3Basis; expectedRevision: number; contentChecked: true; visualChecked: true }): Promise<V3Approval>;
  adoptVersion(input: { projectId: string; slideId: string; versionId: string; expectedRevision: number }): Promise<V3Page>;
  restoreApproval(input: { projectId: string; slideId: string; versionId: string; expectedRevision: number }): Promise<V3Page>;
  cancel(kind: 'image' | 'text', requestId: string): Promise<void>; abandon(kind: 'image' | 'text', requestId: string): Promise<void>; retrySave(): Promise<void>;
  pickReference(input: { projectId: string; slideId: string; expectedRevision: number; purpose: V3Reference['purpose'] }): Promise<V3Page | null>;
  setReferences(projectId: string, slideId: string, expectedRevision: number, references: V3Reference[]): Promise<V3Page>;
  readImage(input: { projectId: string; slideId: string; versionId: string; assetId: string; sha256: string }): Promise<{ mimeType: 'image/png'; base64: string }>;
  textHistory(projectId: string): Promise<V3TextOperation[]>;
  author(input: { projectId: string; expectedRevision: number; operationId: string; attemptId: string; stage: V3Stage }): Promise<V3TextOperation>;
  savePair(input: { projectId: string; expectedRevision: number; stage: V3Stage; envelope: OutlineEnvelope | DetailsEnvelope }): Promise<V3ImportedDraft>;
  approvePair(projectId: string, expectedRevision: number, stage: V3Stage): Promise<V3ImportedDraft>;
  draftSettings(input: { projectId: string; expectedRevision: number; brief: string; context: V3PromptContext; manualPalette: VisualStyleProfile | null }): Promise<V3ImportedDraft>;
  promote(projectId: string, expectedRevision: number): Promise<V3ProjectSnapshot>;
}

/** All command strings are private to this native bridge; the UI cannot mint paths or results. */
export function createPresalesAdapter(): PresalesAdapter {
  const call = <T>(name: string, args?: Record<string, unknown>) => invoke<T>(`presales_v3_${name}`, args);
  return {
    list: () => call('list'), load: projectId => call('load', { projectId }), queue: () => call('queue'),
    subscribe(listener) { let active = true; let unlisten: (() => void) | undefined; void listen<{ revision: number }>('presales-queue-changed', event => { if (active) listener(event.payload.revision); }).then(stop => { if (active) unlisten = stop; else stop(); }).catch(() => { /* Manual refresh remains available if event registration fails. */ }); return () => { active = false; unlisten?.(); }; },
    prepareCopy: (sourceProjectId, mode) => call('prepare_copy', { input: { sourceProjectId, mode } }),
    publishCopy: preparationId => call('publish_copy', { preparationId }), discardCopy: preparationId => call('discard_copy', { preparationId }),
    enqueue: (projectId, batchId, pages) => call('enqueue', { input: { projectId, batchId, pages } }),
    settings: (concurrency, paused) => call('settings', { concurrency, paused }),
    saveFeedback: input => call('save_feedback', { input }), approveVersion: input => call('approve_version', { input }),
    adoptVersion: input => call('adopt_version', { input }), restoreApproval: input => call('restore_approval', { input }),
    cancel: (kind, requestId) => call('cancel', { kind, requestId }), abandon: (kind, requestId) => call('abandon', { kind, requestId, acknowledgeDuplicateRisk: true }), retrySave: () => call('retry_save'),
    pickReference: input => call('pick_reference', { input }), setReferences: (projectId, slideId, expectedRevision, references) => call('set_references', { projectId, slideId, expectedRevision, references }),
    readImage: input => call('read_image', input), textHistory: projectId => call('text_history', { projectId }), author: input => call('author', { input }),
    savePair: input => call('save_pair', { input }), approvePair: (projectId, expectedRevision, stage) => call('approve_pair', { projectId, expectedRevision, stage }),
    draftSettings: input => call('draft_settings', { input }), promote: (projectId, expectedRevision) => call('promote', { projectId, expectedRevision }),
  };
}
