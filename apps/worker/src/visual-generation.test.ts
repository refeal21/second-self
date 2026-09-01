import { describe, expect, it } from 'vitest';
import {
  CodexVisualGenerationGateway,
  PptProjectService,
  VisualGenerationService,
  type CodexImageGenTurnRequest,
  type CodexImageGenTurnRunner,
  type GeneratedVisualAsset,
  type SlideSpec,
  type SourceAnalysis,
  type VisualGenerationGateway,
  type VisualGenerationRequest,
  type WorkspaceArtifacts,
} from './index.js';

class MemoryArtifacts implements WorkspaceArtifacts {
  readonly writes = new Map<string, string | Uint8Array>();

  async initializeProject(): Promise<void> {}

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

  generate(request: VisualGenerationRequest): Promise<GeneratedVisualAsset> {
    this.requests.push(request);
    return new Promise((resolve) => {
      this.resolveGeneration = resolve;
    });
  }

  resolve(result: GeneratedVisualAsset): void {
    this.resolveGeneration?.(result);
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

async function projectAtVisualReview(artifacts: WorkspaceArtifacts) {
  const projects = new PptProjectService(artifacts);
  await projects.createProject({
    id: 'project-1',
    name: 'Deck',
    createdAt: '2026-09-01T00:00:00.000Z',
  });
  projects.beginSourceAnalysis('project-1');
  await projects.recordSourceAnalysis('project-1', analysis);
  await projects.submitOutline('project-1', {
    title: 'Deck',
    slides: [{ id: 'slide-1', title: spec.title, purpose: 'Explain growth.' }],
  });
  projects.approveOutline('project-1', '2026-09-01T01:00:00.000Z');
  await projects.submitSlideSpecs('project-1', [spec]);
  projects.approveSlideSpecs('project-1', '2026-09-01T02:00:00.000Z');
  return projects;
}

const generatedVisual = (byte = 7): GeneratedVisualAsset => ({
  status: 'generated',
  image: new Uint8Array([byte]),
  mediaType: 'image/png',
  usage: 'full_slide_reference',
  textFree: false,
  altText: 'A generated slide reference.',
});

describe('slide visual generation and approval', () => {
  it('generates exactly one page at a time from the approved structured spec', async () => {
    const artifacts = new MemoryArtifacts();
    const projects = await projectAtVisualReview(artifacts);
    const gateway = new DeferredVisualGateway();
    const visuals = new VisualGenerationService(projects, gateway);

    const first = visuals.generate('project-1', 'slide-1');
    await expect(visuals.generate('project-1', 'slide-1')).rejects.toThrow(
      'A slide visual is already being generated',
    );
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
    });
    expect(artifacts.writes.get('project-1/visuals/slide-1-v1.png')).toEqual(
      new Uint8Array([7]),
    );
  });

  it('freezes each approved page and reopening it creates a new current version', async () => {
    const artifacts = new MemoryArtifacts();
    const projects = await projectAtVisualReview(artifacts);
    const gateway = new DeferredVisualGateway();
    const visuals = new VisualGenerationService(projects, gateway);

    const first = visuals.generate('project-1', 'slide-1');
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
    await projects.replaceSlideVisual(
      'project-1',
      'slide-1',
      generatedVisual(1),
    );
    const replacement = await projects.replaceSlideVisual(
      'project-1',
      'slide-1',
      {
        ...generatedVisual(2),
        usage: 'complex_visual',
        textFree: true,
      },
    );

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

  constructor(private readonly capabilities: readonly string[]) {}

  async listCapabilities(): Promise<readonly string[]> {
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
    slideId: 'slide-3',
    specVersionId: 'spec-v2',
    spec,
    imageGenerationBrief: spec.imageGenerationBrief,
  };

  it('returns an explicit blocked state when the ImageGen skill or tool is unavailable', async () => {
    const runner = new FakeTurnRunner(['web', 'shell']);
    const gateway = new CodexVisualGenerationGateway(
      runner,
      '/workspace/project-1',
    );

    await expect(gateway.generate(request)).resolves.toEqual({
      status: 'blocked',
      reason: 'capability_unavailable',
      capability: 'imagegen',
      message: 'The Codex ImageGen skill/tool is unavailable.',
    });
    expect(runner.requests).toHaveLength(0);
  });

  it('builds a page-specific ImageGen turn with the approved spec as the only text authority', async () => {
    const runner = new FakeTurnRunner(['image_gen']);
    const gateway = new CodexVisualGenerationGateway(
      runner,
      '/workspace/project-1',
    );

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
});
