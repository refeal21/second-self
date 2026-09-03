import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { afterEach, describe, expect, it } from 'vitest';
import { runGoldenProject } from './golden-project.js';

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../..',
);
const fixtureRoot = join(repositoryRoot, 'fixtures', 'golden-project');
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('five-page Chinese Golden Project', () => {
  it('ships stable PDF, CSV, PNG and style-reference PPTX source fixtures', async () => {
    const manifest = JSON.parse(
      await readFile(join(fixtureRoot, 'manifest.json'), 'utf8'),
    ) as { pageCount: number; sources: Array<{ fileName: string; sha256: string; byteLength: number }> };
    expect(manifest.pageCount).toBe(5);
    expect(manifest.sources.map(({ fileName }) => fileName)).toEqual([
      'management-memo.pdf',
      'kpis.csv',
      'market-background.png',
      'style-reference.pptx',
    ]);
    for (const source of manifest.sources) {
      const contents = await readFile(join(fixtureRoot, 'sources', source.fileName));
      expect(contents.byteLength).toBe(source.byteLength);
      expect(createHash('sha256').update(contents).digest('hex')).toBe(
        source.sha256,
      );
    }
  });

  it(
    'runs every legal approval, exports editable OOXML and passes five-page LibreOffice QA',
    async () => {
      const outputRoot = await realpath(
        await mkdtemp(join(tmpdir(), 'golden-project-')),
      );
      temporaryDirectories.push(outputRoot);

      const result = await runGoldenProject({
        fixtureRoot,
        workspaceRoot: outputRoot,
      });

      expect(result.skipGuards).toEqual({
        outlineBeforeAnalysis: true,
        detailsBeforeOutlineApproval: true,
        visualBeforeDetailsApproval: true,
        conversionBeforeAllVisualApprovals: true,
      });
      expect(result.workflowStatus).toBe('completed');
      expect(result.qaReport).toMatchObject({
        status: 'passed',
        expectedPageCount: 5,
        actualPageCount: 5,
        blankPages: [],
        issues: [],
      });
      expect(result.repairRounds).toBeLessThanOrEqual(2);

      const archive = await JSZip.loadAsync(await readFile(result.pptxPath));
      const slideXml = await Promise.all(
        [1, 2, 3, 4, 5].map((page) =>
          archive.file(`ppt/slides/slide${page}.xml`)!.async('string'),
        ),
      );
      expect(slideXml[0]).toContain('<a:t>2026 年经营复盘与增长计划</a:t>');
      expect(slideXml[1]).toContain('<a:t>管理层摘要：增长质量持续改善</a:t>');
      expect(slideXml[2]).toContain('<a:t>三项核心指标均超年度目标</a:t>');
      expect(slideXml[2]).toContain('<a:prstGeom prst="rect">');
      expect(slideXml[3]).toContain('<a:tbl>');
      expect(slideXml[4]).toContain('<c:chart');
      expect(slideXml[4]).toContain('<p:pic>');
      expect(slideXml.join('')).toContain('typeface="Hiragino Sans GB"');
      expect(slideXml.join('')).not.toContain('typeface="Aptos');
      expect(
        slideXml
          .join('')
          .match(/2026 年经营复盘与增长计划/g),
      ).toHaveLength(1);
      expect(archive.file('ppt/charts/chart1.xml')).not.toBeNull();
      expect(await stat(result.sourceMapPath)).toMatchObject({ size: expect.any(Number) });
      expect((await readFile(result.readableQaPath, 'utf8')).length).toBeGreaterThan(
        40,
      );
    },
    120_000,
  );
});
