import { describe, expect, it } from 'vitest';
import type { NativePptPipeline } from '../../worker/src/native-pipeline.js';
import { derivePendingPptApprovals } from './collection-read-model.js';

function pipeline(
  workflowStatus: NativePptPipeline['project']['workflowStatus'],
): NativePptPipeline {
  return {
    schemaVersion: 1,
    revision: 4,
    project: {
      id: 'project-review',
      name: '季度业务复盘',
      goal: '向管理层说明季度结果',
      workflowStatus,
      createdAt: '2026-09-07T01:00:00.000Z',
      updatedAt: '2026-09-07T02:00:00.000Z',
    },
    preferenceSnapshot: [],
    sources: [],
    analysis: null,
    outline: null,
    slideSpecs: null,
    visuals: {},
    currentSlideId: null,
    approvals: [],
    tasks: [],
    blockedCondition: null,
    exportReceipt: null,
    qaReport: null,
  };
}

describe('pending PPT approval read model', () => {
  it('prioritizes saved structure confirmation over detail approval', () => {
    const ready = pipeline('detail_review');
    ready.outlineRevisionDraft = { id: 'revision-2', baseOutlineVersionId: 'outline-1',
      outline: { title: '修订', slides: [] }, specs: [], createdAt: 'now', updatedAt: 'now' };
    expect(derivePendingPptApprovals([ready])).toEqual([expect.objectContaining({
      id: 'ppt-review:project-review:structure:revision-2', detail: '大纲结构修订待确认', projectId: 'project-review',
    })]);
  });
  it('derives an outline review from the current draft instead of approval history', () => {
    const ready = pipeline('outline_review');
    ready.outline = {
      version: {
        id: 'project-review-outline-v1',
        projectId: 'project-review',
        sequence: 1,
        status: 'draft',
        createdAt: '2026-09-07T02:00:00.000Z',
        frozenAt: null,
      },
      value: { title: '季度业务复盘', slides: [] },
    };
    ready.approvals = [{
      id: 'historical-proof',
      projectId: 'project-review',
      versionId: 'old-outline',
      stage: 'outline_review',
      status: 'approved',
      decidedAt: '2026-09-06T01:00:00.000Z',
    }];

    expect(derivePendingPptApprovals([ready])).toEqual([
      expect.objectContaining({
        id: 'ppt-review:project-review:outline:project-review-outline-v1',
        projectId: 'project-review',
        detail: '整份大纲待审核',
      }),
    ]);
  });

  it('does not claim detail review is ready when the detail draft is absent', () => {
    const notReady = pipeline('detail_review');

    expect(derivePendingPptApprovals([notReady])).toEqual([]);
  });

  it('exposes a project-specific review item only when a detail draft exists', () => {
    const ready = pipeline('detail_review');
    ready.slideSpecs = {
      version: {
        id: 'project-review-slide-specs-v1',
        projectId: 'project-review',
        sequence: 1,
        status: 'draft',
        createdAt: '2026-09-07T02:00:00.000Z',
        frozenAt: null,
      },
      value: [],
    };

    expect(derivePendingPptApprovals([ready])).toEqual([
      {
        id: 'ppt-review:project-review:details:project-review-slide-specs-v1',
        projectId: 'project-review',
        title: '季度业务复盘',
        detail: '全部页面细化待审核',
        author: 'PPT 工作流',
        time: '2026-09-07T02:00:00.000Z',
      },
    ]);
  });

  it('does not expose visual review until the current slide has a draft candidate', () => {
    const notReady = pipeline('visual_review');
    notReady.currentSlideId = 'slide-1';
    notReady.slideSpecs = {
      version: {
        id: 'project-review-slide-specs-v1', projectId: 'project-review',
        sequence: 1, status: 'frozen', createdAt: '2026-09-07T02:00:00.000Z',
        frozenAt: '2026-09-07T02:30:00.000Z',
      },
      value: [{
        id: 'slide-1', title: '经营结果', body: ['收入增长'],
        tables: [], charts: [], shapes: [], sourceMap: [], imageGenerationBrief: '经营结果图',
      }],
    };
    expect(derivePendingPptApprovals([notReady])).toEqual([]);

    notReady.visuals['slide-1'] = [{
      slideId: 'slide-1',
      version: {
        id: 'project-review-visual-slide-1-v1', projectId: 'project-review',
        sequence: 1, status: 'draft', createdAt: '2026-09-07T03:00:00.000Z',
        frozenAt: null,
      },
      relativePath: '', sha256: 'a'.repeat(64), byteLength: 0,
      usage: 'full_slide_reference', textFree: false, altText: '经营结果页',
    }];
    expect(derivePendingPptApprovals([notReady])).toEqual([]);

    notReady.visuals['slide-1']![0] = {
      ...notReady.visuals['slide-1']![0]!,
      relativePath: 'visuals/slide-1-v1.png',
      byteLength: 128,
    };

    expect(derivePendingPptApprovals([notReady])).toEqual([
      expect.objectContaining({
        id: 'ppt-review:project-review:visual:project-review-visual-slide-1-v1',
        projectId: 'project-review',
        detail: '第 1 页「经营结果」视觉版本待审核',
      }),
    ]);
  });
});
