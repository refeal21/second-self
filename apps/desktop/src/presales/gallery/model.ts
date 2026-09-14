/** Presentation-only contract. The host supplies reconciled identities and eligibility. */
export interface GalleryImageIdentity { id: string; sha256: string }
export interface GalleryVersion {
  id: string;
  revision: number;
  /** Generation request that produced this result, if applicable. */
  requestId?: string | null;
  label: string;
  manualRevision: number;
  /** Historical approval evidence, not merely a generated candidate. */
  approved: boolean;
  image: GalleryImageIdentity | null;
  missingReason?: string;
}
export interface GalleryJob {
  state: 'idle' | 'queued' | 'running' | 'unknown' | 'failed' | 'completed';
  /** Native queue request identity; null before a job is associated with the page. */
  requestId: string | null;
  label?: string;
  cancelReason?: string | null;
  retryReason?: string | null;
}
export type GalleryAction = 'generate' | 'edit' | 'adopt' | 'restore' | 'approve';
export interface GalleryPage {
  id: string;
  number: number;
  title: string;
  summary: string;
  currentDeliveryVersionId: string | null;
  candidateVersionId: string | null;
  versions: GalleryVersion[];
  job: GalleryJob;
  /** null permits an action; a string explains why the host forbids it. */
  eligibility: Record<GalleryAction, string | null>;
}
export interface GalleryFeedback { text: string; revision: number }
export interface GalleryModel {
  pages: GalleryPage[];
  /** Keys are `${pageId}:${versionId}:${revision}`; supplied from persistent host state. */
  savedFeedback: Record<string, GalleryFeedback>;
  queue: {
    concurrency: number;
    paused: boolean;
    pauseReason: string | null;
    resumeReason: string | null;
    generateAllMissingReason: string | null;
  };
  capabilityReasons: { reference: string | null; edit: string | null };
}
export interface GalleryVersionRef { pageId: string; versionId: string; revision: number }
/** Accepted native request IDs for each affected page. Missing IDs mean outcome-unknown and remain fenced.
 * Callback rejection must mean definite non-admission; an uncertain outcome returns without that page's ID. */
export interface GalleryGenerationReceipt { requestIds: Record<string, string> }
export interface GalleryProps {
  model: GalleryModel;
  /** The host resolves immutable identity; the UI never treats a path or token as authority. */
  loadImage: (identity: GalleryImageIdentity) => Promise<string>;
  onGenerate: (pageId: string, replaceCandidate: boolean) => Promise<GalleryGenerationReceipt>;
  onEdit: (version: GalleryVersionRef) => Promise<GalleryGenerationReceipt>;
  /** Ask the host to select this version for delivery; the UI does not certify deliverability. */
  onAdopt: (version: GalleryVersionRef) => Promise<void>;
  /** Restore an eligible previously approved version using the host's history contract. */
  onRestore: (version: GalleryVersionRef) => Promise<void>;
  onApprove: (version: GalleryVersionRef) => Promise<void>;
  /** Returns the saved feedback CAS revision, distinct from the visual version revision. */
  onSaveFeedback: (version: GalleryVersionRef, text: string) => Promise<GalleryFeedback>;
  onQueueChange: (change: { concurrency?: number; paused?: boolean }) => Promise<void>;
  onBatchGenerate: (batch: { pageIds: string[]; replaceCandidates: boolean }) => Promise<GalleryGenerationReceipt>;
  onCancelJob?: (pageId: string) => Promise<void>;
  onRetryJob?: (pageId: string) => Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
}
