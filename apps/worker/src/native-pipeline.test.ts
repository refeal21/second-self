import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import {
  NativePptRpcRuntime,
  createNativePipeline,
  parseNativePipelineAction,
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

async function runtimeAtVisualReview(): Promise<NativePptRpcRuntime> {
  const runtime = new NativePptRpcRuntime({ imageGenAvailable: false });
  await runtime.restore(intakePipeline());
  await runtime.execute('project-native', {
    kind: 'analysis.commit',
    at: '2026-09-03T02:01:00.000Z',
    requestId: 'request-analysis',
    output: analysis,
  });
  await runtime.execute('project-native', {
    kind: 'outline.submit',
    at: '2026-09-03T02:02:00.000Z',
    outline,
  });
  await runtime.execute('project-native', {
    kind: 'outline.approve',
    at: '2026-09-03T02:03:00.000Z',
  });
  await runtime.execute('project-native', {
    kind: 'details.submit',
    at: '2026-09-03T02:04:00.000Z',
    specs,
  });
  await runtime.execute('project-native', {
    kind: 'details.approve',
    at: '2026-09-03T02:05:00.000Z',
  });
  return runtime;
}

describe('packaged native PPT workflow runtime', () => {
  it('persists prompt context and keeps source attachment revisions restorable', async () => {
    const runtime = new NativePptRpcRuntime({ imageGenAvailable: false });
    const pipeline = createNativePipeline({
      id: 'project-context', name: '汇报', goal: '支持决策', createdAt: '2026-09-03T00:00:00.000Z',
    });
    const updated = await runtime.restore(pipeline).then(() => runtime.execute('project-context', {
      kind: 'context.update', at: '2026-09-03T00:01:00.000Z',
      context: { taskBrief: '做一份董事会汇报', sourceInstructions: {}, outlineRequirements: '先结论后证据' },
    }));
    expect(updated.pipeline.promptContext).toEqual({
      taskBrief: '做一份董事会汇报', sourceInstructions: {}, outlineRequirements: '先结论后证据',
    });
    expect(updated.pipeline.tasks.at(-1)?.kind).toBe('prompt_context_update');

    const noOp = await runtime.execute('project-context', {
      kind: 'context.update', at: '2026-09-03T00:01:30.000Z', context: updated.pipeline.promptContext!,
    });
    expect(noOp.pipeline.tasks.at(-1)?.kind).toBe('prompt_context_update');
    noOp.pipeline.sources.push({
      id: 'source-later', fileName: 'later.csv', mediaType: 'text/csv',
      relativePath: 'sources/source-later.bin', sha256: 'b'.repeat(64), byteLength: 4,
    });
    noOp.pipeline.revision += 1;
    const restarted = new NativePptRpcRuntime({ imageGenAvailable: false });
    await expect(restarted.restore(noOp.pipeline)).resolves.toEqual(noOp.pipeline);
    const analyzed = await restarted.execute('project-context', {
      kind: 'analysis.commit', at: '2026-09-03T00:03:00.000Z', requestId: 'request-later',
      output: {
        findings: [{ id: 'finding-later', text: '后附件结论', sourceIds: ['source-later'] }],
        dataPoints: [],
        sourceMap: [{ sourceId: 'source-later', title: '后附件', locator: '第 1 行' }],
      },
    });
    const restartedAgain = new NativePptRpcRuntime({ imageGenAvailable: false });
    await expect(restartedAgain.restore(analyzed.pipeline)).resolves.toEqual(analyzed.pipeline);
  });

  it('restores a complete early workflow after reset and later intake source attachments', async () => {
    const initial = createNativePipeline({
      id: 'project-reset-attachments', name: '追加材料', goal: '重新分析',
      createdAt: '2026-09-03T00:00:00.000Z',
    });
    initial.sources.push({
      id: 'source-one', fileName: 'one.csv', mediaType: 'text/csv',
      relativePath: 'sources/source-one.bin', sha256: '1'.repeat(64), byteLength: 1,
    });
    initial.revision = 2;
    const first = new NativePptRpcRuntime({ imageGenAvailable: false });
    await first.restore(initial);
    await first.execute('project-reset-attachments', {
      kind: 'analysis.commit', at: 'r3', requestId: 'request-first',
      output: {
        findings: [{ id: 'finding-one', text: '首次分析', sourceIds: ['source-one'] }],
        dataPoints: [], sourceMap: [{ sourceId: 'source-one', title: '材料一', locator: '第 1 行' }],
      },
    });
    const reset = await first.execute('project-reset-attachments', {
      kind: 'context.update', at: 'r4',
      context: { taskBrief: '重新分析新材料', sourceInstructions: {}, outlineRequirements: '' },
    });
    reset.pipeline.sources.push(
      { id: 'source-two', fileName: 'two.csv', mediaType: 'text/csv', relativePath: 'sources/source-two.bin', sha256: '2'.repeat(64), byteLength: 2 },
      { id: 'source-three', fileName: 'three.csv', mediaType: 'text/csv', relativePath: 'sources/source-three.bin', sha256: '3'.repeat(64), byteLength: 3 },
    );
    reset.pipeline.revision = 6;
    const second = new NativePptRpcRuntime({ imageGenAvailable: false });
    await second.restore(reset.pipeline);
    await second.execute('project-reset-attachments', {
      kind: 'context.update', at: 'r7',
      context: {
        taskBrief: '重新分析新材料', outlineRequirements: '',
        sourceInstructions: { 'source-two': '重点阅读', 'source-three': '只做交叉验证' },
      },
    });
    const refreshedAnalysis = {
      findings: [{ id: 'finding-refreshed', text: '追加后结论', sourceIds: ['source-one', 'source-two'] }],
      dataPoints: [],
      sourceMap: [
        { sourceId: 'source-one', title: '材料一', locator: '第 1 行' },
        { sourceId: 'source-two', title: '材料二', locator: '第 1 行' },
      ],
    };
    await second.execute('project-reset-attachments', {
      kind: 'analysis.commit', at: 'r8', requestId: 'request-refreshed', output: refreshedAnalysis,
    });
    const refreshedOutline = {
      title: '追加材料复盘', slides: [{
        id: 'slide-one', title: '新结论', purpose: '呈现追加后结论',
        sourceIds: ['source-one', 'source-two'], findingIds: ['finding-refreshed'],
      }],
    };
    await second.execute('project-reset-attachments', {
      kind: 'outline.submit', at: 'r9', outline: refreshedOutline,
    });
    await second.execute('project-reset-attachments', { kind: 'outline.approve', at: 'r10' });
    const detailed = await second.execute('project-reset-attachments', {
      kind: 'details.submit', at: 'r11', specs: [{
        id: 'slide-one', title: '新结论', body: ['追加后结论'], findingIds: ['finding-refreshed'],
        tables: [], charts: [], shapes: [], sourceMap: refreshedAnalysis.sourceMap,
        imageGenerationBrief: '无文字 16:9 背景',
      }],
    });
    const restarted = new NativePptRpcRuntime({ imageGenAvailable: false });
    await expect(restarted.restore(detailed.pipeline)).resolves.toEqual(detailed.pipeline);
  });

  it('invalidates analysis and draft outline when analysis prompt inputs change', async () => {
    const runtime = new NativePptRpcRuntime({ imageGenAvailable: false });
    await runtime.restore(intakePipeline());
    await runtime.execute('project-native', {
      kind: 'analysis.commit', at: '2026-09-03T02:01:00.000Z', requestId: 'request-analysis', output: analysis,
    });
    await runtime.execute('project-native', {
      kind: 'outline.submit', at: '2026-09-03T02:02:00.000Z', outline,
    });
    const result = await runtime.execute('project-native', {
      kind: 'context.update', at: '2026-09-03T02:03:00.000Z',
      context: {
        taskBrief: '重新聚焦海外增长', sourceInstructions: { 'source-kpis': '只使用已审计数据' },
        outlineRequirements: '保留五页',
      },
    });
    expect(result.pipeline).toMatchObject({
      project: { workflowStatus: 'intake' }, analysis: null, outline: null, slideSpecs: null,
      promptContext: { taskBrief: '重新聚焦海外增长' },
    });
    expect(result.pipeline.tasks.map(({ kind }) => kind)).toEqual([
      'source_analysis', 'outline_generation', 'prompt_context_analysis_reset',
    ]);
    expect(result.writes).toEqual([]);
    const restarted = new NativePptRpcRuntime({ imageGenAvailable: false });
    await expect(restarted.restore(result.pipeline)).resolves.toEqual(result.pipeline);
  });

  it('keeps analysis but drops a draft outline when only outline requirements change', async () => {
    const runtime = new NativePptRpcRuntime({ imageGenAvailable: false });
    await runtime.restore(intakePipeline());
    await runtime.execute('project-native', {
      kind: 'analysis.commit', at: '2026-09-03T02:01:00.000Z', requestId: 'request-analysis', output: analysis,
    });
    await runtime.execute('project-native', {
      kind: 'outline.submit', at: '2026-09-03T02:02:00.000Z', outline,
    });
    const result = await runtime.execute('project-native', {
      kind: 'context.update', at: '2026-09-03T02:03:00.000Z',
      context: { taskBrief: '', sourceInstructions: {}, outlineRequirements: '每页只有一个结论' },
    });
    expect(result.pipeline.project.workflowStatus).toBe('source_analysis');
    expect(result.pipeline.analysis).not.toBeNull();
    expect(result.pipeline.outline).toBeNull();
    expect(result.pipeline.tasks.at(-1)?.kind).toBe('prompt_context_outline_reset');
    expect(result.writes).toEqual([]);
    const restarted = new NativePptRpcRuntime({ imageGenAvailable: false });
    await expect(restarted.restore(result.pipeline)).resolves.toEqual(result.pipeline);
  });

  it('rejects forged context keys, oversized UTF-8 values, unknown sources, and frozen stages', async () => {
    expect(() => parseNativePipelineAction({
      kind: 'context.update', at: 'now',
      context: { taskBrief: '', sourceInstructions: {}, outlineRequirements: '', extra: true },
    })).toThrow('missing or unknown fields');
    expect(() => parseNativePipelineAction({
      kind: 'context.update', at: 'now',
      context: { taskBrief: '中'.repeat(7_000), sourceInstructions: {}, outlineRequirements: '' },
    })).toThrow('20,000 bytes');

    const runtime = new NativePptRpcRuntime({ imageGenAvailable: false });
    await runtime.restore(intakePipeline());
    await expect(runtime.execute('project-native', {
      kind: 'context.update', at: 'now',
      context: { taskBrief: '', sourceInstructions: { 'source-missing': '不应接受' }, outlineRequirements: '' },
    })).rejects.toThrow('unknown source');
    await runtime.execute('project-native', {
      kind: 'analysis.commit', at: 'a', requestId: 'request-analysis', output: analysis,
    });
    await runtime.execute('project-native', { kind: 'outline.submit', at: 'b', outline });
    await runtime.execute('project-native', { kind: 'outline.approve', at: 'c' });
    await expect(runtime.execute('project-native', {
      kind: 'context.update', at: 'd',
      context: { taskBrief: '', sourceInstructions: {}, outlineRequirements: '太晚' },
    })).rejects.toThrow('before outline approval');
  });

  it('rejects a forged reset that erases a frozen outline and approvals', async () => {
    const runtime = new NativePptRpcRuntime({ imageGenAvailable: false });
    await runtime.restore(intakePipeline());
    await runtime.execute('project-native', {
      kind: 'analysis.commit', at: 'a', requestId: 'request-analysis', output: analysis,
    });
    await runtime.execute('project-native', { kind: 'outline.submit', at: 'b', outline });
    const approved = await runtime.execute('project-native', { kind: 'outline.approve', at: 'c' });
    const forged = structuredClone(approved.pipeline);
    forged.revision += 1;
    forged.project.updatedAt = 'd';
    forged.project.workflowStatus = 'intake';
    forged.promptContext = { taskBrief: '伪造', sourceInstructions: {}, outlineRequirements: '' };
    forged.analysis = null;
    forged.outline = null;
    forged.approvals = [];
    forged.tasks.push({
      id: `project-native-task-${forged.revision}-prompt_context_analysis_reset`,
      kind: 'prompt_context_analysis_reset', status: 'completed', createdAt: 'd', updatedAt: 'd', error: null,
    });
    const restarted = new NativePptRpcRuntime({ imageGenAvailable: false });
    await expect(restarted.restore(forged)).rejects.toThrow('chronology');
  });

  it('rejects unexplained approval-sized revision gaps before a context reset', async () => {
    const runtime = new NativePptRpcRuntime({ imageGenAvailable: false });
    await runtime.restore(intakePipeline());
    await runtime.execute('project-native', {
      kind: 'analysis.commit', at: 'a', requestId: 'request-analysis', output: analysis,
    });
    const draft = await runtime.execute('project-native', { kind: 'outline.submit', at: 'b', outline });
    const forged = structuredClone(draft.pipeline);
    forged.revision += 2;
    forged.project.updatedAt = 'd';
    forged.project.workflowStatus = 'intake';
    forged.promptContext = { taskBrief: '伪造', sourceInstructions: {}, outlineRequirements: '' };
    forged.analysis = null;
    forged.outline = null;
    forged.tasks.push({
      id: `project-native-task-${forged.revision}-prompt_context_analysis_reset`,
      kind: 'prompt_context_analysis_reset', status: 'completed', createdAt: 'd', updatedAt: 'd', error: null,
    });
    const restarted = new NativePptRpcRuntime({ imageGenAvailable: false });
    await expect(restarted.restore(forged)).rejects.toThrow('chronology');
  });

  it('retains strict legacy revision provenance when prompt context was never used', async () => {
    const forgedIntake = intakePipeline();
    forgedIntake.revision = 999;
    await expect(new NativePptRpcRuntime({ imageGenAvailable: false }).restore(forgedIntake))
      .rejects.toThrow('Intake revision provenance');

    const runtime = new NativePptRpcRuntime({ imageGenAvailable: false });
    await runtime.restore(intakePipeline());
    const analyzed = await runtime.execute('project-native', {
      kind: 'analysis.commit', at: 'a', requestId: 'request-analysis', output: analysis,
    });
    const forgedAnalysis = structuredClone(analyzed.pipeline);
    forgedAnalysis.revision = 4;
    forgedAnalysis.tasks[0]!.id = 'project-native-task-4-source_analysis';
    await expect(new NativePptRpcRuntime({ imageGenAvailable: false }).restore(forgedAnalysis))
      .rejects.toThrow('Source attachment revision provenance');
  });

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
      expectedRevision: result.pipeline.revision,
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

  it('supersedes an unapproved visual candidate when replacing it again', async () => {
    const runtime = await runtimeAtVisualReview();
    const imageBase64 = (await readFile(pngPath)).toString('base64');
    const first = await runtime.execute('project-native', {
      kind: 'visual.replace',
      at: '2026-09-03T02:06:00.000Z',
      slideId: 'slide-cover',
      imageBase64,
      altText: '第一版真实封面候选',
    });
    const frozenSpecs = structuredClone(first.pipeline.slideSpecs);
    const approvals = structuredClone(first.pipeline.approvals);

    const second = await runtime.execute('project-native', {
      kind: 'visual.replace',
      at: '2026-09-03T02:07:00.000Z',
      slideId: 'slide-cover',
      imageBase64,
      altText: '第二版真实封面候选',
    });

    expect(second.pipeline.visuals['slide-cover']).toMatchObject([
      {
        version: { sequence: 1, status: 'superseded', frozenAt: null },
        relativePath: 'visuals/slide-cover-v1.png',
        altText: '第一版真实封面候选',
      },
      {
        version: { sequence: 2, status: 'draft', frozenAt: null },
        relativePath: 'visuals/slide-cover-v2.png',
        altText: '第二版真实封面候选',
      },
    ]);
    expect(second.pipeline.approvals).toEqual(approvals);
    expect(second.pipeline.slideSpecs).toEqual(frozenSpecs);
    expect(second.writes).toMatchObject([
      { relativePath: 'visuals/slide-cover-v2.png', kind: 'approved-visual-candidate' },
    ]);

    const restarted = new NativePptRpcRuntime({ imageGenAvailable: false });
    await expect(restarted.restore(second.pipeline)).resolves.toEqual(second.pipeline);

    const latestSuperseded = structuredClone(second.pipeline);
    latestSuperseded.visuals['slide-cover']![1]!.version.status = 'superseded';
    await expect(new NativePptRpcRuntime({ imageGenAvailable: false }).restore(latestSuperseded))
      .rejects.toThrow('Superseded visual artifact provenance');

    const missingHistoricalArtifact = structuredClone(second.pipeline);
    Object.assign(missingHistoricalArtifact.visuals['slide-cover']![0]!, {
      relativePath: '', sha256: '', byteLength: 0,
    });
    await expect(new NativePptRpcRuntime({ imageGenAvailable: false }).restore(missingHistoricalArtifact))
      .rejects.toThrow('Superseded visual artifact provenance');
  });

  it('does not allow superseded status outside visual history', async () => {
    const runtime = await runtimeAtVisualReview();
    const forged = runtime.snapshot('project-native');
    forged.slideSpecs!.version.status = 'superseded';

    await expect(new NativePptRpcRuntime({ imageGenAvailable: false }).restore(forged))
      .rejects.toThrow('Version provenance is invalid');
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
