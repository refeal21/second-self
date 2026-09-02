import { describe, expect, it } from 'vitest';
import { createIsolatedPptWorkflow } from './ppt-project.js';
import {
  CodexVisualGenerationGateway,
  type PptProjectService,
  type CodexImageGenTurnRequest,
  type CodexImageGenTurnRunner,
  type GeneratedVisualAsset,
  type SlideSpec,
  type SourceAnalysis,
  type VisualGenerationGateway,
  type VisualGenerationCapability,
  type VisualGenerationRequest,
  type WorkspaceArtifacts,
} from './index.js';

class MemoryArtifacts implements WorkspaceArtifacts {
  readonly writes = new Map<string, string | Uint8Array>();

  async initializeProject(): Promise<void> {}

  async projectDirectory(projectId: string): Promise<string> {
    return `/workspace/${projectId}`;
  }

  async write(
    projectId: string,
    path: string,
    contents: string | Uint8Array,
  ): Promise<string> {
    this.writes.set(`${projectId}/${path}`, contents);
    return `/workspace/${projectId}/${path}`;
  }
}

class DeferredVisualGateway implements VisualGenerationGateway {
  readonly requests: VisualGenerationRequest[] = [];
  private resolveGeneration:
    | ((result: GeneratedVisualAsset) => void)
    | undefined;
  private pending: GeneratedVisualAsset | undefined;

  generate(request: VisualGenerationRequest): Promise<GeneratedVisualAsset> {
    this.requests.push(request);
    return new Promise((resolve) => {
      if (this.pending) {
        const pending = this.pending;
        this.pending = undefined;
        resolve(pending);
        return;
      }
      this.resolveGeneration = resolve;
    });
  }

  async capability(): Promise<VisualGenerationCapability> {
    return { id: 'image_gen.imagegen', status: 'available' };
  }

  resolve(result: GeneratedVisualAsset): void {
    if (this.resolveGeneration) this.resolveGeneration(result);
    else this.pending = result;
  }
}

const analysis: SourceAnalysis = {
  findings: [
    { id: 'finding-1', text: 'Revenue grew.', sourceIds: ['source-1'] },
  ],
  dataPoints: [{ id: 'point-1', label: 'Growth', value: 12, unit: '%' }],
  sourceMap: [
    { sourceId: 'source-1', title: 'Annual report', locator: 'page 8' },
  ],
};

const spec: SlideSpec = {
  id: 'slide-1',
  title: 'Approved title',
  body: ['Approved body'],
  tables: [],
  charts: [],
  shapes: [],
  sourceMap: analysis.sourceMap,
  imageGenerationBrief: 'Text-free blue abstract growth bars.',
};

const validPng = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  ),
);

async function projectAtVisualReview(artifacts: WorkspaceArtifacts) {
  const workflow = createIsolatedPptWorkflow(artifacts);
  const { projects } = workflow;
  workflowByProjects.set(projects, workflow);
  await projects.createProject({
    id: 'project-1',
    name: 'Deck',
    createdAt: '2026-09-01T00:00:00.000Z',
  });
  await projects.attachSource('project-1', {
    id: 'source-1',
    fileName: 'report.pdf',
    mediaType: 'application/pdf',
    contents: new Uint8Array([1]),
  });
  const sourceAnalysis = workflow.sourceAnalysis({
    analyze: async () => analysis,
  });
  await sourceAnalysis.request({
    id: 'analysis-1',
    projectId: 'project-1',
    sourceIds: ['source-1'],
  });
  await sourceAnalysis.execute('analysis-1');
  await projects.submitOutline('project-1', {
    title: 'Deck',
    slides: [{ id: 'slide-1', title: spec.title, purpose: 'Explain growth.' }],
  });
  projects.approveOutline('project-1', '2026-09-01T01:00:00.000Z');
  await projects.submitSlideSpecs('project-1', [spec]);
  projects.approveSlideSpecs('project-1', '2026-09-01T02:00:00.000Z');
  return projects;
}

const workflowByProjects = new WeakMap<
  PptProjectService,
  ReturnType<typeof createIsolatedPptWorkflow>
>();

function visualService(
  projects: PptProjectService,
  gateway: VisualGenerationGateway,
) {
  const workflow = workflowByProjects.get(projects);
  if (!workflow) throw new Error('Missing isolated test workflow');
  return workflow.visualGeneration(gateway);
}

const generatedVisual = (byte = 7): GeneratedVisualAsset => ({
  status: 'generated',
  image: byte === 99 ? new Uint8Array([byte]) : validPng,
  mediaType: 'image/png',
  usage: 'full_slide_reference',
  textFree: false,
  altText: 'A generated slide reference.',
});

describe('slide visual generation and approval', () => {
  it('does not expose a public arbitrary-image state mutation path', async () => {
    const projects = await projectAtVisualReview(new MemoryArtifacts());
    expect(
      (projects as unknown as Record<string, unknown>)[
        'recordGeneratedSlideVisual'
      ],
    ).toBeUndefined();
    expect(
      (projects as unknown as Record<string, unknown>)['replaceSlideVisual'],
    ).toBeUndefined();
  });
  it('generates exactly one page at a time from the approved structured spec', async () => {
    const artifacts = new MemoryArtifacts();
    const projects = await projectAtVisualReview(artifacts);
    const gateway = new DeferredVisualGateway();
    const visuals = visualService(projects, gateway);
    const secondVisuals = visualService(projects, gateway);

    const first = visuals.generate('project-1', 'slide-1');
    await expect(
      secondVisuals.generate('project-1', 'slide-1'),
    ).rejects.toThrow('already running');
    await Promise.resolve();
    gateway.resolve(generatedVisual());
    const completed = await first;

    expect(completed).toMatchObject({
      status: 'generated',
      version: { sequence: 1, status: 'draft' },
      asset: { usage: 'full_slide_reference', textFree: false },
    });
    expect(gateway.requests[0]).toMatchObject({
      projectId: 'project-1',
      slideId: 'slide-1',
      specVersionId: 'project-1-slide-specs-v1',
      spec: { title: 'Approved title', body: ['Approved body'] },
      imageGenerationBrief: 'Text-free blue abstract growth bars.',
      projectCwd: '/workspace/project-1',
    });
    expect(artifacts.writes.get('project-1/visuals/slide-1-v1.png')).toEqual(
      validPng,
    );
  });

  it('rejects bytes that are not a decodable PNG before artifact storage', async () => {
    const artifacts = new MemoryArtifacts();
    const projects = await projectAtVisualReview(artifacts);
    const visuals = visualService(projects, {
      capability: async () => ({
        id: 'image_gen.imagegen',
        status: 'available',
      }),
      generate: async () => generatedVisual(99),
    });

    await expect(visuals.generate('project-1', 'slide-1')).rejects.toThrow(
      'decodable PNG',
    );
    expect(artifacts.writes.has('project-1/visuals/slide-1-v1.png')).toBe(
      false,
    );
    expect(projects.getProjectSnapshot('project-1').visuals).toEqual({});
  });

  it('freezes each approved page and reopening it creates a new current version', async () => {
    const artifacts = new MemoryArtifacts();
    const projects = await projectAtVisualReview(artifacts);
    const gateway = new DeferredVisualGateway();
    const visuals = visualService(projects, gateway);

    const first = visuals.generate('project-1', 'slide-1');
    await Promise.resolve();
    gateway.resolve(generatedVisual(1));
    await first;
    const approved = projects.approveSlideVisual(
      'project-1',
      'slide-1',
      '2026-09-01T03:00:00.000Z',
    );
    const reopened = projects.reopenApprovedSlide(
      'project-1',
      'slide-1',
      '2026-09-01T04:00:00.000Z',
    );

    expect(approved).toMatchObject({ sequence: 1, status: 'frozen' });
    expect(reopened).toMatchObject({
      version: { sequence: 2, status: 'draft' },
      asset: null,
    });
    expect(() => projects.completeVisualReview('project-1')).toThrow(
      'not approved',
    );

    const regenerated = visuals.generate('project-1', 'slide-1');
    await Promise.resolve();
    gateway.resolve(generatedVisual(2));
    await expect(regenerated).resolves.toMatchObject({
      version: { sequence: 2 },
    });
    projects.approveSlideVisual(
      'project-1',
      'slide-1',
      '2026-09-01T05:00:00.000Z',
    );
    projects.completeVisualReview('project-1');

    expect(projects.getProjectSnapshot('project-1')).toMatchObject({
      project: { workflowStatus: 'conversion' },
      visuals: {
        'slide-1': [
          { version: { sequence: 1, status: 'frozen' } },
          { version: { sequence: 2, status: 'frozen' } },
        ],
      },
    });
  });

  it('replacement creates another slide version instead of mutating the current visual', async () => {
    const artifacts = new MemoryArtifacts();
    const projects = await projectAtVisualReview(artifacts);
    let byte = 0;
    const visuals = visualService(projects, {
      capability: async () => ({
        id: 'image_gen.imagegen',
        status: 'available',
      }),
      generate: async () => ({
        ...generatedVisual(++byte),
        ...(byte === 2
          ? { usage: 'complex_visual' as const, textFree: true }
          : {}),
      }),
    });
    await visuals.generate('project-1', 'slide-1');
    const replacement = await visuals.generate('project-1', 'slide-1');

    expect(replacement).toMatchObject({
      version: { sequence: 2 },
      asset: { usage: 'complex_visual' },
    });
    expect(
      projects.getProjectSnapshot('project-1').visuals['slide-1'],
    ).toHaveLength(2);
  });
});

class FakeTurnRunner implements CodexImageGenTurnRunner {
  readonly requests: CodexImageGenTurnRequest[] = [];

  constructor(
    private readonly capabilities: readonly VisualGenerationCapability[],
  ) {}

  async listCapabilities(): Promise<readonly VisualGenerationCapability[]> {
    return this.capabilities;
  }

  async runImageGenTurn(
    request: CodexImageGenTurnRequest,
  ): Promise<GeneratedVisualAsset> {
    this.requests.push(request);
    return generatedVisual();
  }
}

describe('Codex ImageGen visual gateway', () => {
  const request: VisualGenerationRequest = {
    projectId: 'project-1',
    projectCwd: '/workspace/project-1',
    slideId: 'slide-3',
    specVersionId: 'spec-v2',
    spec,
    imageGenerationBrief: spec.imageGenerationBrief,
  };

  it('returns an explicit blocked state when the ImageGen skill or tool is unavailable', async () => {
    const runner = new FakeTurnRunner([
      { id: 'web', status: 'available' },
      { id: 'shell', status: 'available' },
    ]);
    const gateway = new CodexVisualGenerationGateway(runner);

    await expect(gateway.generate(request)).resolves.toEqual({
      status: 'blocked',
      reason: 'capability_unavailable',
      capability: 'image_gen.imagegen',
      message: 'The Codex ImageGen skill/tool is unavailable.',
    });
    expect(runner.requests).toHaveLength(0);
  });

  it('builds a page-specific ImageGen turn with the approved spec as the only text authority', async () => {
    const runner = new FakeTurnRunner([
      { id: 'image_gen.imagegen', status: 'available' },
    ]);
    const gateway = new CodexVisualGenerationGateway(runner);

    await gateway.generate(request);

    expect(runner.requests).toHaveLength(1);
    expect(runner.requests[0]).toMatchObject({
      kind: 'imagegen',
      cwd: '/workspace/project-1',
      projectId: 'project-1',
      slideId: 'slide-3',
      specVersionId: 'spec-v2',
    });
    expect(runner.requests[0]?.prompt).toContain('Approved title');
    expect(runner.requests[0]?.prompt).toContain(
      'Text-free blue abstract growth bars.',
    );
    expect(runner.requests[0]?.prompt).toContain(
      'must never overwrite the structured slide spec',
    );
  });

  it('does not accept fuzzy or disabled ImageGen capability names', async () => {
    const runner = new FakeTurnRunner([
      { id: 'imagegen-disabled', status: 'available' },
      { id: 'image_gen.imagegen', status: 'disabled' },
    ]);

    await expect(
      new CodexVisualGenerationGateway(runner).generate({
        ...request,
        projectCwd: '/workspace/project-1',
      }),
    ).resolves.toMatchObject({ status: 'blocked' });
    expect(runner.requests).toHaveLength(0);
  });
});

describe('recoverable ImageGen blocking', () => {
  it('persists capability blocking and resumes visual review after exact capability restoration', async () => {
    const projects = await projectAtVisualReview(new MemoryArtifacts());
    let available = false;
    const gateway: VisualGenerationGateway = {
      capability: async () => ({
        id: 'image_gen.imagegen',
        status: available ? 'available' : 'unavailable',
      }),
      generate: async () => ({
        status: 'blocked',
        reason: 'capability_unavailable',
        capability: 'image_gen.imagegen',
        message: 'Unavailable',
      }),
    };
    const service = visualService(projects, gateway);

    await expect(
      service.generate('project-1', 'slide-1'),
    ).resolves.toMatchObject({
      status: 'blocked',
    });
    expect(projects.getProjectSnapshot('project-1')).toMatchObject({
      project: { workflowStatus: 'blocked' },
      blockedCondition: {
        recoverable: true,
        resumeStage: 'visual_review',
        capability: 'image_gen.imagegen',
      },
    });
    await expect(service.resume('project-1')).rejects.toThrow(
      'still unavailable',
    );
    available = true;
    await service.resume('project-1');
    const resumed = projects.getProjectSnapshot('project-1');
    expect(resumed).toMatchObject({
      project: { workflowStatus: 'visual_review' },
      blockedCondition: null,
    });
    expect(resumed.approvals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: 'detail_review',
          status: 'approved',
        }),
      ]),
    );
  });
});
