import { basename } from 'node:path';
import PptxGenJS from 'pptxgenjs';
import type {
  ApprovedVisualAsset,
  SlideChart,
  SlideShape,
  SlideSpec,
} from './ppt-project.js';
import type { WorkspaceArtifacts } from './workspace-artifacts.js';

// Hiragino Sans GB ships with the target macOS installation and is also
// visible to the bundled headless LibreOffice renderer. Using a Latin-only
// default such as Aptos turns approved Chinese copy into missing-glyph boxes.
const editableFontFace = 'Hiragino Sans GB';

export interface ApprovedPptDeck {
  title: string;
  slides: readonly {
    spec: SlideSpec;
    visual?: {
      asset: ApprovedVisualAsset;
      image: Uint8Array;
    };
  }[];
}

export interface PptxExporter {
  export(deck: ApprovedPptDeck): Promise<Uint8Array>;
}

export class PptExportService {
  constructor(
    private readonly exporter: PptxExporter,
    private readonly artifacts: WorkspaceArtifacts,
  ) {}

  async export(
    projectId: string,
    fileName: string,
    deck: ApprovedPptDeck,
  ): Promise<string> {
    if (
      basename(fileName) !== fileName ||
      !fileName.toLowerCase().endsWith('.pptx')
    ) {
      throw new Error('PPTX export file name must be a local .pptx name');
    }
    const bytes = await this.exporter.export(deck);
    return this.artifacts.write(projectId, `exports/${fileName}`, bytes);
  }
}

export class PptxGenJsExporter implements PptxExporter {
  async export(deck: ApprovedPptDeck): Promise<Uint8Array> {
    const pptx = new PptxGenJS();
    pptx.layout = 'LAYOUT_WIDE';
    pptx.author = 'Digital Twin Workbench';
    pptx.subject =
      'Editable presentation generated from approved structured slide specs';
    pptx.title = deck.title;
    pptx.company = 'Digital Twin Workbench';
    pptx.theme = {
      headFontFace: editableFontFace,
      bodyFontFace: editableFontFace,
    };

    for (const [slideIndex, item] of deck.slides.entries()) {
      const slide = pptx.addSlide();
      slide.background = { color: 'F7F9FC' };
      const visual = item.visual;
      if (
        visual &&
        visual.asset.textFree &&
        visual.asset.usage !== 'full_slide_reference' &&
        visual.asset.embeddingAudit?.approvedForEmbedding === true &&
        visual.asset.embeddingAudit.classification === visual.asset.usage
      ) {
        addApprovedVisual(
          slide,
          visual.asset,
          visual.image,
          item.spec.charts.length > 0,
        );
      }
      addEditableSpec(pptx, slide, item.spec, slideIndex === 0);
      if (item.spec.sourceMap.length > 0)
        slide.addNotes(sourceNotes(item.spec));
    }

    const output = await pptx.write({
      outputType: 'uint8array',
      compression: true,
    });
    if (output instanceof Uint8Array) return output;
    if (output instanceof ArrayBuffer) return new Uint8Array(output);
    throw new Error('PptxGenJS returned an unsupported output type');
  }
}

function addApprovedVisual(
  slide: PptxGenJS.Slide,
  asset: ApprovedVisualAsset,
  image: Uint8Array,
  hasChart: boolean,
): void {
  const data = `data:${asset.mediaType};base64,${Buffer.from(image).toString('base64')}`;
  if (asset.usage === 'text_free_background') {
    slide.addImage({
      data,
      x: 0,
      y: 0,
      w: 13.333,
      h: 7.5,
      altText: asset.altText,
    });
    return;
  }
  slide.addImage({
    data,
    x: 7.1,
    y: 1.35,
    w: 5.55,
    h: hasChart ? 0.9 : 4.85,
    altText: asset.altText,
  });
}

function addEditableSpec(
  pptx: PptxGenJS,
  slide: PptxGenJS.Slide,
  spec: SlideSpec,
  isCover: boolean,
): void {
  slide.addText(spec.title, {
    x: 0.75,
    y: 0.42,
    w: 11.8,
    h: 0.65,
    fontFace: editableFontFace,
    fontSize: isCover ? 50 : 35,
    bold: true,
    color: '172033',
    margin: 0,
    breakLine: false,
  });

  if (spec.body.length > 0) {
    slide.addText(
      isCover
        ? spec.body.join('\n')
        : spec.body.map((text) => ({
            text,
            options: { bullet: { indent: 16 }, breakLine: true },
          })),
      {
        x: 0.8,
        y: 1.35,
        w: 5.7,
        h: 1.15,
        fontFace: editableFontFace,
        fontSize: isCover ? 24 : 18,
        color: '344054',
        margin: 2,
        breakLine: false,
        valign: 'top',
      },
    );
  }

  spec.tables.forEach((table, index) => {
    slide.addTable(
      [
        table.headers.map((text) => ({ text })),
        ...table.rows.map((row) => row.map((text) => ({ text }))),
      ],
      {
        x: 0.8,
        y: 2.75 + index * 1.35,
        w: 5.7,
        h: 1.05,
        fontFace: editableFontFace,
        fontSize: 16,
        color: '172033',
        border: { type: 'solid', color: 'D0D5DD', pt: 1 },
        fill: { color: 'FFFFFF' },
        margin: 4,
        bold: false,
      },
    );
  });

  spec.charts.forEach((chart, index) => {
    slide.addChart(
      chartType(chart),
      chart.series.map((series) => ({
        name: series.name,
        labels: [...chart.categories],
        values: [...series.values],
      })),
      {
        x: 6.9,
        y: 2.55 + index * 0.2,
        w: 5.7,
        h: 3.8,
        showLegend: chart.series.length > 1,
        showTitle: false,
        showValue: true,
        chartColors: ['2563EB', '14B8A6', 'F59E0B'],
        catAxisLabelFontFace: editableFontFace,
        valAxisLabelFontFace: editableFontFace,
      },
    );
  });

  spec.shapes.forEach((shape) => addEditableShape(pptx, slide, shape));
}

function chartType(chart: SlideChart): PptxGenJS.CHART_NAME {
  return chart.type;
}

function addEditableShape(
  pptx: PptxGenJS,
  slide: PptxGenJS.Slide,
  shape: SlideShape,
): void {
  const type =
    shape.type === 'ellipse'
      ? pptx.ShapeType.ellipse
      : shape.type === 'line'
        ? pptx.ShapeType.line
        : pptx.ShapeType.rect;
  slide.addShape(type, {
    x: shape.x,
    y: shape.y,
    w: shape.w,
    h: shape.h,
    fill:
      shape.type === 'line'
        ? { color: 'FFFFFF', transparency: 100 }
        : { color: shape.fill ?? '2563EB' },
    line: { color: shape.line ?? shape.fill ?? '2563EB', pt: 1 },
  });
  if (shape.text) {
    slide.addText(shape.text, {
      x: shape.x,
      y: shape.y,
      w: shape.w,
      h: shape.h,
      fontFace: editableFontFace,
      fontSize: 16,
      color: '172033',
      align: 'center',
      valign: 'middle',
      margin: 2,
    });
  }
}

function sourceNotes(spec: SlideSpec): string {
  return [
    '[Sources]',
    ...spec.sourceMap.map(
      (source) =>
        `- ${source.title} — ${source.locator}${source.url ? ` — ${source.url}` : ''}`,
    ),
  ].join('\n');
}
