import type { ApprovedPptDeck } from '../pptx-exporter.js';
import type { SlideDesignPlan } from './contracts.js';

/** Serialized native authority; never constructed from gallery/history selection. */
export interface V3DeliverySnapshot {
  snapshotId: string;
  projectId: string;
  revision: number;
  createdAt: string;
  pages: Array<{
    slideId: string;
    versionId: string;
    image: { assetId: string; sha256: string };
    approvalId: string;
    originApprovalRef?: unknown;
    content?: {
      spec: ApprovedPptDeck['slides'][number]['spec'];
      design: SlideDesignPlan | null;
      basis: unknown | null;
      approval: unknown | null;
    };
  }>;
}

/** Pure/browser-safe preparation. Native is the only selection/approval/byte authority.
 * The current exporter accepts specs but cannot consume verified free-layout geometry
 * or a cleaned source background. Never pass an approved full-page PNG into its
 * legacy fixed masks; approval alone cannot make that conversion faithful.
 */
export function prepareV3Delivery(snapshot: V3DeliverySnapshot) {
  const frozen = structuredClone(snapshot);
  const selectedVersionMap = Object.fromEntries(frozen.pages.map(page => [page.slideId, page.versionId]));
  const identity = { snapshotId: frozen.snapshotId, selectedVersionMap };
  const pages = frozen.pages.map(page => ({
    slideId: page.slideId, versionId: page.versionId, image: page.image,
    approvalId: page.approvalId, originApprovalRef: page.originApprovalRef ?? null,
    spec: page.content?.spec ?? null, design: page.content?.design ?? null,
    basis: page.content?.basis ?? null, approval: page.content?.approval ?? null,
  }));
  return deepFreeze({
    ...identity, projectId: frozen.projectId, revision: frozen.revision, pages,
    status: 'unsupported_editable_conversion' as const,
    reasons: [
      ...(frozen.pages.some(page => !page.content) ? ['missing_frozen_content'] : []),
      'missing_verified_clean_background', 'missing_editable_geometry',
    ],
    export: { ...identity, status: 'not_run' as const },
    qa: { ...identity, status: 'not_run' as const, reason: 'unsupported_editable_conversion' as const },
  });
}

export type V3DeliveryPreparation = ReturnType<typeof prepareV3Delivery>;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
