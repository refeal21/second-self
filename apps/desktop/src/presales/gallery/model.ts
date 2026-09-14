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
  /** All exact native image-job IDs for this page, independent of the newest display job. */
  observedRequestIds?: readonly string[];
  /** Native exact-batch admission/reuse or durable non-admission proof. */
  admissionResolutions?: readonly { submittedRequestId: string; actualRequestId: string | null }[];
  pendingAdmissionRequestId?: string;
  /** null permits an action; a string explains why the host forbids it. */
  eligibility: Record<GalleryAction, string | null>;
  /** Native page-scoped review fence, separate from immutable version sequence. */
  reviewKey?: string;
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
/** Accepted IDs come only from matching native jobs. Attempted IDs are reconciliation keys,
 * never admission proof: missing accepted IDs stay fenced until the exact job/version appears. */
export interface GalleryGenerationReceipt { requestIds: Record<string, string>; attemptedRequestIds?: Record<string, string>; /** Only pre-invocation host validation may populate this. */ notSubmitted?: Record<string, string> }
export interface GalleryProps {
  model: GalleryModel;
  readOnly?: boolean;
  initialPageId?: string;
  initialVersionId?: string;
  /** The host resolves immutable identity; the UI never treats a path or token as authority. */
  loadImage: (identity: GalleryImageIdentity) => Promise<string>;
  onGenerate: (pageId: string, replaceCandidate: boolean) => Promise<GalleryGenerationReceipt>;
  onEdit: (version: GalleryVersionRef) => Promise<GalleryGenerationReceipt>;
  /** Ask the host to select this version for delivery; the UI does not certify deliverability. */
  onAdopt: (version: GalleryVersionRef) => Promise<void>;
  /** Restore an eligible previously approved version using the host's history contract. */
  onRestore: (version: GalleryVersionRef) => Promise<void>;
  onApprove: (version: GalleryVersionRef, checks: { contentChecked: true; visualChecked: true }) => Promise<void>;
  /** Returns the saved feedback CAS revision, distinct from the visual version revision. */
  onSaveFeedback: (version: GalleryVersionRef, text: string) => Promise<GalleryFeedback>;
  onQueueChange: (change: { concurrency?: number; paused?: boolean }) => Promise<void>;
  onBatchGenerate: (batch: { pageIds: string[]; replaceCandidates: boolean }) => Promise<GalleryGenerationReceipt>;
  onCancelJob?: (pageId: string) => Promise<void>;
  onRetryJob?: (pageId: string) => Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
  onPageChange?: (pageId: string) => void;
}
