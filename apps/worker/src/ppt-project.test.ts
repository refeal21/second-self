import { describe, expect, it } from 'vitest';
import {
  PptProjectService,
  SourceAnalysisService,
  VisualGenerationService,
  type SlideSpec,
  type SourceAnalysis,
  type WorkspaceArtifacts,
} from './index.js';

class MemoryArtifacts implements WorkspaceArtifacts {
  readonly initialized: string[] = [];
  readonly writes = new Map<string, string | Uint8Array>();
  failPath: string | undefined;

  async initializeProject(projectId: string): Promise<void> {
    this.initialized.push(projectId);
  }

  async projectDirectory(projectId: string): Promise<string> {
    return `/workspace/${projectId}`;
  }

  async write(
    projectId: string,
    relativePath: string,
    contents: string | Uint8Array,
  ): Promise<string> {
    const path = `${projectId}/${relativePath}`;
    if (relativePath === this.failPath)
      throw new Error('simulated write failure');
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

async function analyze(
  service: PptProjectService,
  output: SourceAnalysis = analysis,
) {
  const sourceAnalysis = new SourceAnalysisService(service, {
    analyze: async () => output,
  });
  await sourceAnalysis.request({
    id: 'analysis-1',
    projectId: 'project-1',
    sourceIds: ['source-1'],
  });
  await sourceAnalysis.execute('analysis-1');
}

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
  await analyze(service);
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
  it('rejects duplicate and unsafe outline slide ids before persisting workflow state', async () => {
    const artifacts = new MemoryArtifacts();
    const service = new PptProjectService(artifacts);
    await service.createProject({
      id: 'project-1',
      name: 'Deck',
      createdAt: '2026-09-01T00:00:00.000Z',
    });
    await service.attachSource('project-1', {
      id: 'source-1',
      fileName: 'source.pdf',
      mediaType: 'application/pdf',
      contents: new Uint8Array([1]),
    });
    await analyze(service);

    await expect(
      service.submitOutline('project-1', {
        title: 'Deck',
        slides: [
          { id: 'slide-1', title: 'A', purpose: 'A' },
          { id: 'slide-1', title: 'B', purpose: 'B' },
        ],
      }),
    ).rejects.toThrow('unique');
    await expect(
      service.submitOutline('project-1', {
        title: 'Deck',
        slides: [{ id: '../slide', title: 'A', purpose: 'A' }],
      }),
    ).rejects.toThrow('Invalid slide identifier');
    expect(service.getProjectSnapshot('project-1')).toMatchObject({
      project: { workflowStatus: 'source_analysis' },
      outline: null,
    });
  });

  it('requires slide specs to be an exact unique bijection with frozen outline ids', async () => {
    const { service } = await projectAtOutlineReview();
    service.approveOutline('project-1', '2026-09-01T01:00:00.000Z');

    await expect(
      service.submitSlideSpecs('project-1', [
        { ...slideSpecs[0]!, id: '../slide' },
      ]),
    ).rejects.toThrow('Invalid slide identifier');
    await expect(
      service.submitSlideSpecs('project-1', [slideSpecs[0]!, slideSpecs[0]!]),
    ).rejects.toThrow('exact unique bijection');
  });

  it('persists slide specs as one atomic authoritative bundle before committing state', async () => {
    const { artifacts, service } = await projectAtOutlineReview();
    service.approveOutline('project-1', '2026-09-01T01:00:00.000Z');
    artifacts.failPath = 'slide-specs/slide-specs-v1.json';

    await expect(
      service.submitSlideSpecs('project-1', slideSpecs),
    ).rejects.toThrow('simulated write failure');
    expect(service.getProjectSnapshot('project-1').slideSpecs).toBeNull();
    expect(
      [...artifacts.writes.keys()].filter((path) =>
        path.includes('/slide-specs/'),
      ),
    ).toEqual([]);
  });

  it('commits outline state only after its artifact write succeeds', async () => {
    const artifacts = new MemoryArtifacts();
    const service = new PptProjectService(artifacts);
    await service.createProject({
      id: 'project-1',
      name: 'Deck',
      createdAt: '2026-09-01T00:00:00.000Z',
    });
    await service.attachSource('project-1', {
      id: 'source-1',
      fileName: 'source.pdf',
      mediaType: 'application/pdf',
      contents: new Uint8Array([1]),
    });
    await analyze(service, {
      findings: [],
      dataPoints: [],
      sourceMap: [],
    });
    artifacts.failPath = 'outline/outline-v1.json';

    await expect(
      service.submitOutline('project-1', {
        title: 'Deck',
        slides: [{ id: 'slide-1', title: 'A', purpose: 'A' }],
      }),
    ).rejects.toThrow('simulated write failure');
    expect(service.getProjectSnapshot('project-1')).toMatchObject({
      project: { workflowStatus: 'source_analysis' },
      outline: null,
    });
  });
  it('creates a project, attaches material, and persists structured source analysis', async () => {
    const { artifacts, service } = await projectAtOutlineReview();

    expect(artifacts.initialized).toEqual(['project-1']);
    expect(
      artifacts.writes.has('project-1/sources/source-1-annual-report.pdf'),
    ).toBe(true);
    expect(
      JSON.parse(
        new TextDecoder().decode(
          artifacts.writes.get(
            'project-1/sources/analysis-1-analysis.json',
          ) as Uint8Array,
        ),
      ).output,
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
        String(
          artifacts.writes.get('project-1/slide-specs/slide-specs-v1.json'),
        ),
      ),
    ).toEqual({
      outlineVersionId: 'project-1-outline-v1',
      specs: slideSpecs,
    });
  });

  it('permits conversion only after all current page visuals are approved', async () => {
    const { service } = await projectAtOutlineReview();
    service.approveOutline('project-1', '2026-09-01T01:00:00.000Z');
    await service.submitSlideSpecs('project-1', slideSpecs);
    service.approveSlideSpecs('project-1', '2026-09-01T02:00:00.000Z');
    await new VisualGenerationService(service, {
      capability: async () => ({
        id: 'image_gen.imagegen',
        status: 'available',
      }),
      generate: async () => ({
        status: 'generated',
        image: new Uint8Array([1]),
        mediaType: 'image/png',
        usage: 'full_slide_reference',
        textFree: false,
        altText: 'Approved reference.',
      }),
    }).generate('project-1', 'slide-1');
    service.approveSlideVisual(
      'project-1',
      'slide-1',
      '2026-09-01T03:00:00.000Z',
    );
    service.completeVisualReview('project-1');

    expect(service.getProjectSnapshot('project-1')).toMatchObject({
      project: { workflowStatus: 'conversion' },
      exportPath: null,
      qaStatus: null,
    });
  });

  it('cannot use one approved visual as approval evidence for two pages', async () => {
    const artifacts = new MemoryArtifacts();
    const service = new PptProjectService(artifacts);
    await service.createProject({
      id: 'project-1',
      name: 'Deck',
      createdAt: '2026-09-01T00:00:00.000Z',
    });
    await service.attachSource('project-1', {
      id: 'source-1',
      fileName: 'source.pdf',
      mediaType: 'application/pdf',
      contents: new Uint8Array([1]),
    });
    await analyze(service);
    await service.submitOutline('project-1', {
      title: 'Deck',
      slides: [
        { id: 'slide-1', title: 'One', purpose: 'One' },
        { id: 'slide-2', title: 'Two', purpose: 'Two' },
      ],
    });
    service.approveOutline('project-1', '2026-09-01T01:00:00.000Z');
    await service.submitSlideSpecs('project-1', [
      slideSpecs[0]!,
      { ...slideSpecs[0]!, id: 'slide-2', title: 'Two' },
    ]);
    service.approveSlideSpecs('project-1', '2026-09-01T02:00:00.000Z');
    await new VisualGenerationService(service, {
      capability: async () => ({
        id: 'image_gen.imagegen',
        status: 'available',
      }),
      generate: async () => ({
        status: 'generated',
        image: new Uint8Array([1]),
        mediaType: 'image/png',
        usage: 'full_slide_reference',
        textFree: false,
        altText: 'Page one',
      }),
    }).generate('project-1', 'slide-1');
    service.approveSlideVisual(
      'project-1',
      'slide-1',
      '2026-09-01T03:00:00.000Z',
    );

    expect(() => service.completeVisualReview('project-1')).toThrow(
      'Slide slide-2 has no visual version',
    );
    expect(service.getProjectSnapshot('project-1').project.workflowStatus).toBe(
      'visual_review',
    );
  });
});
