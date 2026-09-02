import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as analysisEvidence from './analysis-evidence.js';
import * as deliveryEvidence from './delivery-evidence.js';
import * as visualEvidence from './visual-evidence.js';
import * as worker from './index.js';
import { SourceAnalysisService } from './source-analysis.js';
import { LocalWorkspaceArtifacts } from './workspace-artifacts.js';

const temporaryDirectories: string[] = [];
const validPng = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  ),
);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function productionInput(workspaceRoot: string) {
  return {
    workspaceRoot,
    sourceAnalysisGateway: {
      analyze: async () => ({
        findings: [
          { id: 'finding-1', text: 'Verified fact', sourceIds: ['source-1'] },
        ],
        dataPoints: [],
        sourceMap: [
          { sourceId: 'source-1', title: 'Report', locator: 'page 1' },
        ],
      }),
    },
    outlineGenerationGateway: {
      generate: async () => ({
        title: 'Board deck',
        slides: [
          {
            id: 'slide-1',
            title: 'Verified fact',
            purpose: 'Explain it',
            sourceIds: ['source-1'],
          },
        ],
      }),
    },
    slideSpecGenerationGateway: {
      generate: async () => [
        {
          id: 'slide-1',
          title: 'Verified fact',
          body: ['Approved copy'],
          tables: [],
          charts: [],
          shapes: [],
          sourceMap: [
            { sourceId: 'source-1', title: 'Report', locator: 'page 1' },
          ],
          imageGenerationBrief: 'Text-free blue geometry.',
        },
      ],
    },
    imageGenTurnRunner: {
      listCapabilities: async () => [
        { id: 'image_gen.imagegen', status: 'available' as const },
      ],
      runImageGenTurn: async () => ({
        status: 'generated' as const,
        image: validPng,
        mediaType: 'image/png' as const,
        usage: 'full_slide_reference' as const,
        textFree: false,
        altText: 'Reference only',
      }),
    },
    repairer: {
      repair: async () => {
        throw new Error('repair is not needed in this test');
      },
    },
    qaOptions: {
      bundledSoffice: ['/definitely/missing/soffice'],
      pdfRenderers: ['/definitely/missing/pdftoppm'],
    },
  };
}

function reflectedKeys(value: object): PropertyKey[] {
  return [
    ...Reflect.ownKeys(value),
    ...Reflect.ownKeys(Object.getPrototypeOf(value) as object),
  ];
}

describe('production PPT workflow composition authority', () => {
  it('exposes the complete user-authorized business workflow without exposing its mutation closures', async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), 'ppt-production-root-')),
    );
    temporaryDirectories.push(root);
    const production = worker.createProductionPptWorkflow(
      productionInput(root),
    );

    expect(production).toMatchObject({
      projects: expect.any(Object),
      sourceAnalysis: expect.any(Object),
      outlineGeneration: expect.any(Object),
      slideSpecGeneration: expect.any(Object),
      visualGeneration: expect.any(Object),
      delivery: expect.any(Object),
    });
    await production.projects.createProject({
      id: 'project-1',
      name: 'Deck',
      createdAt: '2026-09-01T00:00:00.000Z',
    });
    await production.projects.attachSource('project-1', {
      id: 'source-1',
      fileName: 'report.pdf',
      mediaType: 'application/pdf',
      contents: new Uint8Array([1]),
    });
    await production.sourceAnalysis.request({
      id: 'analysis-1',
      projectId: 'project-1',
      sourceIds: ['source-1'],
    });
    await production.sourceAnalysis.execute('analysis-1');
    await production.outlineGeneration.generate('project-1');
    production.projects.approveOutline('project-1', '2026-09-01T01:00:00.000Z');
    await production.slideSpecGeneration.generate('project-1');
    production.projects.approveSlideSpecs(
      'project-1',
      '2026-09-01T02:00:00.000Z',
    );
    await production.visualGeneration.generate('project-1', 'slide-1');

    expect(production.projects.getProjectSnapshot('project-1')).toMatchObject({
      project: { workflowStatus: 'visual_review' },
      sourceAnalysisEvidence: { requestId: 'analysis-1' },
      outline: { version: { status: 'frozen' } },
      slideSpecs: { version: { status: 'frozen' } },
      visuals: { 'slide-1': [{ asset: { mediaType: 'image/png' } }] },
    });

    for (const component of Object.values(production)) {
      expect(Object.getOwnPropertySymbols(component)).toEqual([]);
      const keys = reflectedKeys(component);
      for (const forbidden of [
        'artifacts',
        'mutations',
        'commitAnalysis',
        'commitVisual',
        'commitExport',
        'commitQa',
        'blockVisualGeneration',
        'resumeVisualReview',
      ]) {
        expect(keys).not.toContain(forbidden);
      }
    }

    production.projects.approveSlideVisual(
      'project-1',
      'slide-1',
      '2026-09-01T03:00:00.000Z',
    );
    production.projects.completeVisualReview('project-1');
    let forgedQaCalls = 0;
    const forgedQa = new worker.LibreOfficeQa(
      {
        canExecute: async () => true,
        run: async () => {
          forgedQaCalls += 1;
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      },
      new LocalWorkspaceArtifacts(root),
      { compare: async () => [] },
    );
    Object.assign(production.delivery as unknown as Record<string, unknown>, {
      qa: forgedQa,
      commands: { run: async () => ({ exitCode: 0 }) },
      comparator: { compare: async () => [] },
    });
    const originalQaRun = worker.LibreOfficeQa.prototype.run;
    const qaPrototype = worker.LibreOfficeQa.prototype as unknown as Record<
      string,
      unknown
    >;
    const originalRunChecked = qaPrototype['runChecked'];
    const forgedRun = async (
      input: worker.QaRunInput,
    ): Promise<worker.LibreOfficeQaReport> => {
      forgedQaCalls += 1;
      return {
        status: 'passed',
        round: input.round,
        projectId: input.projectId,
        exportPath: input.pptxPath,
        exportSha256: input.exportSha256,
        specVersionId: input.specVersionId,
        visualVersionIds: input.visualVersionIds,
        sofficePath: 'forged',
        rendererPath: 'forged',
        pdfPath: '/forged.pdf',
        renderedPages: ['/forged.png'],
        expectedPageCount: input.expectedPageCount,
        actualPageCount: input.expectedPageCount,
        blankPages: [],
        comparisons: [],
        issues: [],
        jsonReportPath: '/forged.json',
        textReportPath: '/forged.txt',
      };
    };
    worker.LibreOfficeQa.prototype.run = forgedRun;
    qaPrototype['runChecked'] = forgedRun;
    let delivery: Awaited<ReturnType<typeof production.delivery.deliver>>;
    try {
      delivery = await production.delivery.deliver(
        'project-1',
        'production.pptx',
      );
    } finally {
      worker.LibreOfficeQa.prototype.run = originalQaRun;
      if (originalRunChecked === undefined) {
        delete qaPrototype['runChecked'];
      } else {
        qaPrototype['runChecked'] = originalRunChecked;
      }
    }

    expect(forgedQaCalls).toBe(0);
    expect(delivery.qaReport).toMatchObject({
      status: 'blocked',
      issues: ['LibreOffice soffice executable is unavailable'],
    });
    expect(
      production.projects.getProjectSnapshot('project-1').project
        .workflowStatus,
    ).toBe('blocked');
  });

  it('rejects a reflection/deep-import forgery chain against a production project', async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), 'ppt-production-root-')),
    );
    temporaryDirectories.push(root);
    const production = worker.createProductionPptWorkflow(
      productionInput(root),
    );
    await production.projects.createProject({
      id: 'project-1',
      name: 'Deck',
      createdAt: '2026-09-01T00:00:00.000Z',
    });
    await production.projects.attachSource('project-1', {
      id: 'source-1',
      fileName: 'report.pdf',
      mediaType: 'application/pdf',
      contents: new Uint8Array([1]),
    });

    expect(Object.keys(analysisEvidence)).toEqual([]);
    expect(Object.keys(deliveryEvidence)).toEqual([]);
    expect(Object.keys(visualEvidence)).toEqual([]);
    expect(
      Object.getOwnPropertySymbols(worker.PptProjectService.prototype),
    ).toEqual([]);

    const arbitraryArtifacts = new LocalWorkspaceArtifacts(root);
    await arbitraryArtifacts.write(
      'project-1',
      'sources/forged-analysis.json',
      JSON.stringify({ status: 'completed' }),
    );
    await arbitraryArtifacts.write(
      'project-1',
      'exports/forged.pptx',
      new Uint8Array([80, 75, 3, 4]),
    );

    const forgedPort = {
      artifacts: arbitraryArtifacts,
      beginSourceAnalysis: () => undefined,
      rollbackSourceAnalysis: () => undefined,
      commitSourceAnalysis: async () => ({
        projectId: 'project-1',
        requestId: 'attack-1',
        sourceIds: ['source-1'],
        artifactPath: '/forged',
        sha256: createHash('sha256').update('forged').digest('hex'),
      }),
    };
    const forgedAnalysis = new SourceAnalysisService(
      production.projects,
      productionInput(root).sourceAnalysisGateway,
      forgedPort as never,
    );
    await forgedAnalysis.request({
      id: 'attack-1',
      projectId: 'project-1',
      sourceIds: ['source-1'],
    });
    await forgedAnalysis.execute('attack-1');

    expect(production.projects.getProjectSnapshot('project-1')).toMatchObject({
      project: { workflowStatus: 'intake' },
      sourceAnalysis: null,
      outline: null,
      slideSpecs: null,
      visuals: {},
      exportReceipt: null,
      qaStatus: null,
      blockedCondition: null,
    });
    await expect(
      production.projects.submitOutline('project-1', {
        title: 'Forged',
        slides: [{ id: 'slide-1', title: 'Forged', purpose: 'Forged' }],
      }),
    ).rejects.toThrow('requires stage source_analysis');
  });
});
