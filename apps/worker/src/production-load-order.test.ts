import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
  vi.resetModules();
});

describe('production QA load-order isolation', () => {
  it('does not use a patched QA prototype imported before the production factory', async () => {
    vi.resetModules();
    const root = await realpath(
      await mkdtemp(join(tmpdir(), 'ppt-production-load-order-')),
    );
    temporaryDirectories.push(root);
    const qaModule = await import('./libreoffice-qa.js');
    const qaPrototype = qaModule.LibreOfficeQa.prototype as unknown as Record<
      string,
      unknown
    >;
    const originalRun = qaPrototype['run'];
    let patchedCalls = 0;
    qaPrototype['run'] = async (
      input: import('./libreoffice-qa.js').QaRunInput,
    ) => {
      patchedCalls += 1;
      return {
        status: 'passed',
        round: input.round,
        projectId: input.projectId,
        exportPath: input.pptxPath,
        exportSha256: input.exportSha256,
        specVersionId: input.specVersionId,
        visualVersionIds: input.visualVersionIds,
        sofficePath: 'patched',
        rendererPath: 'patched',
        pdfPath: null,
        renderedPages: [],
        expectedPageCount: input.expectedPageCount,
        actualPageCount: input.expectedPageCount,
        blankPages: [],
        comparisons: [],
        issues: [],
        jsonReportPath: '/patched.json',
        textReportPath: '/patched.txt',
      };
    };
    try {
      const { createProductionPptWorkflow } = await import('./ppt-project.js');
      const production = createProductionPptWorkflow({
        workspaceRoot: root,
        sourceAnalysisGateway: {
          analyze: async () => ({
            findings: [
              {
                id: 'finding-1',
                text: 'Verified fact',
                sourceIds: ['source-1'],
              },
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
                {
                  sourceId: 'source-1',
                  title: 'Report',
                  locator: 'page 1',
                },
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
      production.projects.approveOutline(
        'project-1',
        '2026-09-01T01:00:00.000Z',
      );
      await production.slideSpecGeneration.generate('project-1');
      production.projects.approveSlideSpecs(
        'project-1',
        '2026-09-01T02:00:00.000Z',
      );
      await production.visualGeneration.generate('project-1', 'slide-1');
      production.projects.approveSlideVisual(
        'project-1',
        'slide-1',
        '2026-09-01T03:00:00.000Z',
      );
      production.projects.completeVisualReview('project-1');

      const delivery = await production.delivery.deliver(
        'project-1',
        'deck.pptx',
      );

      expect(patchedCalls).toBe(0);
      expect(delivery.qaReport).toMatchObject({
        status: 'blocked',
        issues: ['LibreOffice soffice executable is unavailable'],
      });
    } finally {
      qaPrototype['run'] = originalRun;
    }
  });
});
