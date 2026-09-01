import { describe, expect, it } from 'vitest';
import {
  PptProjectService,
  type SlideSpec,
  type SourceAnalysis,
  type WorkspaceArtifacts,
} from './index.js';

class MemoryArtifacts implements WorkspaceArtifacts {
  readonly initialized: string[] = [];
  readonly writes = new Map<string, string | Uint8Array>();

  async initializeProject(projectId: string): Promise<void> {
    this.initialized.push(projectId);
  }

  async write(
    projectId: string,
    relativePath: string,
    contents: string | Uint8Array,
  ): Promise<string> {
    const path = `${projectId}/${relativePath}`;
    this.writes.set(path, contents);
    return `/workspace/${path}`;
  }
}

const analysis: SourceAnalysis = {
  findings: [
    { id: 'finding-1', text: 'Revenue grew 12%.', sourceIds: ['source-1'] },
  ],
  dataPoints: [
    { id: 'revenue-growth', label: 'Revenue growth', value: 12, unit: '%' },
  ],
  sourceMap: [
    { sourceId: 'source-1', title: 'Annual report', locator: 'page 8' },
  ],
};

const slideSpecs: SlideSpec[] = [
  {
    id: 'slide-1',
    title: 'Growth accelerated',
    body: ['Revenue increased by 12%.'],
    tables: [
      {
        id: 'table-1',
        headers: ['Metric', 'Value'],
        rows: [['Growth', '12%']],
      },
    ],
    charts: [
      {
        id: 'chart-1',
        type: 'bar',
        categories: ['2025', '2026'],
        series: [{ name: 'Revenue', values: [100, 112] }],
      },
    ],
    shapes: [
      {
        id: 'shape-1',
        type: 'rect',
        x: 0.5,
        y: 6.8,
        w: 0.3,
        h: 0.1,
        fill: '2563EB',
      },
    ],
    sourceMap: analysis.sourceMap,
    imageGenerationBrief: 'A restrained blue growth visual with no text.',
  },
];

async function projectAtOutlineReview() {
  const artifacts = new MemoryArtifacts();
  const service = new PptProjectService(artifacts);
  await service.createProject({
    id: 'project-1',
    name: 'Board update',
    createdAt: '2026-09-01T00:00:00.000Z',
  });
  await service.attachSource('project-1', {
    id: 'source-1',
    fileName: 'annual-report.pdf',
    mediaType: 'application/pdf',
    contents: new Uint8Array([1, 2, 3]),
  });
  service.beginSourceAnalysis('project-1');
  await service.recordSourceAnalysis('project-1', analysis);
  await service.submitOutline('project-1', {
    title: 'Board update',
    slides: [
      {
        id: 'slide-1',
        title: 'Growth accelerated',
        purpose: 'Show the result.',
      },
    ],
  });
  return { artifacts, service };
}

describe('PPT project workflow', () => {
  it('creates a project, attaches material, and persists structured source analysis', async () => {
    const { artifacts, service } = await projectAtOutlineReview();

    expect(artifacts.initialized).toEqual(['project-1']);
    expect(
      artifacts.writes.has('project-1/sources/source-1-annual-report.pdf'),
    ).toBe(true);
    expect(
      JSON.parse(
        String(artifacts.writes.get('project-1/sources/analysis.json')),
      ),
    ).toEqual(analysis);
    expect(service.getProjectSnapshot('project-1')).toMatchObject({
      project: { workflowStatus: 'outline_review' },
      sources: [{ id: 'source-1', fileName: 'annual-report.pdf' }],
      sourceAnalysis: analysis,
    });
  });

  it('freezes the whole outline approval and rejects actions from an illegal stage', async () => {
    const { service } = await projectAtOutlineReview();

    const approved = service.approveOutline(
      'project-1',
      '2026-09-01T01:00:00.000Z',
    );

    expect(approved).toMatchObject({
      status: 'frozen',
      frozenAt: '2026-09-01T01:00:00.000Z',
    });
    expect(Object.isFrozen(approved)).toBe(true);
    expect(service.getProjectSnapshot('project-1')).toMatchObject({
      project: { workflowStatus: 'detail_review' },
      approvals: [{ stage: 'outline_review', status: 'approved' }],
    });
    await expect(
      service.attachSource('project-1', {
        id: 'late',
        fileName: 'late.pdf',
        mediaType: 'application/pdf',
        contents: new Uint8Array(),
      }),
    ).rejects.toThrow('requires stage intake');
    expect(() =>
      service.approveOutline('project-1', '2026-09-01T02:00:00.000Z'),
    ).toThrow('requires stage outline_review');
  });

  it('freezes all slide specs together and persists one authoritative spec and brief per page', async () => {
    const { artifacts, service } = await projectAtOutlineReview();
    service.approveOutline('project-1', '2026-09-01T01:00:00.000Z');

    await service.submitSlideSpecs('project-1', slideSpecs);
    const approved = service.approveSlideSpecs(
      'project-1',
      '2026-09-01T02:00:00.000Z',
    );

    expect(approved).toMatchObject({
      status: 'frozen',
      frozenAt: '2026-09-01T02:00:00.000Z',
    });
    expect(service.getProjectSnapshot('project-1')).toMatchObject({
      project: { workflowStatus: 'visual_review' },
      approvals: [
        { stage: 'outline_review', status: 'approved' },
        { stage: 'detail_review', status: 'approved' },
      ],
    });
    expect(
      JSON.parse(
        String(artifacts.writes.get('project-1/slide-specs/slide-1-v1.json')),
      ),
    ).toEqual(slideSpecs[0]);
    expect(
      artifacts.writes.get('project-1/slide-specs/slide-1-v1-image-brief.txt'),
    ).toBe('A restrained blue growth visual with no text.');
  });

  it('permits conversion and QA completion only after all current page visuals are approved', async () => {
    const { service } = await projectAtOutlineReview();
    service.approveOutline('project-1', '2026-09-01T01:00:00.000Z');
    await service.submitSlideSpecs('project-1', slideSpecs);
    service.approveSlideSpecs('project-1', '2026-09-01T02:00:00.000Z');
    await service.replaceSlideVisual('project-1', 'slide-1', {
      status: 'generated',
      image: new Uint8Array([1]),
      mediaType: 'image/png',
      usage: 'full_slide_reference',
      textFree: false,
      altText: 'Approved reference.',
    });
    service.approveSlideVisual(
      'project-1',
      'slide-1',
      '2026-09-01T03:00:00.000Z',
    );
    service.completeVisualReview('project-1');

    expect(() => service.recordQaResult('project-1', 'passed')).toThrow(
      'requires stage qa',
    );
    service.recordExport('project-1', '/workspace/project-1/exports/deck.pptx');
    service.recordQaResult('project-1', 'passed');

    expect(service.getProjectSnapshot('project-1')).toMatchObject({
      project: { workflowStatus: 'completed' },
      exportPath: '/workspace/project-1/exports/deck.pptx',
      qaStatus: 'passed',
    });
  });
});
