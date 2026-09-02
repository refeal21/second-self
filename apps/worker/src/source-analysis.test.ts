import { describe, expect, it } from 'vitest';
import { createIsolatedPptWorkflow } from './ppt-project.js';
import {
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

class DeferredRequestArtifacts extends MemoryArtifacts {
  private releaseWrite: (() => void) | undefined;
  private markStarted!: () => void;
  readonly writeStarted = new Promise<void>((resolve) => {
    this.markStarted = resolve;
  });

  release(): void {
    this.releaseWrite?.();
  }

  override async write(
    projectId: string,
    path: string,
    contents: string | Uint8Array,
  ) {
    if (path === 'sources/analysis-1-request.json') {
      this.markStarted();
      await new Promise<void>((resolve) => {
        this.releaseWrite = resolve;
      });
    }
    return super.write(projectId, path, contents);
  }
}

class FailOnceRequestArtifacts extends MemoryArtifacts {
  private failed = false;

  override async write(
    projectId: string,
    path: string,
    contents: string | Uint8Array,
  ) {
    if (!this.failed && path === 'sources/analysis-1-request.json') {
      this.failed = true;
      throw new Error('simulated request write failure');
    }
    return super.write(projectId, path, contents);
  }
}

class FailOncePathArtifacts extends MemoryArtifacts {
  private failed = false;

  constructor(private readonly failedPath: string) {
    super();
  }

  override async write(
    projectId: string,
    path: string,
    contents: string | Uint8Array,
  ) {
    if (!this.failed && path === this.failedPath) {
      this.failed = true;
      throw new Error(`simulated ${path} write failure`);
    }
    return super.write(projectId, path, contents);
  }
}

class PostCommitFailureArtifacts extends MemoryArtifacts {
  private readonly failedPaths = new Set<string>();

  constructor(private readonly failAfterCommitPath: string) {
    super();
  }

  override async write(
    projectId: string,
    path: string,
    contents: string | Uint8Array,
  ) {
    const artifactPath = await super.write(projectId, path, contents);
    if (path === this.failAfterCommitPath && !this.failedPaths.has(path)) {
      this.failedPaths.add(path);
      throw new Error(`simulated post-commit failure for ${path}`);
    }
    return artifactPath;
  }

  async read(projectId: string, path: string): Promise<Uint8Array> {
    const contents = this.writes.get(`${projectId}/${path}`);
    if (contents === undefined) throw new Error(`missing ${path}`);
    return typeof contents === 'string'
      ? new TextEncoder().encode(contents)
      : contents;
  }

  async resolvePath(projectId: string, path: string): Promise<string> {
    return `/workspace/${projectId}/${path}`;
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

async function createProject(
  artifacts: MemoryArtifacts = new MemoryArtifacts(),
) {
  const workflow = createIsolatedPptWorkflow(artifacts);
  const { projects } = workflow;
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
  return { artifacts, projects, workflow };
}

describe('source analysis approval and provenance', () => {
  it('persists web-search approval and binds output to project/request/source set', async () => {
    const { artifacts, projects, workflow } = await createProject();
    const gateway = new FakeSourceAnalysisGateway();
    const service = workflow.sourceAnalysis(gateway);
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
    const { workflow } = await createProject();
    const service = workflow.sourceAnalysis(new FakeSourceAnalysisGateway());
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
    const { projects, workflow } = await createProject();
    const invalid: SourceAnalysis = {
      ...validAnalysis,
      findings: [{ id: 'finding-1', text: 'Forged', sourceIds: ['source-2'] }],
    };
    const service = workflow.sourceAnalysis(
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

  it.each([
    ['a non-string unit', { ...validAnalysis.dataPoints[0], unit: 12 }],
    [
      'non-array source ids',
      { ...validAnalysis.dataPoints[0], sourceIds: 'source-1' },
    ],
  ])('rejects source data points with %s', async (_label, dataPoint) => {
    const { projects, workflow } = await createProject();
    const service = workflow.sourceAnalysis(
      new FakeSourceAnalysisGateway({
        ...validAnalysis,
        dataPoints: [dataPoint as never],
      }),
    );
    await service.request({
      id: 'analysis-1',
      projectId: 'project-1',
      sourceIds: ['source-1'],
    });

    await expect(service.execute('analysis-1')).rejects.toThrow(
      'Source data point does not match the runtime schema',
    );
    expect(projects.getProjectSnapshot('project-1').sourceAnalysis).toBeNull();
  });

  it('shares a project lock across service instances and marks running before awaiting the gateway', async () => {
    const { workflow } = await createProject();
    let resolveOutput: ((output: SourceAnalysis) => void) | undefined;
    const gateway: SourceAnalysisGateway = {
      analyze: () =>
        new Promise((resolve) => {
          resolveOutput = resolve;
        }),
    };
    const firstService = workflow.sourceAnalysis(gateway);
    const secondService = workflow.sourceAnalysis(gateway);
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

  it('reserves a project before request artifact I/O so a concurrent loser writes nothing', async () => {
    const artifacts = new DeferredRequestArtifacts();
    const { workflow } = await createProject(artifacts);
    const firstService = workflow.sourceAnalysis(
      new FakeSourceAnalysisGateway(),
    );
    const secondService = workflow.sourceAnalysis(
      new FakeSourceAnalysisGateway(),
    );

    const first = firstService.request({
      id: 'analysis-1',
      projectId: 'project-1',
      sourceIds: ['source-1'],
    });
    await artifacts.writeStarted;
    expect(
      workflow.projects.getProjectSnapshot('project-1').project.workflowStatus,
    ).toBe('source_analysis');
    await expect(
      secondService.request({
        id: 'analysis-2',
        projectId: 'project-1',
        sourceIds: ['source-1'],
      }),
    ).rejects.toThrow('reserved');
    expect(
      artifacts.writes.has('project-1/sources/analysis-2-request.json'),
    ).toBe(false);

    artifacts.release();
    await expect(first).resolves.toMatchObject({ status: 'ready' });
  });

  it('rolls back request reservations after artifact I/O failure so retry is clean', async () => {
    const artifacts = new FailOnceRequestArtifacts();
    const { workflow } = await createProject(artifacts);
    const service = workflow.sourceAnalysis(new FakeSourceAnalysisGateway());
    const input = {
      id: 'analysis-1',
      projectId: 'project-1',
      sourceIds: ['source-1'],
    } as const;

    await expect(service.request(input)).rejects.toThrow(
      'simulated request write failure',
    );
    await expect(service.request(input)).resolves.toMatchObject({
      status: 'ready',
    });
    expect(
      [...artifacts.writes.keys()].filter((path) =>
        path.endsWith('analysis-1-request.json'),
      ),
    ).toHaveLength(1);
  });

  it('keeps web-search approval retryable when its artifact write fails', async () => {
    const artifacts = new FailOncePathArtifacts(
      'sources/analysis-1-web-search-approval.json',
    );
    const { workflow } = await createProject(artifacts);
    const service = workflow.sourceAnalysis(new FakeSourceAnalysisGateway());
    await service.request({
      id: 'analysis-1',
      projectId: 'project-1',
      sourceIds: ['source-1'],
      webSearchQuery: 'approved query',
    });

    await expect(
      service.decideWebSearch('analysis-1', true, '2026-09-01T01:00:00.000Z'),
    ).rejects.toThrow('write failure');
    expect(service.get('analysis-1').status).toBe(
      'awaiting_web_search_approval',
    );
    expect(service.get('analysis-1').webSearchDecision).toBeUndefined();

    await expect(
      service.decideWebSearch('analysis-1', true, '2026-09-01T01:00:00.000Z'),
    ).resolves.toMatchObject({ status: 'ready' });
  });

  it('keeps analysis execution retryable when evidence persistence fails', async () => {
    const artifacts = new FailOncePathArtifacts(
      'sources/analysis-1-analysis.json',
    );
    const { projects, workflow } = await createProject(artifacts);
    const service = workflow.sourceAnalysis(new FakeSourceAnalysisGateway());
    await service.request({
      id: 'analysis-1',
      projectId: 'project-1',
      sourceIds: ['source-1'],
    });

    await expect(service.execute('analysis-1')).rejects.toThrow(
      'write failure',
    );
    expect(service.get('analysis-1').status).toBe('ready');
    expect(projects.getProjectSnapshot('project-1')).toMatchObject({
      project: { workflowStatus: 'source_analysis' },
      sourceAnalysis: null,
      sourceAnalysisEvidence: null,
    });

    await expect(service.execute('analysis-1')).resolves.toMatchObject({
      status: 'completed',
    });
  });

  it.each([
    ['request staging', 'sources/analysis-1-request.json'],
    ['web-search decision', 'sources/analysis-1-web-search-approval.json'],
    ['analysis evidence', 'sources/analysis-1-analysis.json'],
  ] as const)(
    'adopts byte-identical %s after an adapter reports a post-commit failure',
    async (_label, failedPath) => {
      const artifacts = new PostCommitFailureArtifacts(failedPath);
      const { projects, workflow } = await createProject(artifacts);
      const service = workflow.sourceAnalysis(new FakeSourceAnalysisGateway());
      const request = await service.request({
        id: 'analysis-1',
        projectId: 'project-1',
        sourceIds: ['source-1'],
        ...(failedPath.includes('web-search')
          ? { webSearchQuery: 'approved query' }
          : {}),
      });

      if (failedPath.includes('request')) {
        expect(request.status).toBe('ready');
      } else if (failedPath.includes('web-search')) {
        await service.decideWebSearch(
          'analysis-1',
          true,
          '2026-09-01T01:00:00.000Z',
        );
      }
      await service.execute('analysis-1');

      expect(projects.getProjectSnapshot('project-1')).toMatchObject({
        project: { workflowStatus: 'source_analysis' },
        sourceAnalysis: validAnalysis,
      });
      expect(artifacts.writes.has(`project-1/${failedPath}`)).toBe(true);
    },
  );
});
