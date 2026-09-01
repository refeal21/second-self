import { describe, expect, it } from 'vitest';
import {
  PptProjectService,
  SourceAnalysisService,
  type SourceAnalysis,
  type SourceAnalysisGateway,
  type SourceAnalysisGatewayRequest,
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

const validAnalysis: SourceAnalysis = {
  findings: [
    { id: 'finding-1', text: 'A sourced finding.', sourceIds: ['source-1'] },
  ],
  dataPoints: [
    {
      id: 'point-1',
      label: 'Growth',
      value: 12,
      unit: '%',
      sourceIds: ['source-1'],
    },
  ],
  sourceMap: [{ sourceId: 'source-1', title: 'Report', locator: 'page 8' }],
};

class FakeSourceAnalysisGateway implements SourceAnalysisGateway {
  readonly requests: SourceAnalysisGatewayRequest[] = [];
  constructor(private readonly output: SourceAnalysis = validAnalysis) {}
  async analyze(request: SourceAnalysisGatewayRequest) {
    this.requests.push(request);
    return structuredClone(this.output);
  }
}

async function createProject() {
  const artifacts = new MemoryArtifacts();
  const projects = new PptProjectService(artifacts);
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
  return { artifacts, projects };
}

describe('source analysis approval and provenance', () => {
  it('persists web-search approval and binds output to project/request/source set', async () => {
    const { artifacts, projects } = await createProject();
    const gateway = new FakeSourceAnalysisGateway();
    const service = new SourceAnalysisService(projects, gateway);
    const pending = await service.request({
      id: 'analysis-1',
      projectId: 'project-1',
      sourceIds: ['source-1'],
      webSearchQuery: 'latest market growth',
    });

    expect(pending).toMatchObject({ status: 'awaiting_web_search_approval' });
    await expect(service.execute('analysis-1')).rejects.toThrow(
      'Web search requires explicit approval',
    );
    expect(gateway.requests).toHaveLength(0);

    await service.decideWebSearch(
      'analysis-1',
      true,
      '2026-09-01T01:00:00.000Z',
    );
    const completed = await service.execute('analysis-1');

    expect(completed).toMatchObject({
      status: 'completed',
      sourceIds: ['source-1'],
      webSearchDecision: {
        approved: true,
        decidedAt: '2026-09-01T01:00:00.000Z',
      },
    });
    expect(gateway.requests).toEqual([
      {
        projectId: 'project-1',
        requestId: 'analysis-1',
        sourceIds: ['source-1'],
        webSearch: {
          approved: true,
          query: 'latest market growth',
          decidedAt: '2026-09-01T01:00:00.000Z',
        },
      },
    ]);
    expect(
      artifacts.writes.has(
        'project-1/sources/analysis-1-web-search-approval.json',
      ),
    ).toBe(true);
    expect(projects.getProjectSnapshot('project-1')).toMatchObject({
      sourceAnalysis: validAnalysis,
      sourceAnalysisEvidence: {
        projectId: 'project-1',
        requestId: 'analysis-1',
        sourceIds: ['source-1'],
      },
    });
  });

  it('rejects unsafe request/source ids and unattached source sets', async () => {
    const { projects } = await createProject();
    const service = new SourceAnalysisService(
      projects,
      new FakeSourceAnalysisGateway(),
    );
    await expect(
      service.request({
        id: '../analysis',
        projectId: 'project-1',
        sourceIds: ['source-1'],
      }),
    ).rejects.toThrow('Invalid request identifier');
    await expect(
      service.request({
        id: 'analysis-1',
        projectId: 'project-1',
        sourceIds: ['missing-source'],
      }),
    ).rejects.toThrow('attached source set');
  });

  it('rejects model output citing a source outside the requested source set', async () => {
    const { projects } = await createProject();
    const invalid: SourceAnalysis = {
      ...validAnalysis,
      findings: [{ id: 'finding-1', text: 'Forged', sourceIds: ['source-2'] }],
    };
    const service = new SourceAnalysisService(
      projects,
      new FakeSourceAnalysisGateway(invalid),
    );
    await service.request({
      id: 'analysis-1',
      projectId: 'project-1',
      sourceIds: ['source-1'],
    });

    await expect(service.execute('analysis-1')).rejects.toThrow(
      'requested source set',
    );
    expect(projects.getProjectSnapshot('project-1').sourceAnalysis).toBeNull();
  });

  it('shares a project lock across service instances and marks running before awaiting the gateway', async () => {
    const { projects } = await createProject();
    let resolveOutput: ((output: SourceAnalysis) => void) | undefined;
    const gateway: SourceAnalysisGateway = {
      analyze: () =>
        new Promise((resolve) => {
          resolveOutput = resolve;
        }),
    };
    const firstService = new SourceAnalysisService(projects, gateway);
    const secondService = new SourceAnalysisService(projects, gateway);
    await firstService.request({
      id: 'analysis-1',
      projectId: 'project-1',
      sourceIds: ['source-1'],
    });

    const first = firstService.execute('analysis-1');
    await expect(secondService.execute('analysis-1')).rejects.toThrow(
      'already running',
    );
    expect(secondService.get('analysis-1').status).toBe('running');
    resolveOutput?.(validAnalysis);
    await expect(first).resolves.toMatchObject({ status: 'completed' });
  });
});
