import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import {
  PptExportService,
  PptxGenJsExporter,
  type ApprovedPptDeck,
  type PptxExporter,
  type WorkspaceArtifacts,
} from './index.js';

const onePixelPng = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  ),
);

function deck(
  visual: ApprovedPptDeck['slides'][number]['visual'],
): ApprovedPptDeck {
  return {
    title: 'Board update',
    slides: [
      {
        spec: {
          id: 'slide-1',
          title: 'Approved growth title',
          body: ['Approved source-backed body'],
          tables: [
            {
              id: 'table-1',
              headers: ['Metric', 'Value'],
              rows: [['Revenue growth', '12%']],
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
              x: 0.4,
              y: 7.0,
              w: 0.5,
              h: 0.1,
              fill: '2563EB',
            },
          ],
          sourceMap: [
            {
              sourceId: 'source-1',
              title: 'Annual report',
              locator: 'page 8',
              url: 'https://example.test/report',
            },
          ],
          imageGenerationBrief: 'A visual brief that is never slide copy.',
        },
        visual,
      },
    ],
  };
}

async function unzip(bytes: Uint8Array) {
  return JSZip.loadAsync(bytes);
}

describe('PptxGenJS editable exporter', () => {
  it('keeps approved text, tables, charts, and shapes editable without duplicating a full-slide PNG', async () => {
    const exporter = new PptxGenJsExporter();
    const bytes = await exporter.export(
      deck({
        image: onePixelPng,
        asset: {
          artifactPath: '/workspace/project-1/visuals/slide-1-v1.png',
          mediaType: 'image/png',
          usage: 'full_slide_reference',
          textFree: false,
          altText: 'Rendered slide reference containing baked text.',
        },
      }),
    );

    const archive = await unzip(bytes);
    const slideXml = await archive
      .file('ppt/slides/slide1.xml')
      ?.async('string');
    const notesXml = await archive
      .file('ppt/notesSlides/notesSlide1.xml')
      ?.async('string');
    const relationshipsXml = await archive
      .file('ppt/slides/_rels/slide1.xml.rels')
      ?.async('string');
    const chartXml = await archive
      .file('ppt/charts/chart1.xml')
      ?.async('string');
    const media = Object.keys(archive.files).filter(
      (path) => path.startsWith('ppt/media/') && !archive.files[path]?.dir,
    );

    expect(slideXml).toContain('<a:t>Approved growth title</a:t>');
    expect(slideXml).toContain('<a:t>Approved source-backed body</a:t>');
    expect(slideXml).toContain('<a:tbl>');
    expect(slideXml).toContain('<c:chart');
    expect(slideXml).toContain('<p:sp>');
    expect(slideXml).toContain('<a:prstGeom prst="rect">');
    expect(slideXml?.match(/Approved growth title/g)).toHaveLength(1);
    expect(slideXml).not.toContain('<p:pic>');
    expect(media).toEqual([]);
    expect(relationshipsXml).toContain(
      'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart"',
    );
    expect(relationshipsXml).toContain('Target="/ppt/charts/chart1.xml"');
    expect(relationshipsXml).toContain(
      'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide"',
    );
    expect(relationshipsXml).not.toContain('/image"');
    expect(chartXml).toContain('<c:numCache>');
    expect(chartXml).toContain('<c:v>100</c:v>');
    expect(chartXml).toContain('<c:v>112</c:v>');
    expect(notesXml).toContain('[Sources]');
    expect(notesXml).toContain('Annual report');
    expect(notesXml).toContain('page 8');
  });

  it('embeds only an explicitly text-free complex visual asset', async () => {
    const exporter = new PptxGenJsExporter();
    const bytes = await exporter.export(
      deck({
        image: onePixelPng,
        asset: {
          artifactPath: '/workspace/project-1/visuals/slide-1-v2.png',
          mediaType: 'image/png',
          usage: 'complex_visual',
          textFree: true,
          altText: 'Text-free growth texture.',
        },
      }),
    );

    const archive = await unzip(bytes);
    const slideXml = await archive
      .file('ppt/slides/slide1.xml')
      ?.async('string');
    const media = Object.keys(archive.files).filter(
      (path) => path.startsWith('ppt/media/') && !archive.files[path]?.dir,
    );

    expect(media).toHaveLength(1);
    expect(slideXml).toContain('<p:pic>');
    expect(slideXml?.match(/Approved growth title/g)).toHaveLength(1);
  });
});

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

class FakeExporter implements PptxExporter {
  async export(): Promise<Uint8Array> {
    return new Uint8Array([80, 75]);
  }
}

describe('PPTX export artifact service', () => {
  it('writes the exported deck through the workspace-artifact boundary', async () => {
    const artifacts = new MemoryArtifacts();
    const service = new PptExportService(new FakeExporter(), artifacts);

    const path = await service.export(
      'project-1',
      'board-update.pptx',
      deck(undefined),
    );

    expect(path).toBe('/workspace/project-1/exports/board-update.pptx');
    expect(artifacts.writes.get('project-1/exports/board-update.pptx')).toEqual(
      new Uint8Array([80, 75]),
    );
  });
});
