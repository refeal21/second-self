import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import {
  NativePptRpcRuntime,
  createNativePipeline,
  type NativePptPipeline,
} from './native-pipeline.js';

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../..',
);
const pngPath = join(
  repositoryRoot,
  'fixtures/golden-project/sources/market-background.png',
);

const onePixelPngBase64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

function tofuPageBase64(): string {
  const png = new PNG({ width: 1280, height: 720, colorType: 6 });
  png.data.fill(255);
  for (let glyph = 0; glyph < 4; glyph += 1) {
    const left = 100 + glyph * 42;
    const top = 80;
    for (let y = top; y < top + 30; y += 1) {
      for (let x = left; x < left + 30; x += 1) {
        if (x === left || x === left + 29 || y === top || y === top + 29) {
          const offset = (y * png.width + x) * 4;
          png.data[offset] = 20;
          png.data[offset + 1] = 20;
          png.data[offset + 2] = 20;
          png.data[offset + 3] = 255;
        }
      }
    }
  }
  return PNG.sync.write(png).toString('base64');
}

function intakePipeline(): NativePptPipeline {
  const pipeline = createNativePipeline({
    id: 'project-native',
    name: '原生生产链路',
    goal: '验证完整 PPT 工作流',
    createdAt: '2026-09-03T02:00:00.000Z',
    preferenceSnapshot: [
      {
        proposalId: 'memory-visual',
        title: '图表优先',
        content: '关键数字优先使用图表。',
        approvedAt: '2026-09-03T01:00:00.000Z',
      },
    ],
  });
  pipeline.sources.push({
    id: 'source-kpis',
    fileName: 'kpis.csv',
    mediaType: 'text/csv',
    relativePath: 'sources/source-kpis-kpis.csv',
    sha256: 'a'.repeat(64),
    byteLength: 10,
  });
  return pipeline;
}

const analysis = {
  findings: [
    {
      id: 'finding-growth',
      text: '收入持续增长。',
      sourceIds: ['source-kpis'],
    },
  ],
  dataPoints: [
    {
      id: 'data-revenue',
      label: '营业收入',
      value: 128,
      unit: '百万元',
      sourceIds: ['source-kpis'],
    },
  ],
  sourceMap: [
    { sourceId: 'source-kpis', title: '经营指标', locator: '第 2 行' },
  ],
};

const outline = {
  title: '经营复盘',
  slides: [
    {
      id: 'slide-cover',
      title: '经营复盘',
      purpose: '建立汇报主题',
      sourceIds: ['source-kpis'],
      findingIds: ['finding-growth'],
    },
    {
      id: 'slide-kpi',
      title: '核心指标',
      purpose: '展示收入',
      sourceIds: ['source-kpis'],
      dataPointIds: ['data-revenue'],
    },
  ],
};

const specs = [
  {
    id: 'slide-cover',
    title: '经营复盘',
    body: ['管理层汇报'],
    findingIds: ['finding-growth'],
    tables: [],
    charts: [],
    shapes: [],
    sourceMap: analysis.sourceMap,
    imageGenerationBrief: '完整 16:9 封面，不要生成文字。',
  },
  {
    id: 'slide-kpi',
    title: '核心指标',
    body: ['营业收入达到 1.28 亿元。'],
    dataPointIds: ['data-revenue'],
    tables: [],
    charts: [
      {
        id: 'chart-revenue',
        type: 'bar' as const,
        categories: ['2025', '2026'],
        series: [{ name: '营业收入', values: [108, 128] }],
      },
    ],
    shapes: [],
    sourceMap: analysis.sourceMap,
    imageGenerationBrief: '完整 16:9 数据页，不要生成文字。',
  },
];

describe('packaged native PPT workflow runtime', () => {
  it('executes the real legal stages, blocks unavailable ImageGen, accepts replacements, and exports editable PPTX', async () => {
    const runtime = new NativePptRpcRuntime({ imageGenAvailable: false });
    await runtime.restore(intakePipeline());

    let result = await runtime.execute('project-native', {
      kind: 'analysis.commit',
      at: '2026-09-03T02:01:00.000Z',
      requestId: 'request-analysis',
      output: analysis,
    });
    expect(result.pipeline.project.workflowStatus).toBe('source_analysis');
    expect(result.writes.map(({ relativePath }) => relativePath)).toEqual([
      'sources/request-analysis-analysis.json',
    ]);

    result = await runtime.execute('project-native', {
      kind: 'outline.submit',
      at: '2026-09-03T02:02:00.000Z',
      outline,
    });
    expect(result.pipeline.project.workflowStatus).toBe('outline_review');
    expect(result.pipeline.outline?.version.status).toBe('draft');

    const editedOutline = structuredClone(outline);
    editedOutline.slides[0]!.title = '经营复盘（用户修改）';
    result = await runtime.execute('project-native', {
      kind: 'outline.submit',
      at: '2026-09-03T02:02:30.000Z',
      outline: editedOutline,
    });
    expect(result.pipeline.outline?.value.slides[0]?.title).toBe('经营复盘（用户修改）');
    expect(result.pipeline.outline?.version).toMatchObject({ sequence: 1, status: 'draft' });

    result = await runtime.execute('project-native', {
      kind: 'outline.approve',
      at: '2026-09-03T02:03:00.000Z',
    });
    expect(result.pipeline.project.workflowStatus).toBe('detail_review');
    expect(result.pipeline.approvals).toHaveLength(1);

    result = await runtime.execute('project-native', {
      kind: 'details.submit',
      at: '2026-09-03T02:04:00.000Z',
      specs,
    });
    expect(result.pipeline.slideSpecs?.version.status).toBe('draft');

    const editedSpecs = structuredClone(specs);
    editedSpecs[0]!.body = ['用户修改后的管理层汇报'];
    result = await runtime.execute('project-native', {
      kind: 'details.submit',
      at: '2026-09-03T02:04:30.000Z',
      specs: editedSpecs,
    });
    expect(result.pipeline.slideSpecs?.value[0]?.body).toEqual(['用户修改后的管理层汇报']);
    expect(result.pipeline.slideSpecs?.version).toMatchObject({ sequence: 1, status: 'draft' });

    result = await runtime.execute('project-native', {
      kind: 'details.approve',
      at: '2026-09-03T02:05:00.000Z',
    });
    expect(result.pipeline.project.workflowStatus).toBe('visual_review');
    expect(result.pipeline.currentSlideId).toBe('slide-cover');

    result = await runtime.execute('project-native', {
      kind: 'visual.generate',
      at: '2026-09-03T02:06:00.000Z',
      slideId: 'slide-cover',
    });
    expect(result.pipeline).toMatchObject({
      project: { workflowStatus: 'blocked' },
      blockedCondition: {
        capability: 'image_gen.imagegen',
        resumeStage: 'visual_review',
        slideId: 'slide-cover',
      },
    });

    await expect(runtime.execute('project-native', {
      kind: 'visual.replace',
      at: '2026-09-03T02:06:30.000Z',
      slideId: 'slide-cover',
      imageBase64: onePixelPngBase64,
      altText: '无效的一像素占位图',
    })).rejects.toThrow('16:9');

    const imageBase64 = (await readFile(pngPath)).toString('base64');
    result = await runtime.execute('project-native', {
      kind: 'visual.replace',
      at: '2026-09-03T02:07:00.000Z',
      slideId: 'slide-cover',
      imageBase64,
      altText: '用户替换的完整封面',
    });
    expect(result.pipeline.project.workflowStatus).toBe('visual_review');
    expect(result.writes[0]).toMatchObject({
      kind: 'approved-visual-candidate',
      relativePath: 'visuals/slide-cover-v1.png',
    });

    result = await runtime.execute('project-native', {
      kind: 'visual.approve',
      at: '2026-09-03T02:08:00.000Z',
      slideId: 'slide-cover',
    });
    expect(result.pipeline.currentSlideId).toBe('slide-kpi');
    await expect(
      runtime.execute('project-native', {
        kind: 'visual.approve',
        at: '2026-09-03T02:08:30.000Z',
        slideId: 'slide-kpi',
      }),
    ).rejects.toThrow('no visual candidate');

    await runtime.execute('project-native', {
      kind: 'visual.replace',
      at: '2026-09-03T02:09:00.000Z',
      slideId: 'slide-kpi',
      imageBase64,
      altText: '用户替换的完整指标页',
    });
    result = await runtime.execute('project-native', {
      kind: 'visual.approve',
      at: '2026-09-03T02:10:00.000Z',
      slideId: 'slide-kpi',
    });
    expect(result.pipeline.project.workflowStatus).toBe('conversion');
    expect(result.pipeline.visuals['slide-cover']).toHaveLength(1);

    result = await runtime.execute('project-native', {
      kind: 'visual.reopen',
      at: '2026-09-03T02:10:10.000Z',
      slideId: 'slide-cover',
    });
    expect(result.pipeline.project.workflowStatus).toBe('visual_review');
    expect(result.pipeline.visuals['slide-cover']).toHaveLength(2);
    await runtime.execute('project-native', {
      kind: 'visual.replace',
      at: '2026-09-03T02:10:20.000Z',
      slideId: 'slide-cover', imageBase64, altText: '重新打开后替换',
    });
    await runtime.execute('project-native', {
      kind: 'visual.approve',
      at: '2026-09-03T02:10:30.000Z',
      slideId: 'slide-cover',
    });
    result = { pipeline: runtime.snapshot('project-native'), writes: [], message: '' };
    expect(result.pipeline.project.workflowStatus).toBe('conversion');

    result = await runtime.execute('project-native', {
      kind: 'deck.export',
      at: '2026-09-03T02:11:00.000Z',
      fileName: '经营复盘.pptx',
      visualBytes: {
        'slide-cover': imageBase64,
        'slide-kpi': imageBase64,
      },
    });
    expect(result.pipeline.project.workflowStatus).toBe('qa');
    const pptxWrite = result.writes.find(({ kind }) => kind === 'pptx');
    expect(pptxWrite?.relativePath).toBe('exports/经营复盘.pptx');
    const pptx = await JSZip.loadAsync(Buffer.from(pptxWrite!.contentsBase64, 'base64'));
    expect(await pptx.file('ppt/slides/slide2.xml')!.async('string')).toContain(
      '<c:chart',
    );

    result = await runtime.execute('project-native', {
      kind: 'deck.qa',
      at: '2026-09-03T02:11:30.000Z',
      preparation: {
        status: 'ready', sofficePath: '/Applications/LibreOffice.app/Contents/MacOS/soffice',
        rendererPath: '/mock/pdftoppm', pdfBase64: Buffer.from('pdf').toString('base64'),
        pptxBase64: pptxWrite!.contentsBase64,
        renderedPages: [
          { fileName: 'rendered-1.png', contentsBase64: tofuPageBase64() },
          { fileName: 'rendered-2.png', contentsBase64: tofuPageBase64() },
        ],
        approvedVisuals: [
          { slideId: 'slide-cover', relativePath: 'visuals/slide-cover-v2.png', contentsBase64: imageBase64 },
          { slideId: 'slide-kpi', relativePath: 'visuals/slide-kpi-v1.png', contentsBase64: imageBase64 },
        ],
        fontAvailability: { 'Hiragino Sans GB': true },
      },
    });
    expect(result.pipeline).toMatchObject({
      project: { workflowStatus: 'blocked' },
      qaReport: { round: 1, status: 'failed', issues: expect.arrayContaining([
        expect.stringContaining('tofu'),
      ]) },
      blockedCondition: { resumeStage: 'qa', capability: 'qa-rendering' },
    });

    result = await runtime.execute('project-native', {
      kind: 'deck.qa',
      at: '2026-09-03T02:12:00.000Z',
      preparation: {
        status: 'ready', sofficePath: '/Applications/LibreOffice.app/Contents/MacOS/soffice',
        rendererPath: 'pdftoppm', pdfBase64: Buffer.from('pdf').toString('base64'),
        pptxBase64: pptxWrite!.contentsBase64,
        renderedPages: [
          { fileName: 'rendered-1.png', contentsBase64: imageBase64 },
          { fileName: 'rendered-2.png', contentsBase64: imageBase64 },
        ],
        approvedVisuals: [
          { slideId: 'slide-cover', relativePath: 'visuals/slide-cover-v2.png', contentsBase64: imageBase64 },
          { slideId: 'slide-kpi', relativePath: 'visuals/slide-kpi-v1.png', contentsBase64: imageBase64 },
        ],
        fontAvailability: { 'Hiragino Sans GB': true },
      },
    });
    expect(result.pipeline.project.workflowStatus).toBe('completed');
    expect(result.pipeline.qaReport).toMatchObject({ round: 2, status: 'passed', actualPageCount: 2 });
    expect(result.writes.map(({ relativePath }) => relativePath)).toEqual(expect.arrayContaining([
      'qa/run-2/rendered-1.png', 'qa/run-2/rendered-2.png',
      'qa/qa-round-2.json', 'qa/qa-round-2.txt',
    ]));

    const restarted = new NativePptRpcRuntime({ imageGenAvailable: false });
    await expect(restarted.restore(result.pipeline)).resolves.toEqual(result.pipeline);
  });

  it('restores an authoritative full snapshot into a fresh Worker process', async () => {
    const first = new NativePptRpcRuntime({ imageGenAvailable: false });
    await first.restore(intakePipeline());
    await first.execute('project-native', {
      kind: 'analysis.commit',
      at: '2026-09-03T02:01:00.000Z',
      requestId: 'request-analysis',
      output: analysis,
    });
    await first.execute('project-native', {
      kind: 'outline.submit',
      at: '2026-09-03T02:02:00.000Z',
      outline,
    });
    await first.execute('project-native', {
      kind: 'outline.approve',
      at: '2026-09-03T02:03:00.000Z',
    });
    await first.execute('project-native', {
      kind: 'details.submit',
      at: '2026-09-03T02:04:00.000Z',
      specs,
    });
    const persisted = first.snapshot('project-native');

    const restarted = new NativePptRpcRuntime({ imageGenAvailable: false });
    const restored = await restarted.restore(persisted);

    expect(restored).toEqual(persisted);
    expect(restored.outline?.value.slides).toHaveLength(2);
    expect(restored.slideSpecs?.value[1]?.charts[0]?.id).toBe('chart-revenue');
    expect(restored.preferenceSnapshot[0]?.content).toBe('关键数字优先使用图表。');
  });

  it('restores analysis provenance after Rust JSON object-key canonicalization', async () => {
    const first = new NativePptRpcRuntime({ imageGenAvailable: false });
    await first.restore(intakePipeline());
    const result = await first.execute('project-native', {
      kind: 'analysis.commit',
      at: '2026-09-03T02:01:00.000Z',
      requestId: 'request-analysis',
      output: analysis,
    });
    const persisted = structuredClone(result.pipeline);
    persisted.analysis!.output = {
      dataPoints: persisted.analysis!.output.dataPoints,
      findings: persisted.analysis!.output.findings,
      sourceMap: persisted.analysis!.output.sourceMap,
    };

    const restarted = new NativePptRpcRuntime({ imageGenAvailable: false });
    await expect(restarted.restore(persisted)).resolves.toEqual(persisted);
  });
});
