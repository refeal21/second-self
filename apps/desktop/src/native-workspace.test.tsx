/* @vitest-environment jsdom */

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNativePipeline, type NativePptPipeline } from '../../worker/src/native-pipeline.js';
import { createDemoDesktopAdapter, type DesktopAdapter } from './desktop-adapter.js';
import { buildPptPrompt } from './ppt-prompts.js';
import { NativeWorkspacePage } from './native-workspace.js';
import { detailTestHarness } from './native-detail-test-support.js';

afterEach(cleanup);

function qaPipeline(status: 'qa' | 'completed'): NativePptPipeline {
  const pipeline = createNativePipeline({
    id: 'project-native-ui', name: '经营复盘', goal: '管理层决策',
    createdAt: '2026-09-03T00:00:00.000Z',
  });
  pipeline.project.workflowStatus = status;
  pipeline.exportReceipt = {
    relativePath: 'exports/经营复盘.pptx', sha256: 'a'.repeat(64), byteLength: 100,
    specVersionId: 'spec-v1', visualVersionIds: {},
  };
  if (status === 'completed') {
    pipeline.qaReport = {
      status: 'passed', round: 1, projectId: pipeline.project.id,
      exportPath: pipeline.exportReceipt.relativePath,
      exportSha256: pipeline.exportReceipt.sha256,
      specVersionId: 'spec-v1', visualVersionIds: {},
      sofficePath: '/mock/soffice', rendererPath: '/mock/pdftoppm',
      pdfPath: 'qa/run-1/经营复盘.pdf', renderedPages: [],
      expectedPageCount: 0, actualPageCount: 0, blankPages: [], comparisons: [], issues: [],
      jsonReportPath: 'qa/qa-round-1.json', textReportPath: 'qa/qa-round-1.txt',
    };
  }
  return pipeline;
}

function visualPipeline(
  status: 'visual_review' | 'conversion' = 'visual_review',
): NativePptPipeline {
  const pipeline = createNativePipeline({
    id: 'project-visual-ui', name: '经营复盘', goal: '管理层决策',
    createdAt: '2026-09-04T00:00:00.000Z',
  });
  pipeline.project.workflowStatus = status;
  pipeline.slideSpecs = {
    version: {
      id: 'project-visual-ui-slide-specs-v1', projectId: pipeline.project.id,
      sequence: 1, status: 'frozen', createdAt: pipeline.project.createdAt,
      frozenAt: '2026-09-04T00:01:00.000Z',
    },
    value: [{
      id: 'slide-cover', title: '封面', body: ['管理层汇报'], tables: [], charts: [],
      shapes: [], sourceMap: [], imageGenerationBrief: '完整 16:9 封面，不要生成文字。',
    }],
  };
  pipeline.currentSlideId = 'slide-cover';
  pipeline.visuals['slide-cover'] = [{
    slideId: 'slide-cover',
    version: {
      id: 'project-visual-ui-visual-slide-cover-v1', projectId: pipeline.project.id,
      sequence: 1, status: status === 'conversion' ? 'frozen' : 'draft',
      createdAt: '2026-09-04T00:02:00.000Z',
      frozenAt: status === 'conversion' ? '2026-09-04T00:03:00.000Z' : null,
    },
    relativePath: 'visuals/slide-cover-v1.png', sha256: 'b'.repeat(64), byteLength: 1024,
    usage: 'full_slide_reference', textFree: false, altText: '用户替换的完整封面',
  }];
  return pipeline;
}

describe('native PPT QA workspace', () => {
  it('shows saved prompt context and previews the canonical prompt without unsaved edits', async () => {
    const user = userEvent.setup();
    const initial = createNativePipeline({
      id: 'project-context-ui', name: '经营复盘', goal: '帮助管理层决定下一季度投入',
      createdAt: '2026-09-07T00:00:00.000Z',
    });
    initial.sources.push({ id: 'source-kpis', fileName: '经营指标.xlsx',
      mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      relativePath: 'sources/经营指标.xlsx', sha256: 'a'.repeat(64), byteLength: 128 });
    initial.promptContext = {
      taskBrief: '面向管理层，突出增长放缓和现金流。',
      sourceInstructions: { 'source-kpis': '这是事实数据源，优先使用本季度数据。' },
      outlineRequirements: '控制在 8 页以内。',
    };
    const adapter = { ...createDemoDesktopAdapter(), mode: 'tauri' as const,
      loadProjectPipeline: vi.fn(async () => initial) } satisfies DesktopAdapter;
    render(<NativeWorkspacePage adapter={adapter} projectId={initial.project.id}
      projectName={initial.project.name} projectGoal={initial.project.goal} onBack={() => {}} />);

    expect(await screen.findByRole('textbox', { name: '本次任务说明' }))
      .toHaveValue('面向管理层，突出增长放缓和现金流。');
    expect(screen.getByRole('textbox', { name: '经营指标.xlsx 文件用途说明' }))
      .toHaveValue('这是事实数据源，优先使用本季度数据。');
    expect(screen.getByRole('textbox', { name: '本次大纲要求（可选）' }))
      .toHaveValue('控制在 8 页以内。');
    expect(screen.getByText('项目目标（自动携带）').parentElement)
      .toHaveTextContent('帮助管理层决定下一季度投入');

    await user.click(screen.getByText('查看材料分析提示词'));
    expect(screen.getByTestId('native-prompt-preview').textContent)
      .toBe(buildPptPrompt(initial, 'analysis'));
    await user.clear(screen.getByRole('textbox', { name: '本次任务说明' }));
    await user.type(screen.getByRole('textbox', { name: '本次任务说明' }), '尚未保存的新背景');
    expect(screen.getByTestId('native-prompt-preview')).not.toHaveTextContent('尚未保存的新背景');
    expect(screen.getByText('提示词预览只使用已保存的说明。')).toBeVisible();
  });

  it('requires explicitly saving changed context before analysis and does not generate on save', async () => {
    const user = userEvent.setup();
    const initial = createNativePipeline({
      id: 'project-context-save-ui', name: '经营复盘', goal: '管理层决策',
      createdAt: '2026-09-07T00:00:00.000Z',
    });
    initial.sources.push({ id: 'source-kpis', fileName: '经营指标.xlsx', mediaType: 'application/json',
      relativePath: 'sources/经营指标.xlsx', sha256: 'a'.repeat(64), byteLength: 128 });
    const saved = structuredClone(initial);
    saved.revision = 1;
    saved.promptContext = { taskBrief: '面向管理层', sourceInstructions: {}, outlineRequirements: '' };
    const saveProjectContext = vi.fn(async () => saved);
    const analyzeProject = vi.fn(async () => saved);
    const adapter = { ...createDemoDesktopAdapter(), mode: 'tauri' as const,
      loadProjectPipeline: vi.fn(async () => initial), saveProjectContext, analyzeProject } as DesktopAdapter;
    render(<NativeWorkspacePage adapter={adapter} projectId={initial.project.id}
      projectName={initial.project.name} projectGoal={initial.project.goal} onBack={() => {}} />);

    const save = await screen.findByRole('button', { name: '保存说明' });
    const analyze = screen.getByRole('button', { name: '用 Codex 分析材料' });
    expect(save).toBeDisabled();
    await user.type(screen.getByRole('textbox', { name: '本次任务说明' }), '面向管理层');
    expect(save).toBeEnabled();
    expect(analyze).toBeDisabled();
    expect(screen.getByText('请先保存说明，再继续生成或审批。')).toBeVisible();

    await user.click(save);
    expect(saveProjectContext).toHaveBeenCalledWith(initial.project.id, {
      taskBrief: '面向管理层', sourceInstructions: {}, outlineRequirements: '',
    });
    expect(analyzeProject).not.toHaveBeenCalled();
    expect(analyze).toBeEnabled();
  });

  it('confirms the affected results before context changes invalidate saved analysis', async () => {
    const user = userEvent.setup();
    const initial = createNativePipeline({
      id: 'project-context-reset-ui', name: '经营复盘', goal: '管理层决策',
      createdAt: '2026-09-07T00:00:00.000Z',
    });
    initial.project.workflowStatus = 'outline_review';
    initial.promptContext = { taskBrief: '原任务说明', sourceInstructions: {}, outlineRequirements: '' };
    initial.analysis = { requestId: 'analysis-1', artifactRelativePath: 'sources/analysis.json',
      sha256: 'a'.repeat(64), output: { findings: [], dataPoints: [], sourceMap: [] } };
    initial.outline = { version: { id: 'outline-1', projectId: initial.project.id, sequence: 1,
      status: 'draft', createdAt: initial.project.createdAt, frozenAt: null },
      value: { title: '待审大纲', slides: [] } };
    const reset = structuredClone(initial);
    reset.revision = 2;
    reset.project.workflowStatus = 'intake';
    reset.promptContext!.taskBrief = '新任务说明';
    reset.analysis = null;
    reset.outline = null;
    const saveProjectContext = vi.fn(async () => reset);
    const adapter = { ...createDemoDesktopAdapter(), mode: 'tauri' as const,
      loadProjectPipeline: vi.fn(async () => initial), saveProjectContext } as DesktopAdapter;
    render(<NativeWorkspacePage adapter={adapter} projectId={initial.project.id}
      projectName={initial.project.name} projectGoal={initial.project.goal} onBack={() => {}} />);

    await user.click(await screen.findByText('项目说明与提示词'));
    const taskBrief = await screen.findByRole('textbox', { name: '本次任务说明' });
    await user.clear(taskBrief);
    await user.type(taskBrief, '新任务说明');
    await user.click(screen.getByRole('button', { name: '保存说明' }));
    expect(screen.getByRole('alert')).toHaveTextContent('将清除已有材料分析；当前未批准大纲将被清除，需重新生成；工作流返回材料阶段');
    expect(saveProjectContext).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '取消保存' }));
    expect(saveProjectContext).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '保存说明' }));
    await user.click(screen.getByRole('button', { name: '确认保存并清除' }));
    expect(saveProjectContext).toHaveBeenCalledOnce();
    expect(await screen.findByRole('heading', { name: '1. 附加材料' })).toBeVisible();
  });

  it('keeps analysis when only outline requirements change and confirms clearing the draft outline', async () => {
    const user = userEvent.setup();
    const initial = createNativePipeline({
      id: 'project-outline-requirements-ui', name: '经营复盘', goal: '管理层决策',
      createdAt: '2026-09-07T00:00:00.000Z',
    });
    initial.project.workflowStatus = 'outline_review';
    initial.promptContext = { taskBrief: '保持事实口径', sourceInstructions: {}, outlineRequirements: '10 页' };
    initial.analysis = { requestId: 'analysis-1', artifactRelativePath: 'sources/analysis.json',
      sha256: 'a'.repeat(64), output: { findings: [], dataPoints: [], sourceMap: [] } };
    initial.outline = { version: { id: 'outline-1', projectId: initial.project.id, sequence: 1,
      status: 'draft', createdAt: initial.project.createdAt, frozenAt: null },
      value: { title: '待审大纲', slides: [] } };
    const reset = structuredClone(initial);
    reset.revision = 2;
    reset.project.workflowStatus = 'source_analysis';
    reset.promptContext!.outlineRequirements = '8 页';
    reset.outline = null;
    const saveProjectContext = vi.fn(async () => reset);
    const adapter = { ...createDemoDesktopAdapter(), mode: 'tauri' as const,
      loadProjectPipeline: vi.fn(async () => initial), saveProjectContext } satisfies DesktopAdapter;
    render(<NativeWorkspacePage adapter={adapter} projectId={initial.project.id}
      projectName={initial.project.name} projectGoal={initial.project.goal} onBack={() => {}} />);

    await user.click(await screen.findByText('项目说明与提示词'));
    const requirements = await screen.findByRole('textbox', { name: '本次大纲要求（可选）' });
    await user.clear(requirements);
    await user.type(requirements, '8 页');
    await user.click(screen.getByRole('button', { name: '保存说明' }));
    expect(screen.getByRole('alert')).toHaveTextContent('将保留材料分析；当前未批准大纲将被清除，需重新生成；工作流返回材料分析阶段');
    await user.click(screen.getByRole('button', { name: '确认保存并清除' }));
    expect(saveProjectContext).toHaveBeenCalledWith(initial.project.id, {
      taskBrief: '保持事实口径', sourceInstructions: {}, outlineRequirements: '8 页',
    });
    expect(await screen.findByText('2. 材料分析')).toBeVisible();
  });

  it('keeps failed-save edits and confirms before navigating back with unsaved context', async () => {
    const user = userEvent.setup();
    const initial = createNativePipeline({
      id: 'project-context-failure-ui', name: '经营复盘', goal: '管理层决策',
      createdAt: '2026-09-07T00:00:00.000Z',
    });
    const onBack = vi.fn();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    const saveProjectContext = vi.fn(async () => { throw new Error('磁盘暂时不可写'); });
    const adapter = { ...createDemoDesktopAdapter(), mode: 'tauri' as const,
      loadProjectPipeline: vi.fn(async () => initial), saveProjectContext } satisfies DesktopAdapter;
    render(<NativeWorkspacePage adapter={adapter} projectId={initial.project.id}
      projectName={initial.project.name} projectGoal={initial.project.goal} onBack={onBack} />);

    const taskBrief = await screen.findByRole('textbox', { name: '本次任务说明' });
    await user.type(taskBrief, '必须保留的输入');
    await user.click(screen.getByRole('button', { name: '保存说明' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('磁盘暂时不可写');
    expect(taskBrief).toHaveValue('必须保留的输入');

    await user.click(screen.getByRole('button', { name: '返回 PPT 项目' }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('将丢弃这些修改'));
    expect(onBack).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '返回 PPT 项目' }));
    expect(onBack).toHaveBeenCalledOnce();
    confirm.mockRestore();
  });

  it('shows saved context as read-only after the outline is approved', async () => {
    const user = userEvent.setup();
    const initial = createNativePipeline({
      id: 'project-readonly-context-ui', name: '经营复盘', goal: '管理层决策',
      createdAt: '2026-09-07T00:00:00.000Z',
    });
    initial.project.workflowStatus = 'detail_review';
    initial.promptContext = { taskBrief: '已保存背景', sourceInstructions: {}, outlineRequirements: '8 页' };
    initial.outline = { version: { id: 'outline-1', projectId: initial.project.id, sequence: 1,
      status: 'frozen', createdAt: initial.project.createdAt, frozenAt: initial.project.createdAt },
      value: { title: '已批准大纲', slides: [] } };
    const adapter = { ...createDemoDesktopAdapter(), mode: 'tauri' as const,
      loadProjectPipeline: vi.fn(async () => initial) } satisfies DesktopAdapter;
    render(<NativeWorkspacePage adapter={adapter} projectId={initial.project.id}
      projectName={initial.project.name} projectGoal={initial.project.goal} onBack={() => {}} />);

    await user.click(await screen.findByText('项目说明与提示词'));
    expect(await screen.findByRole('textbox', { name: '本次任务说明' })).toHaveAttribute('readonly');
    expect(screen.getByRole('textbox', { name: '本次大纲要求（可选）' })).toHaveAttribute('readonly');
    expect(screen.getByRole('button', { name: '保存说明' })).toBeDisabled();
    expect(screen.getByText('查看逐页细化提示词')).toBeVisible();
  });

  it('lets keyboard users focus long stage content and advance from saved analysis to outline review', async () => {
    const user = userEvent.setup();
    const initial = createNativePipeline({
      id: 'project-analysis-ui', name: '材料分析回归', goal: '先分析，再审核大纲',
      createdAt: '2026-09-07T00:00:00.000Z',
    });
    initial.project.workflowStatus = 'source_analysis';
    initial.analysis = {
      requestId: 'analysis-1', artifactRelativePath: 'sources/analysis.json', sha256: 'a'.repeat(64),
      output: { findings: Array.from({ length: 40 }, (_, index) => ({
        id: `finding-${index}`, text: `材料中的第 ${index + 1} 条结论`, sourceIds: ['source-1'],
      })), dataPoints: [], sourceMap: [{ sourceId: 'source-1', title: '材料', locator: '第 1 页' }] },
    };
    const generated = structuredClone(initial);
    generated.project.workflowStatus = 'outline_review';
    generated.outline = {
      version: { id: 'outline-v1', projectId: initial.project.id, sequence: 1,
        status: 'draft', createdAt: initial.project.createdAt, frozenAt: null },
      value: { title: '待审核大纲', slides: [{ id: 'slide-1', title: '概览',
        purpose: '总结材料', sourceIds: ['source-1'] }] },
    };
    const generateOutline = vi.fn(async () => generated);
    const adapter = { ...createDemoDesktopAdapter(), mode: 'tauri' as const,
      loadProjectPipeline: vi.fn(async () => initial), generateOutline } satisfies DesktopAdapter;
    render(<NativeWorkspacePage adapter={adapter} projectId={initial.project.id}
      projectName={initial.project.name} projectGoal={initial.project.goal} onBack={() => {}} />);

    const content = await screen.findByRole('region', { name: 'PPT 阶段内容' });
    content.focus();
    expect(content).toHaveFocus();
    expect(content).toHaveTextContent('材料中的第 40 条结论');
    await user.click(screen.getByRole('button', { name: '生成整份大纲' }));
    expect(generateOutline).toHaveBeenCalledWith(initial.project.id);
    expect(await screen.findByRole('heading', { name: '3. 审核整份大纲' })).toBeVisible();
    expect(screen.getByRole('button', { name: '批准整份大纲' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: '生成逐页细化' })).not.toBeInTheDocument();
  });

  it('renders the current PNG at 16:9, gates approval on image load, and sends revision feedback', async () => {
    const user = userEvent.setup();
    const initial = visualPipeline();
    const base = createDemoDesktopAdapter();
    const approveVisual = vi.fn(async () => initial);
    const requestVisual = vi.fn(async () => initial);
    const adapter = {
      ...base,
      mode: 'tauri' as const,
      loadProjectPipeline: vi.fn(async () => initial),
      readProjectVisual: vi.fn(async () => 'data:image/png;base64,valid-preview'),
      approveVisual,
      requestVisual,
    } satisfies DesktopAdapter;
    render(<NativeWorkspacePage adapter={adapter} projectId={initial.project.id}
      projectName={initial.project.name} projectGoal={initial.project.goal} onBack={() => {}} />);

    const preview = await screen.findByRole('img', { name: '用户替换的完整封面' });
    const approve = screen.getByRole('button', { name: '批准当前页' });
    expect(approve).toBeDisabled();
    Object.defineProperties(preview, {
      naturalWidth: { value: 1280, configurable: true },
      naturalHeight: { value: 720, configurable: true },
    });
    fireEvent.load(preview);
    expect(approve).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: '标题、正文和数据完整，且与已批准细化一致' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '排版无裁切，配色符合本项目要求' }));
    expect(approve).toBeEnabled();

    await user.type(screen.getByRole('textbox', { name: '修改意见' }), '减少装饰，突出数据');
    await user.click(screen.getByRole('button', { name: '按意见重新生成' }));
    expect(requestVisual).toHaveBeenCalledWith(
      initial.project.id,
      'slide-cover',
      '减少装饰，突出数据',
    );
  });

  it('keeps approval disabled when the visual cannot load or is not a reasonable 16:9 image', async () => {
    const initial = visualPipeline();
    const base = createDemoDesktopAdapter();
    const adapter = {
      ...base,
      mode: 'tauri' as const,
      loadProjectPipeline: vi.fn(async () => initial),
      readProjectVisual: vi.fn(async () => 'data:image/png;base64,broken'),
    } satisfies DesktopAdapter;
    render(<NativeWorkspacePage adapter={adapter} projectId={initial.project.id}
      projectName={initial.project.name} projectGoal={initial.project.goal} onBack={() => {}} />);

    const preview = await screen.findByRole('img', { name: '用户替换的完整封面' });
    fireEvent.error(preview);
    expect(screen.getByRole('button', { name: '批准当前页' })).toBeDisabled();
    expect(await screen.findByRole('alert')).toHaveTextContent('无法加载当前 PNG');
  });

  it('requires saving palette edits before uploading a replacement image', async () => {
    const user = userEvent.setup();
    const initial = visualPipeline();
    const adapter = {
      ...createDemoDesktopAdapter(), mode: 'tauri' as const,
      loadProjectPipeline: vi.fn(async () => initial),
      readProjectVisual: vi.fn(async () => 'data:image/png;base64,preview'),
    } satisfies DesktopAdapter;
    render(<NativeWorkspacePage adapter={adapter} projectId={initial.project.id}
      projectName={initial.project.name} projectGoal={initial.project.goal} onBack={() => {}} />);
    await user.click(await screen.findByText('项目配色与模板参考'));
    const primary = screen.getByRole('textbox', { name: '主色' });
    await user.clear(primary);
    await user.type(primary, '#123456');
    expect(screen.getByLabelText('上传替换 PNG')).toBeDisabled();
  });

  it('exposes reopen for an approved page after sequential visual approval', async () => {
    const user = userEvent.setup();
    const initial = visualPipeline('conversion');
    const reopened = visualPipeline('visual_review');
    const base = createDemoDesktopAdapter();
    const reopenVisual = vi.fn(async () => reopened);
    const adapter = {
      ...base,
      mode: 'tauri' as const,
      loadProjectPipeline: vi.fn(async () => initial),
      readProjectVisual: vi.fn(async () => 'data:image/png;base64,valid-preview'),
      reopenVisual,
    } satisfies DesktopAdapter;
    render(<NativeWorkspacePage adapter={adapter} projectId={initial.project.id}
      projectName={initial.project.name} projectGoal={initial.project.goal} onBack={() => {}} />);

    await user.click(await screen.findByRole('button', { name: '重新打开第 1 页' }));
    expect(reopenVisual).toHaveBeenCalledWith(initial.project.id, 'slide-cover');
    expect(await screen.findByText(/5\. 整页 PPT 审核/)).toBeInTheDocument();
  });

  it('treats a reopened zero-byte placeholder as waiting for a new visual candidate', async () => {
    const initial = visualPipeline();
    initial.visuals['slide-cover']![0] = {
      ...initial.visuals['slide-cover']![0]!,
      relativePath: '', sha256: '', byteLength: 0,
    };
    const adapter = { ...createDemoDesktopAdapter(), mode: 'tauri' as const,
      loadProjectPipeline: vi.fn(async () => initial) } satisfies DesktopAdapter;
    render(<NativeWorkspacePage adapter={adapter} projectId={initial.project.id}
      projectName={initial.project.name} projectGoal={initial.project.goal} onBack={() => {}} />);

    expect(await screen.findByText(/当前阶段正在等待生成视觉候选/)).toBeVisible();
    expect(screen.getByRole('button', { name: '生成当前页' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: '按意见重新生成' })).not.toBeInTheDocument();
  });

  it('runs the production QA action and renders the real readable report path', async () => {
    const user = userEvent.setup();
    const initial = qaPipeline('qa');
    const completed = qaPipeline('completed');
    const base = createDemoDesktopAdapter();
    const runProjectQa = vi.fn(async () => completed);
    const adapter = {
      ...base,
      mode: 'tauri' as const,
      loadProjectPipeline: vi.fn(async () => initial),
      runProjectQa,
    } satisfies DesktopAdapter;
    render(<NativeWorkspacePage adapter={adapter} projectId={initial.project.id}
      projectName={initial.project.name} projectGoal={initial.project.goal} onBack={() => {}} />);

    await user.click(await screen.findByRole('button', { name: '运行 LibreOffice 自动 QA' }));

    expect(runProjectQa).toHaveBeenCalledWith(initial.project.id);
    expect(await screen.findByText('交付完成')).toBeInTheDocument();
    expect(screen.getByText(/qa\/qa-round-1\.txt/)).toBeInTheDocument();
  });

  it('edits, saves, and approves the whole outline through the production adapter contract', async () => {
    const user = userEvent.setup();
    const initial = createNativePipeline({
      id: 'project-outline-ui', name: '经营复盘', goal: '管理层决策',
      createdAt: '2026-09-04T00:00:00.000Z',
    });
    initial.project.workflowStatus = 'outline_review';
    initial.outline = {
      version: { id: 'project-outline-ui-outline-v1', projectId: initial.project.id,
        sequence: 1, status: 'draft', createdAt: initial.project.createdAt, frozenAt: null },
      value: { title: '经营复盘', slides: [{ id: 'slide-cover', title: '旧标题',
        purpose: '建立主题', sourceIds: ['source-kpis'] }] },
    };
    const saved = structuredClone(initial);
    saved.revision = 2;
    saved.outline!.value.slides[0]!.title = '用户修改后的标题';
    const approved = structuredClone(saved);
    approved.revision = 3;
    approved.outline!.version.status = 'frozen';
    approved.outline!.version.frozenAt = '2026-09-04T00:02:00.000Z';
    approved.project.workflowStatus = 'detail_review';
    const base = createDemoDesktopAdapter();
    const saveOutline = vi.fn(async () => saved);
    const approveOutline = vi.fn(async () => approved);
    const adapter = { ...base, mode: 'tauri' as const,
      loadProjectPipeline: vi.fn(async () => initial), saveOutline, approveOutline } satisfies DesktopAdapter;
    render(<NativeWorkspacePage adapter={adapter} projectId={initial.project.id}
      projectName={initial.project.name} projectGoal={initial.project.goal} onBack={() => {}} />);

    const editor = await screen.findByRole('textbox', { name: '第 1 页标题' });
    const edited = structuredClone(initial.outline.value);
    edited.slides[0]!.title = '用户修改后的标题';
    fireEvent.change(editor, { target: { value: edited.slides[0]!.title } });
    await user.click(screen.getByRole('button', { name: '保存修改' }));
    expect(saveOutline).toHaveBeenCalledWith(initial.project.id, edited);
    expect(await screen.findByDisplayValue(/用户修改后的标题/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '批准整份大纲' }));
    expect(approveOutline).toHaveBeenCalledWith(initial.project.id);
    expect(await screen.findByText('4. 生成全部页面细化')).toBeInTheDocument();
  });

  it('edits, saves, and approves the whole slide-spec document', async () => {
    const user = userEvent.setup();
    const h = await detailTestHarness(); const initial = h.getStored();
    render(<NativeWorkspacePage adapter={h.adapter} projectId={initial.project.id}
      projectName={initial.project.name} projectGoal={initial.project.goal} onBack={() => {}} />);
    const editor = await screen.findByRole('textbox', { name: '第 1 页正文第 1 段' });
    fireEvent.change(editor, { target: { value: '用户修改后的文案' } });
    await user.click(screen.getByRole('button', { name: '保存修改' }));
    expect(h.getStored().slideSpecs!.value[0]!.body[0]).toBe('用户修改后的文案');
    expect(h.commits).toEqual([5]);
    await user.click(screen.getByRole('button', { name: '批准全部细化' }));
    expect(h.getStored().slideSpecs!.version.status).toBe('frozen');
    expect(h.commits).toEqual([5, 6]);
    expect(await screen.findByText(/5\. 整页 PPT 审核/)).toBeInTheDocument();
    expect(screen.getByLabelText('第 1 页正文第 1 段')).not.toBeVisible();
    fireEvent.click(screen.getByText('已批准细化（只读）', { selector: 'summary' }));
    expect(screen.getByRole('textbox', { name: '第 1 页正文第 1 段' })).toHaveAttribute('readonly');
  });
});
