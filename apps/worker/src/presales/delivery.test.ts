import { describe, expect, it, vi } from 'vitest';
import { prepareV3Delivery, type V3DeliverySnapshot } from './delivery.js';
import { scenarioDetails } from './fixtures.test-support.js';

// These are external-effect boundaries, not replacement selection/preparation logic.
// Any accidental legacy export or QA invocation from the unsupported path must fail.
const forbidden = vi.hoisted(() => ({ export: vi.fn(() => { throw new Error('Must not export unsupported conversion'); }), qa: vi.fn(() => { throw new Error('Must not run QA without an export'); }) }));
vi.mock('../pptx-exporter.js', () => ({ PptxGenJsExporter: class { export = forbidden.export; } }));
vi.mock('../libreoffice-qa.js', () => ({ LibreOfficeQa: class { run = forbidden.qa; } }));

function snapshot(): V3DeliverySnapshot {
  const details = scenarioDetails();
  const basis = { hashAlgorithm: 'sha256', spec: { version: 'details-1', sha256: 'b'.repeat(64) }, design: { version: 'design-1', sha256: 'c'.repeat(64) }, skill: { version: 'skill-1', sha256: 'd'.repeat(64) }, palette: { version: 'palette-1', sha256: 'e'.repeat(64) } };
  return {
    snapshotId: 'delivery-copy-19', projectId: 'copy', revision: 19, createdAt: '2026-09-14',
    pages: details.specs.map((spec, index) => ({
      slideId: spec.id, versionId: `page-${index + 1}-v2`, image: { assetId: `asset-${index + 1}-v2`, sha256: 'a'.repeat(64) },
      approvalId: `approval-${index + 1}-v2`,
      content: { spec, design: details.designs[index]!, basis, approval: { approvalId: `approval-${index + 1}-v2`, versionId: `page-${index + 1}-v2`, imageSha256: 'a'.repeat(64), basis, decidedAt: '2026-09-14' } },
    })),
  };
}

describe('frozen v3 delivery preparation', () => {
  it('uses ordered frozen v2 inputs and approved text without consulting newest history or notes', () => {
    const frozen = snapshot();
    frozen.pages[0]!.content!.design!.speakerNotes = 'ONLY IN SPEAKER NOTES';
    const result = prepareV3Delivery(frozen);
    expect(result.pages.map(page => page.versionId)).toEqual(['page-1-v2']);
    expect(result.pages[0]!.spec?.title).toBe('Incident response');
    expect(JSON.stringify(result.pages[0]!.spec)).not.toContain('ONLY IN SPEAKER NOTES');
    expect(result.pages[0]!.design).toEqual(frozen.pages[0]!.content!.design);
    expect(result.pages[0]!.approval).toEqual(frozen.pages[0]!.content!.approval);
    expect(result.pages[0]!.basis).toEqual(frozen.pages[0]!.content!.basis);
    expect(result.selectedVersionMap).toEqual({ 'scenario-1': 'page-1-v2' });
    frozen.pages[0]!.versionId = 'page-1-v3';
    frozen.pages[0]!.content!.spec = { ...frozen.pages[0]!.content!.spec, title: 'later work' };
    expect(result.pages[0]!.versionId).toBe('page-1-v2');
    expect(result.pages[0]!.spec?.title).not.toBe('later work');
    expect(Object.isFrozen(result.pages[0]!.spec)).toBe(true);
  });

  it('preserves native page order when IDs do not sort in presentation order', () => {
    const frozen = snapshot();
    const second = structuredClone(frozen.pages[0]!);
    second.slideId = 'cover'; second.versionId = 'cover-v2';
    second.content!.spec = { ...second.content!.spec, id: 'cover' };
    frozen.pages.push(second);
    const result = prepareV3Delivery(frozen);
    expect(result.pages.map(page => page.slideId)).toEqual(['scenario-1', 'cover']);
    expect(result.selectedVersionMap).toEqual({ 'scenario-1': 'page-1-v2', cover: 'cover-v2' });
  });

  it('blocks editable conversion with no fabricated PPTX or QA even for an approved native selection', () => {
    const result = prepareV3Delivery(snapshot());
    expect(result.status).toBe('unsupported_editable_conversion');
    expect(result.reasons).toContain('missing_verified_clean_background');
    expect(result.reasons).toContain('missing_editable_geometry');
    expect(result.export).toEqual({ status: 'not_run', snapshotId: 'delivery-copy-19', selectedVersionMap: { 'scenario-1': 'page-1-v2' } });
    expect(result.qa).toEqual({ status: 'not_run', reason: 'unsupported_editable_conversion', snapshotId: 'delivery-copy-19', selectedVersionMap: { 'scenario-1': 'page-1-v2' } });
    expect(result.pages[0]!.image.assetId).toBe('asset-1-v2');
    expect(forbidden.export).not.toHaveBeenCalled();
    expect(forbidden.qa).not.toHaveBeenCalled();
  });

  it('keeps historical snapshots readable without backfilling missing frozen content', () => {
    const historical = snapshot(); delete historical.pages[0]!.content;
    const before = JSON.stringify(historical);
    const result = prepareV3Delivery(historical);
    expect(result.reasons).toContain('missing_frozen_content');
    expect(result.pages[0]!.spec).toBeNull();
    expect(result.pages[0]!.versionId).toBe('page-1-v2');
    expect(JSON.stringify(historical)).toBe(before);
  });
});
