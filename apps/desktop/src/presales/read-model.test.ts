import { describe, expect, it } from 'vitest';
import { toGalleryModel } from './read-model.js';
import type { V3ProjectSnapshot, V3QueueSnapshot } from './adapter.js';

const basis = { hashAlgorithm: 'native-json-sha256-v1', spec: { version: 's', sha256: 's' }, design: { version: 'd', sha256: 'd' }, skill: { version: 'k', sha256: 'k' }, palette: { version: 'p', sha256: 'p' } };
const version = (id: string, sequence: number, image: boolean) => ({ versionId: id, sequence, requestId: `req-${id}`, attemptId: `attempt-${id}`, basis, image: image ? { assetId: `asset-${id}`, sha256: `sha-${id}` } : null, provenance: { kind: 'presales' }, createdAt: '2026-09-14', missingImage: image ? null : '源图缺失' });
const page = (id: string, ordinal: number, versions = [version(`${id}-v1`, 1, true)]) => ({ slideId: id, ordinal, spec: { id, title: id, purpose: 'purpose' }, design: {}, visualBasis: basis, currentVersionId: versions.at(-1)?.versionId ?? null, versions, approval: null, feedback: null, revision: 29, intentRequestId: null, approvals: [], feedbackDrafts: [], references: [] });
const snapshot = { summary: { projectId: 'v3', name: 'Copy', pageCount: 3, revision: 2, createdAt: '2026-09-14' }, origin: { sourceProjectId: 'old', sourceRevision: 4, hashAlgorithm: 'sha', snapshotDigest: 'digest' }, frozenCheckpoint: {}, palette: { revision: 1, profile: null, locked: true }, pages: [page('a', 1), page('b', 2, [version('b-v1', 1, false), version('b-v2', 2, true)]), page('c', 3, [])], deliverySnapshot: null } as V3ProjectSnapshot;
const queue = { dispatchAvailable: true, settings: { concurrency: 3, paused: false, epoch: 1 }, remoteActive: 1, succeeded: 0, capabilities: { generation: true, referenceEditing: false, reason: 'image input unavailable' }, jobs: [{ kind: 'image', requestId: 'a-job', projectId: 'v3', slideId: 'a', status: 'running', sequence: 1, error: null }, { kind: 'image', requestId: 'c-job', projectId: 'v3', slideId: 'c', status: 'queued', sequence: 2, error: null }] } as V3QueueSnapshot;

describe('native v3 gallery join', () => {
  it('keeps page CAS separate from immutable sequence and B review available while A/C work', () => {
    const model = toGalleryModel(snapshot, queue);
    expect(model.pages[1]!.versions.map(item => item.revision)).toEqual([1, 2]);
    expect(model.pages[1]!.eligibility.approve).toBeNull();
    expect(model.pages[0]!.eligibility.generate).toMatch(/生成/);
    expect(model.pages[2]!.job.state).toBe('queued');
    expect(model.pages[1]!.currentDeliveryVersionId).toBeNull();
  });
  it('retains five revisions and a missing-image history entry', () => {
    const five = { ...snapshot, pages: [page('b', 1, Array.from({ length: 5 }, (_, index) => version(`b-v${index + 1}`, index + 1, index !== 0)))] };
    const model = toGalleryModel(five, queue);
    expect(model.pages[0]!.versions).toHaveLength(5);
    expect(model.pages[0]!.versions[0]).toMatchObject({ revision: 1, image: null, missingReason: '源图缺失' });
    expect(model.pages[0]!.versions[4]).toMatchObject({ revision: 5, manualRevision: 4 });
  });
  it('shows imported historical approval without presenting it as a new v3 approval', () => {
    const legacy = { ...version('legacy-v1', 1, true), provenance: { kind: 'legacyImported' } };
    const importedPage = { ...page('old', 1, [legacy]), originApprovals: [{ versionId: 'legacy-v1', image: legacy.image!, referenceId: 'origin-ref' }], originApproval: { versionId: 'legacy-v1', image: legacy.image!, referenceId: 'origin-ref' } };
    const model = toGalleryModel({ ...snapshot, pages: [importedPage] }, queue);
    expect(model.pages[0]!.versions[0]!.approved).toBe(true);
    expect(model.pages[0]!.currentDeliveryVersionId).toBe('legacy-v1');
    expect(model.pages[0]!.eligibility.approve).toMatch(/原始图片/);
  });
  it('blocks ordinary generation when the page has an attached reference but image input is unavailable', () => {
    const referenced = { ...page('referenced', 1), references: [{ image: { assetId: 'reference-1', sha256: 'sha-reference' }, relativePath: 'assets/reference.png', byteLength: 123, purpose: 'layout' as const }] };
    const ordinary = page('ordinary', 2);
    const model = toGalleryModel({ ...snapshot, pages: [referenced, ordinary] }, { ...queue, jobs: [] });
    expect(model.pages[0]!.eligibility.generate).toContain('image input unavailable');
    expect(model.pages[1]!.eligibility.generate).toBeNull();
  });
});
