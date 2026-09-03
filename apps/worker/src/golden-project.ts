import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createProductionPptWorkflow,
  type PptOutline,
  type SlideSpec,
  type SourceAnalysis,
} from './ppt-project.js';
import {
  formatQaReadableSummary,
  type LibreOfficeQaOptions,
  type LibreOfficeQaReport,
} from './libreoffice-qa.js';
import { LocalWorkspaceArtifacts } from './workspace-artifacts.js';

const projectId = 'golden-project';
const slideIds = [
  'slide-cover',
  'slide-summary',
  'slide-kpis',
  'slide-table',
  'slide-chart',
] as const;

const sourceFiles = [
  {
    id: 'source-report',
    fileName: 'management-memo.pdf',
    mediaType: 'application/pdf',
  },
  {
    id: 'source-kpis',
    fileName: 'kpis.csv',
    mediaType: 'text/csv',
  },
  {
    id: 'source-market',
    fileName: 'market-background.png',
    mediaType: 'image/png',
  },
  {
    id: 'source-style',
    fileName: 'style-reference.pptx',
    mediaType:
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  },
] as const;

export interface GoldenProjectOptions {
  fixtureRoot: string;
  workspaceRoot: string;
  qaOptions?: LibreOfficeQaOptions;
}

export interface GoldenProjectResult {
  projectId: string;
  workflowStatus: string;
  pptxPath: string;
  sourceMapPath: string;
  readableQaPath: string;
  qaReport: LibreOfficeQaReport;
  repairRounds: number;
  approvedVisualPaths: readonly string[];
  skipGuards: {
    outlineBeforeAnalysis: boolean;
    detailsBeforeOutlineApproval: boolean;
    visualBeforeDetailsApproval: boolean;
    conversionBeforeAllVisualApprovals: boolean;
  };
}

export async function runGoldenProject(
  options: GoldenProjectOptions,
): Promise<GoldenProjectResult> {
  const sourceAnalysis = goldenSourceAnalysis();
  const outline = goldenOutline();
  const specs = goldenSlideSpecs();
  const background = new Uint8Array(
    await readFile(join(options.fixtureRoot, 'sources', 'market-background.png')),
  );
  const workflow = createProductionPptWorkflow({
    workspaceRoot: options.workspaceRoot,
    sourceAnalysisGateway: { analyze: async () => sourceAnalysis },
    outlineGenerationGateway: { generate: async () => outline },
    slideSpecGenerationGateway: { generate: async () => specs },
    imageGenTurnRunner: {
      listCapabilities: async () => [
        { id: 'image_gen.imagegen', status: 'available' as const },
      ],
      runImageGenTurn: async ({ slideId }) => ({
        status: 'generated' as const,
        image: background,
        mediaType: 'image/png' as const,
        usage:
          slideId === 'slide-chart'
            ? ('text_free_background' as const)
            : ('full_slide_reference' as const),
        textFree: slideId === 'slide-chart',
        altText:
          slideId === 'slide-chart'
            ? '无文字的蓝色抽象市场背景'
            : `第 ${slideIds.indexOf(slideId as (typeof slideIds)[number]) + 1} 页批准视觉参考`,
      }),
    },
    repairer: {
      repair: async () => {
        throw new Error(
          'Golden Project is deterministic and should not require automatic repair',
        );
      },
    },
    qaOptions: options.qaOptions,
  });

  await workflow.projects.createProject({
    id: projectId,
    name: '五页中文经营复盘 Golden Project',
    createdAt: '2026-09-03T00:00:00.000Z',
  });
  for (const source of sourceFiles) {
    await workflow.projects.attachSource(projectId, {
      ...source,
      contents: new Uint8Array(
        await readFile(join(options.fixtureRoot, 'sources', source.fileName)),
      ),
    });
  }

  const skipGuards = {
    outlineBeforeAnalysis: await rejects(() =>
      workflow.outlineGeneration.generate(projectId),
    ),
    detailsBeforeOutlineApproval: false,
    visualBeforeDetailsApproval: false,
    conversionBeforeAllVisualApprovals: false,
  };

  await workflow.sourceAnalysis.request({
    id: 'analysis-golden',
    projectId,
    sourceIds: sourceFiles.map(({ id }) => id),
  });
  await workflow.sourceAnalysis.execute('analysis-golden');
  await workflow.outlineGeneration.generate(projectId);
  skipGuards.detailsBeforeOutlineApproval = await rejects(() =>
    workflow.slideSpecGeneration.generate(projectId),
  );
  workflow.projects.approveOutline(
    projectId,
    '2026-09-03T00:10:00.000Z',
  );
  await workflow.slideSpecGeneration.generate(projectId);
  skipGuards.visualBeforeDetailsApproval = await rejects(() =>
    workflow.visualGeneration.generate(projectId, slideIds[0]),
  );
  workflow.projects.approveSlideSpecs(
    projectId,
    '2026-09-03T00:20:00.000Z',
  );

  const approvedVisualPaths: string[] = [];
  for (const [index, slideId] of slideIds.entries()) {
    const generated = await workflow.visualGeneration.generate(
      projectId,
      slideId,
    );
    if (generated.status !== 'generated') {
      throw new Error(`Golden visual generation blocked for ${slideId}`);
    }
    const decidedAt = `2026-09-03T00:${String(30 + index).padStart(2, '0')}:00.000Z`;
    workflow.projects.approveSlideVisual(
      projectId,
      slideId,
      decidedAt,
      slideId === 'slide-chart'
        ? {
            classification: 'text_free_background',
            approvedForEmbedding: true,
          }
        : { classification: 'reference_only', approvedForEmbedding: false },
    );
    approvedVisualPaths.push(generated.asset.artifactPath);
    if (index === 0) {
      skipGuards.conversionBeforeAllVisualApprovals = await rejects(
        async () => workflow.projects.completeVisualReview(projectId),
      );
    }
  }
  workflow.projects.completeVisualReview(projectId);
  const delivery = await workflow.delivery.deliver(
    projectId,
    'golden-management-report.pptx',
  );
  if (delivery.qaReport.status !== 'passed') {
    throw new Error(
      `Golden Project LibreOffice QA did not pass: ${delivery.qaReport.issues.join('; ')}`,
    );
  }

  const artifacts = new LocalWorkspaceArtifacts(options.workspaceRoot);
  const sourceMapPath = await artifacts.write(
    projectId,
    'exports/source-map.json',
    `${JSON.stringify(sourceAnalysis.sourceMap, null, 2)}\n`,
  );
  const readableQaPath = await artifacts.write(
    projectId,
    'qa/qa-summary.txt',
    `${formatQaReadableSummary(delivery.qaReport)}\n`,
  );
  const snapshot = workflow.projects.getProjectSnapshot(projectId);
  return {
    projectId,
    workflowStatus: snapshot.project.workflowStatus,
    pptxPath: delivery.exportReceipt.artifactPath,
    sourceMapPath,
    readableQaPath,
    qaReport: delivery.qaReport,
    repairRounds: delivery.repairRounds,
    approvedVisualPaths,
    skipGuards,
  };
}

function goldenSourceAnalysis(): SourceAnalysis {
  return {
    findings: [
      {
        id: 'finding-growth',
        text: '2026 年营业收入达到 1.28 亿元，同比增长 18%。',
        sourceIds: ['source-report', 'source-kpis'],
      },
      {
        id: 'finding-quality',
        text: '毛利率提升至 42%，客户续约率达到 91%。',
        sourceIds: ['source-report', 'source-kpis'],
      },
      {
        id: 'finding-priority',
        text: '下一阶段优先推进大客户拓展和交付效率提升。',
        sourceIds: ['source-report'],
      },
      {
        id: 'finding-style',
        text: '视觉参考采用留白、深蓝标题以及蓝绿数据强调。',
        sourceIds: ['source-style', 'source-market'],
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
      {
        id: 'data-margin',
        label: '毛利率',
        value: 42,
        unit: '%',
        sourceIds: ['source-kpis'],
      },
      {
        id: 'data-retention',
        label: '客户续约率',
        value: 91,
        unit: '%',
        sourceIds: ['source-kpis'],
      },
      {
        id: 'data-cycle',
        label: '交付周期',
        value: 31,
        unit: '天',
        sourceIds: ['source-kpis'],
      },
    ],
    sourceMap: [
      {
        sourceId: 'source-report',
        title: '2026 管理层经营备忘录',
        locator: '第 1 页',
      },
      {
        sourceId: 'source-kpis',
        title: '2025—2026 核心经营指标',
        locator: '第 2—5 行',
      },
      {
        sourceId: 'source-market',
        title: '无文字市场背景图',
        locator: '整图',
      },
      {
        sourceId: 'source-style',
        title: '商务汇报视觉参考',
        locator: '第 1 页',
      },
    ],
  };
}

function goldenOutline(): PptOutline {
  return {
    title: '2026 年经营复盘与增长计划',
    slides: [
      {
        id: 'slide-cover',
        title: '2026 年经营复盘与增长计划',
        purpose: '建立汇报主题和管理层语境',
        sourceIds: ['source-report', 'source-style'],
        findingIds: ['finding-style'],
      },
      {
        id: 'slide-summary',
        title: '管理层摘要：增长质量持续改善',
        purpose: '用三条结论说明增长、质量和下一阶段重点',
        sourceIds: ['source-report', 'source-kpis'],
        findingIds: [
          'finding-growth',
          'finding-quality',
          'finding-priority',
        ],
      },
      {
        id: 'slide-kpis',
        title: '三项核心指标均超年度目标',
        purpose: '以可编辑数据卡展示关键指标',
        sourceIds: ['source-kpis'],
        dataPointIds: ['data-revenue', 'data-margin', 'data-retention'],
      },
      {
        id: 'slide-table',
        title: '经营指标对比与效率改善',
        purpose: '以可编辑表格呈现目标和实际差异',
        sourceIds: ['source-kpis'],
        dataPointIds: [
          'data-revenue',
          'data-margin',
          'data-retention',
          'data-cycle',
        ],
      },
      {
        id: 'slide-chart',
        title: '增长路径：规模提升与效率优化并行',
        purpose: '以可编辑图表和无文字背景说明下一阶段路径',
        sourceIds: ['source-kpis', 'source-market'],
        findingIds: ['finding-priority'],
        dataPointIds: ['data-revenue'],
      },
    ],
  };
}

function goldenSlideSpecs(): readonly SlideSpec[] {
  const reportCitation = {
    sourceId: 'source-report',
    title: '2026 管理层经营备忘录',
    locator: '第 1 页',
  };
  const kpiCitation = {
    sourceId: 'source-kpis',
    title: '2025—2026 核心经营指标',
    locator: '第 2—5 行',
  };
  return [
    {
      id: 'slide-cover',
      title: '2026 年经营复盘与增长计划',
      body: ['管理层汇报｜2026 年 9 月'],
      findingIds: ['finding-style'],
      tables: [],
      charts: [],
      shapes: [
        {
          id: 'shape-cover-accent',
          type: 'rect',
          x: 0.75,
          y: 2.45,
          w: 1.1,
          h: 0.12,
          fill: '2563EB',
        },
      ],
      sourceMap: [
        reportCitation,
        {
          sourceId: 'source-style',
          title: '商务汇报视觉参考',
          locator: '第 1 页',
        },
      ],
      imageGenerationBrief: '16:9 商务封面，深蓝与蓝绿几何元素，禁止出现文字。',
    },
    {
      id: 'slide-summary',
      title: '管理层摘要：增长质量持续改善',
      body: [
        '收入同比增长 18%，规模增长保持稳健。',
        '毛利率升至 42%，客户续约率达到 91%。',
        '下一阶段聚焦大客户拓展与交付效率。',
      ],
      findingIds: [
        'finding-growth',
        'finding-quality',
        'finding-priority',
      ],
      dataPointIds: ['data-revenue', 'data-margin', 'data-retention'],
      tables: [],
      charts: [],
      shapes: [
        {
          id: 'shape-summary-accent',
          type: 'line',
          x: 0.8,
          y: 5.9,
          w: 5.5,
          h: 0,
          line: '14B8A6',
        },
      ],
      sourceMap: [reportCitation, kpiCitation],
      imageGenerationBrief: '三段管理层摘要的留白构图参考，不包含任何文字。',
    },
    {
      id: 'slide-kpis',
      title: '三项核心指标均超年度目标',
      body: ['规模、盈利质量和客户粘性同步改善。'],
      dataPointIds: ['data-revenue', 'data-margin', 'data-retention'],
      tables: [],
      charts: [],
      shapes: [
        {
          id: 'shape-revenue-card',
          type: 'rect',
          x: 0.8,
          y: 2.55,
          w: 3.55,
          h: 2.1,
          fill: 'EAF1FF',
          text: '营业收入 1.28 亿元',
        },
        {
          id: 'shape-margin-card',
          type: 'rect',
          x: 4.85,
          y: 2.55,
          w: 3.55,
          h: 2.1,
          fill: 'E7F8F5',
          text: '毛利率 42%',
        },
        {
          id: 'shape-retention-card',
          type: 'rect',
          x: 8.9,
          y: 2.55,
          w: 3.55,
          h: 2.1,
          fill: 'FFF4E5',
          text: '客户续约率 91%',
        },
      ],
      sourceMap: [kpiCitation],
      imageGenerationBrief: '三个无文字数据卡背景参考，保持大面积留白。',
    },
    {
      id: 'slide-table',
      title: '经营指标对比与效率改善',
      body: ['所有表格文本和数值来自已批准规格，可独立编辑。'],
      dataPointIds: [
        'data-revenue',
        'data-margin',
        'data-retention',
        'data-cycle',
      ],
      tables: [
        {
          id: 'table-operating-kpis',
          headers: ['指标', '2025 实际', '2026 目标', '2026 实际'],
          rows: [
            ['营业收入（百万元）', '108', '120', '128'],
            ['毛利率', '37%', '40%', '42%'],
            ['客户续约率', '84%', '88%', '91%'],
            ['交付周期（天）', '42', '36', '31'],
          ],
        },
      ],
      charts: [],
      shapes: [],
      sourceMap: [kpiCitation],
      imageGenerationBrief: '浅色表格区域背景参考，禁止文字、数字和图标。',
    },
    {
      id: 'slide-chart',
      title: '增长路径：规模提升与效率优化并行',
      body: ['2027 年继续扩大收入规模，并把交付效率转化为增长空间。'],
      findingIds: ['finding-priority'],
      dataPointIds: ['data-revenue'],
      tables: [],
      charts: [
        {
          id: 'chart-revenue-growth',
          type: 'bar',
          categories: ['2025 实际', '2026 目标', '2026 实际', '2027 计划'],
          series: [
            { name: '营业收入（百万元）', values: [108, 120, 128, 150] },
          ],
        },
      ],
      shapes: [
        {
          id: 'shape-chart-priority',
          type: 'rect',
          x: 0.8,
          y: 5.7,
          w: 5.6,
          h: 0.8,
          fill: 'E7F8F5',
          text: '重点：大客户拓展 × 交付效率',
        },
      ],
      sourceMap: [
        kpiCitation,
        {
          sourceId: 'source-market',
          title: '无文字市场背景图',
          locator: '整图',
        },
      ],
      imageGenerationBrief: '无文字的蓝色抽象市场背景，保留图表可读区域。',
    },
  ];
}

async function rejects(action: () => Promise<unknown>): Promise<boolean> {
  try {
    await action();
    return false;
  } catch {
    return true;
  }
}
