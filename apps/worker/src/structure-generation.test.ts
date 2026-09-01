import { describe, expect, it } from 'vitest';
import {
  OutlineGenerationService,
  PptProjectService,
  SlideSpecGenerationService,
  SourceAnalysisService,
  type OutlineGenerationGateway,
  type SlideSpec,
  type SlideSpecGenerationGateway,
  type SourceAnalysisGateway,
  type WorkspaceArtifacts,
} from './index.js';

class MemoryArtifacts implements WorkspaceArtifacts {
  readonly writes = new Map<string, string | Uint8Array>();
  async initializeProject(): Promise<void> {}
  async write(projectId: string, path: string, contents: string | Uint8Array) {
    const key = `${projectId}/${path}`;
    if (this.writes.has(key)) throw new Error(`already exists: ${key}`);
    this.writes.set(key, contents);
    return `/workspace/${key}`;
  }
}

async function analyzedProject() {
  const projects = new PptProjectService(new MemoryArtifacts());
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
  const analysisGateway: SourceAnalysisGateway = {
    analyze: async () => ({
      findings: [{ id: 'finding-1', text: 'Growth', sourceIds: ['source-1'] }],
      dataPoints: [
        {
          id: 'point-1',
          label: 'Growth',
          value: 12,
          sourceIds: ['source-1'],
        },
      ],
      sourceMap: [{ sourceId: 'source-1', title: 'Report', locator: 'page 8' }],
    }),
  };
  const analysis = new SourceAnalysisService(projects, analysisGateway);
  await analysis.request({
    id: 'analysis-1',
    projectId: 'project-1',
    sourceIds: ['source-1'],
  });
  await analysis.execute('analysis-1');
  return projects;
}

const generatedSpec: SlideSpec = {
  id: 'slide-1',
  title: 'Growth',
  body: ['Revenue grew.'],
  findingIds: ['finding-1'],
  dataPointIds: ['point-1'],
  tables: [],
  charts: [],
  shapes: [],
  sourceMap: [{ sourceId: 'source-1', title: 'Report', locator: 'page 8' }],
  imageGenerationBrief: 'A text-free blue growth visual.',
};

describe('structured AI generation provenance', () => {
  it('gives the outline gateway only completed validated analysis evidence', async () => {
    const projects = await analyzedProject();
    const requests: unknown[] = [];
    const gateway: OutlineGenerationGateway = {
      generate: async (request) => {
        requests.push(request);
        return {
          title: 'Deck',
          slides: [
            {
              id: 'slide-1',
              title: 'Growth',
              purpose: 'Explain growth',
              findingIds: ['finding-1'],
              sourceIds: ['source-1'],
            },
          ],
        };
      },
    };

    await new OutlineGenerationService(projects, gateway).generate('project-1');

    expect(requests[0]).toMatchObject({
      projectId: 'project-1',
      analysisEvidence: {
        requestId: 'analysis-1',
        sourceIds: ['source-1'],
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      analysis: { findings: [{ id: 'finding-1' }] },
    });
  });

  it('rejects generated outline references that do not resolve to validated analysis', async () => {
    const projects = await analyzedProject();
    const gateway: OutlineGenerationGateway = {
      generate: async () => ({
        title: 'Deck',
        slides: [
          {
            id: 'slide-1',
            title: 'Forged',
            purpose: 'Forged',
            findingIds: ['missing-finding'],
            sourceIds: ['source-1'],
          },
        ],
      }),
    };

    await expect(
      new OutlineGenerationService(projects, gateway).generate('project-1'),
    ).rejects.toThrow('unknown finding');
    expect(projects.getProjectSnapshot('project-1').outline).toBeNull();
  });

  it('generates specs only from the frozen outline and validates exact ids/references', async () => {
    const projects = await analyzedProject();
    await new OutlineGenerationService(projects, {
      generate: async () => ({
        title: 'Deck',
        slides: [{ id: 'slide-1', title: 'Growth', purpose: 'Explain growth' }],
      }),
    }).generate('project-1');
    projects.approveOutline('project-1', '2026-09-01T01:00:00.000Z');
    const requests: unknown[] = [];
    const gateway: SlideSpecGenerationGateway = {
      generate: async (request) => {
        requests.push(request);
        return [generatedSpec];
      },
    };

    await new SlideSpecGenerationService(projects, gateway).generate(
      'project-1',
    );

    expect(requests[0]).toMatchObject({
      projectId: 'project-1',
      outlineVersion: { status: 'frozen' },
      outline: { slides: [{ id: 'slide-1' }] },
    });
    expect(projects.getProjectSnapshot('project-1').slideSpecs).toMatchObject({
      value: [{ id: 'slide-1', findingIds: ['finding-1'] }],
    });
  });
});
