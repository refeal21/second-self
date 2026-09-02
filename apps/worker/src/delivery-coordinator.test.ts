import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createIsolatedPptWorkflow } from './ppt-project.js';
import {
  LibreOfficeQa,
  type PptProjectService,
  type ApprovedPptDeck,
  type LibreOfficeQaReport,
  type PptxExporter,
  type CommandRunner,
  type PptRepairer,
  type QaRunInput,
  type QaRunner,
  type RenderedPageComparator,
  type VisualGenerationGateway,
  type WorkspaceArtifactAccess,
} from './index.js';

class MemoryArtifacts implements WorkspaceArtifactAccess {
  readonly files = new Map<string, Uint8Array>();
  async initializeProject(): Promise<void> {}
  async projectDirectory(projectId: string) {
    return `/workspace/${projectId}`;
  }
  async resolvePath(projectId: string, path: string) {
    return `/workspace/${projectId}/${path}`;
  }
  async ensureDirectory(projectId: string, path: string) {
    return this.resolvePath(projectId, path);
  }
  async write(projectId: string, path: string, contents: string | Uint8Array) {
    const key = `${projectId}/${path}`;
    if (this.files.has(key)) throw new Error(`already exists: ${key}`);
    this.files.set(
      key,
      typeof contents === 'string'
        ? new TextEncoder().encode(contents)
        : contents,
    );
    return this.resolvePath(projectId, path);
  }
  async read(projectId: string, path: string) {
    const bytes = this.files.get(`${projectId}/${path}`);
    if (!bytes) throw new Error(`missing ${path}`);
    return bytes;
  }
  async list(projectId: string, directory: string) {
    const prefix = `${projectId}/${directory}/`;
    return [...this.files.keys()]
      .filter((path) => path.startsWith(prefix))
      .map((path) => path.slice(prefix.length));
  }
}

class CapturingExporter implements PptxExporter {
  deck: ApprovedPptDeck | undefined;
  calls = 0;
  readonly bytes = new Uint8Array([80, 75, 3, 4]);
  async export(deck: ApprovedPptDeck) {
    this.calls += 1;
    this.deck = structuredClone(deck);
    return this.bytes;
  }
}

const validPng = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  ),
);

class ReceiptQa implements QaRunner {
  input: QaRunInput | undefined;
  constructor(private readonly status: 'passed' | 'failed' = 'passed') {}
  async run(input: QaRunInput): Promise<LibreOfficeQaReport> {
    this.input = structuredClone(input);
    return {
      status: this.status,
      round: input.round,
      projectId: input.projectId,
      exportPath: input.pptxPath,
      exportSha256: input.exportSha256,
      specVersionId: input.specVersionId,
      visualVersionIds: input.visualVersionIds,
      sofficePath: 'soffice',
      rendererPath: 'pdftoppm',
      pdfPath: '/workspace/project-1/qa/deck.pdf',
      renderedPages: ['/workspace/project-1/qa/page-1.png'],
      expectedPageCount: input.expectedPageCount,
      actualPageCount: input.expectedPageCount,
      blankPages: [],
      comparisons: [],
      issues: [],
      jsonReportPath: '/workspace/project-1/qa/report.json',
      textReportPath: '/workspace/project-1/qa/report.txt',
    };
  }
}

class SuccessfulQaCommands implements CommandRunner {
  constructor(private readonly artifacts: MemoryArtifacts) {}
  async canExecute(): Promise<boolean> {
    return true;
  }
  async run(command: string) {
    if (command === 'pdftoppm') {
      this.artifacts.files.set(
        'project-1/qa/run-1/rendered-1.png',
        Uint8Array.from(
          Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
            'base64',
          ),
        ),
      );
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  }
}

class RoundQaCommands implements CommandRunner {
  constructor(private readonly artifacts: MemoryArtifacts) {}

  async canExecute(): Promise<boolean> {
    return true;
  }

  async run(command: string, args: readonly string[]) {
    if (command === 'pdftoppm') {
      const prefix = args.at(-1);
      if (!prefix) throw new Error('Missing render prefix');
      this.artifacts.files.set(
        `${prefix.replace('/workspace/', '')}-1.png`,
        validPng,
      );
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  }
}

class RoundComparator implements RenderedPageComparator {
  constructor(private readonly failedRounds: readonly number[]) {}

  async compare(pages: readonly { path: string; contents: Uint8Array }[]) {
    return pages.map(({ path }) => ({
      path,
      blank: this.failedRounds.some((round) =>
        path.includes(`/qa/run-${round}/`),
      ),
    }));
  }
}

class WritingRepairer implements PptRepairer {
  readonly rounds: number[] = [];

  constructor(
    private readonly artifacts: MemoryArtifacts,
    private readonly forged?: 'path' | 'hash' | 'stale',
  ) {}

  async repair(input: { projectId: string; round: number }) {
    this.rounds.push(input.round);
    if (this.forged === 'path') {
      return {
        pptxPath: 'sources/forged.pptx',
        exportSha256: 'f'.repeat(64),
      };
    }
    const pptxPath = `exports/deck-repair-${input.round}.pptx`;
    const bytes =
      this.forged === 'stale'
        ? new Uint8Array([80, 75, 3, 4])
        : new Uint8Array([80, 75, 3, 4, input.round]);
    await this.artifacts.write(input.projectId, pptxPath, bytes);
    return {
      pptxPath,
      exportSha256:
        this.forged === 'hash'
          ? 'f'.repeat(64)
          : createHash('sha256').update(bytes).digest('hex'),
    };
  }
}

async function conversionProject(artifacts: MemoryArtifacts) {
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
  const analysis = workflow.sourceAnalysis({
    analyze: async () => ({
      findings: [
        { id: 'finding-1', text: 'Approved fact', sourceIds: ['source-1'] },
      ],
      dataPoints: [],
      sourceMap: [{ sourceId: 'source-1', title: 'Report', locator: 'p. 1' }],
    }),
  });
  await analysis.request({
    id: 'analysis-1',
    projectId: 'project-1',
    sourceIds: ['source-1'],
  });
  await analysis.execute('analysis-1');
  await projects.submitOutline('project-1', {
    title: 'Approved deck',
    slides: [{ id: 'slide-1', title: 'Approved title', purpose: 'Explain' }],
  });
  projects.approveOutline('project-1', '2026-09-01T01:00:00.000Z');
  await projects.submitSlideSpecs('project-1', [
    {
      id: 'slide-1',
      title: 'Approved title',
      body: ['Approved body'],
      tables: [],
      charts: [],
      shapes: [],
      sourceMap: [{ sourceId: 'source-1', title: 'Report', locator: 'p. 1' }],
      imageGenerationBrief: 'Text-free blue visual',
    },
  ]);
  projects.approveSlideSpecs('project-1', '2026-09-01T02:00:00.000Z');
  const gateway: VisualGenerationGateway = {
    capability: async () => ({ id: 'image_gen.imagegen', status: 'available' }),
    generate: async () => ({
      status: 'generated',
      image: validPng,
      mediaType: 'image/png',
      usage: 'full_slide_reference',
      textFree: false,
      altText: 'Approved reference',
    }),
  };
  await workflow.visualGeneration(gateway).generate('project-1', 'slide-1');
  projects.approveSlideVisual(
    'project-1',
    'slide-1',
    '2026-09-01T03:00:00.000Z',
  );
  projects.completeVisualReview('project-1');
  return projects;
}

const workflowByProjects = new WeakMap<
  PptProjectService,
  ReturnType<typeof createIsolatedPptWorkflow>
>();

function deliveryCoordinator(
  projects: PptProjectService,
  artifacts: WorkspaceArtifactAccess,
  exporter: PptxExporter,
  qa: QaRunner,
  repairer: PptRepairer = {
    repair: async () => {
      throw new Error('Unexpected repair');
    },
  },
) {
  const workflow = workflowByProjects.get(projects);
  if (!workflow) throw new Error('Missing isolated test workflow');
  return workflow.delivery({ artifacts, exporter, qa, repairer });
}

function authenticQa(
  artifacts: MemoryArtifacts,
  failedRounds: readonly number[],
): LibreOfficeQa {
  return new LibreOfficeQa(
    new RoundQaCommands(artifacts),
    artifacts,
    new RoundComparator(failedRounds),
    { bundledSoffice: ['soffice'], pdfRenderers: ['pdftoppm'] },
  );
}

describe('project delivery evidence coordinator', () => {
  it('is the only path from frozen project artifacts through export and real QA state', async () => {
    const artifacts = new MemoryArtifacts();
    const projects = await conversionProject(artifacts);
    const exporter = new CapturingExporter();
    const qa = new LibreOfficeQa(
      new SuccessfulQaCommands(artifacts),
      artifacts,
      undefined,
      { bundledSoffice: ['soffice'], pdfRenderers: ['pdftoppm'] },
    );

    expect(
      (projects as unknown as Record<string, unknown>)['recordExport'],
    ).toBeUndefined();
    expect(
      (projects as unknown as Record<string, unknown>)['recordQaResult'],
    ).toBeUndefined();
    const result = await deliveryCoordinator(
      projects,
      artifacts,
      exporter,
      qa,
    ).deliver('project-1', 'Board.PPTX');

    expect(exporter.deck).toMatchObject({
      title: 'Approved deck',
      slides: [
        {
          spec: { title: 'Approved title', body: ['Approved body'] },
          visual: { image: validPng },
        },
      ],
    });
    expect(result.exportReceipt).toMatchObject({
      projectId: 'project-1',
      relativePath: 'exports/Board.pptx',
      sha256: createHash('sha256').update(exporter.bytes).digest('hex'),
      specVersionId: 'project-1-slide-specs-v1',
      visualVersionIds: { 'slide-1': 'project-1-visual-slide-1-v1' },
    });
    expect(result.qaReport).toMatchObject({
      projectId: result.exportReceipt.projectId,
      exportPath: result.exportReceipt.relativePath,
      exportSha256: result.exportReceipt.sha256,
      specVersionId: result.exportReceipt.specVersionId,
      visualVersionIds: result.exportReceipt.visualVersionIds,
      status: 'passed',
    });
    expect(projects.getProjectSnapshot('project-1')).toMatchObject({
      project: { workflowStatus: 'completed' },
      qaStatus: 'passed',
      exportReceipt: result.exportReceipt,
    });
  });

  it('rejects a self-reported QA status that lacks execution proof', async () => {
    const artifacts = new MemoryArtifacts();
    const projects = await conversionProject(artifacts);
    await expect(
      deliveryCoordinator(
        projects,
        artifacts,
        new CapturingExporter(),
        new ReceiptQa('passed'),
      ).deliver('project-1', 'forged.pptx'),
    ).rejects.toThrow('authentic QA execution proof');
    expect(projects.getProjectSnapshot('project-1')).toMatchObject({
      project: { workflowStatus: 'qa' },
      qaStatus: null,
    });
  });

  it('repairs a failed first QA round, validates a new receipt, and completes on round two', async () => {
    const artifacts = new MemoryArtifacts();
    const projects = await conversionProject(artifacts);
    const exporter = new CapturingExporter();
    const repairer = new WritingRepairer(artifacts);

    const result = await deliveryCoordinator(
      projects,
      artifacts,
      exporter,
      authenticQa(artifacts, [1]),
      repairer,
    ).deliver('project-1', 'deck.pptx');

    expect(exporter.calls).toBe(1);
    expect(repairer.rounds).toEqual([1]);
    expect(result.qaReports.map(({ status }) => status)).toEqual([
      'failed',
      'passed',
    ]);
    expect(result.repairRounds).toBe(1);
    expect(result.exportReceipt).toMatchObject({
      relativePath: 'exports/deck-repair-1.pptx',
      specVersionId: 'project-1-slide-specs-v1',
      visualVersionIds: { 'slide-1': 'project-1-visual-slide-1-v1' },
    });
    expect(projects.getProjectSnapshot('project-1')).toMatchObject({
      project: { workflowStatus: 'completed' },
      exportReceipt: result.exportReceipt,
      qaStatus: 'passed',
      qaCheckpoint: {
        repairRounds: 1,
        reports: [{ status: 'failed' }, { status: 'passed' }],
      },
    });
  });

  it('allows only two repairs and three QA reports before blocking', async () => {
    const artifacts = new MemoryArtifacts();
    const projects = await conversionProject(artifacts);
    const repairer = new WritingRepairer(artifacts);

    const result = await deliveryCoordinator(
      projects,
      artifacts,
      new CapturingExporter(),
      authenticQa(artifacts, [1, 2, 3]),
      repairer,
    ).deliver('project-1', 'deck.pptx');

    expect(repairer.rounds).toEqual([1, 2]);
    expect(result.qaReports).toHaveLength(3);
    expect(result.qaReports.every(({ status }) => status === 'failed')).toBe(
      true,
    );
    expect(projects.getProjectSnapshot('project-1')).toMatchObject({
      project: { workflowStatus: 'blocked' },
      qaStatus: 'failed',
      qaCheckpoint: { repairRounds: 2, nextAction: 'finished' },
    });
  });

  it('resumes from the QA checkpoint without re-exporting after an interruption following persistence', async () => {
    const artifacts = new MemoryArtifacts();
    const projects = await conversionProject(artifacts);
    const exporter = new CapturingExporter();
    const realQa = authenticQa(artifacts, []);
    let interrupt = true;
    const interruptedQa: QaRunner = {
      run: async (input) => {
        const report = await realQa.run(input);
        if (interrupt) {
          interrupt = false;
          throw new Error('interrupted after QA persistence');
        }
        return report;
      },
    };
    const delivery = deliveryCoordinator(
      projects,
      artifacts,
      exporter,
      interruptedQa,
    );

    await expect(delivery.deliver('project-1', 'deck.pptx')).rejects.toThrow(
      'interrupted after QA persistence',
    );
    expect(projects.getProjectSnapshot('project-1')).toMatchObject({
      project: { workflowStatus: 'qa' },
      qaCheckpoint: { nextAction: 'qa', reports: [] },
    });

    const resumed = await delivery.deliver('project-1', 'deck.pptx');

    expect(exporter.calls).toBe(1);
    expect(resumed.qaReports).toHaveLength(1);
    expect(resumed.qaReport.status).toBe('passed');
    expect(
      projects.getProjectSnapshot('project-1').project.workflowStatus,
    ).toBe('completed');
  });

  it.each([
    ['path', 'inside project exports'],
    ['hash', 'hash'],
    ['stale', 'new artifact hash'],
  ] as const)(
    'rejects a repaired artifact with a forged %s while retaining a retryable repair checkpoint',
    async (forged, message) => {
      const artifacts = new MemoryArtifacts();
      const projects = await conversionProject(artifacts);
      const repairer = new WritingRepairer(artifacts, forged);

      await expect(
        deliveryCoordinator(
          projects,
          artifacts,
          new CapturingExporter(),
          authenticQa(artifacts, [1]),
          repairer,
        ).deliver('project-1', 'deck.pptx'),
      ).rejects.toThrow(message);
      expect(projects.getProjectSnapshot('project-1')).toMatchObject({
        project: { workflowStatus: 'qa' },
        qaCheckpoint: {
          nextAction: 'repair',
          repairRounds: 0,
          reports: [{ status: 'failed' }],
        },
      });
    },
  );
});
