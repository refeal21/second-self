/* @vitest-environment jsdom */

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNativePipeline, type NativePptPipeline } from '../../worker/src/native-pipeline.js';
import { createDemoDesktopAdapter, type DesktopAdapter } from './desktop-adapter.js';
import { NativeWorkspacePage } from './native-workspace.js';

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
    expect(await screen.findByText(/5\. 逐页视觉/)).toBeInTheDocument();
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

    const editor = await screen.findByRole('textbox');
    const edited = structuredClone(initial.outline.value);
    edited.slides[0]!.title = '用户修改后的标题';
    fireEvent.change(editor, { target: { value: JSON.stringify(edited) } });
    await user.click(screen.getByRole('button', { name: '保存修改' }));
    expect(saveOutline).toHaveBeenCalledWith(initial.project.id, edited);
    expect(await screen.findByDisplayValue(/用户修改后的标题/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '批准整份大纲' }));
    expect(approveOutline).toHaveBeenCalledWith(initial.project.id);
    expect(await screen.findByText('4. 生成全部页面细化')).toBeInTheDocument();
  });

  it('edits, saves, and approves the whole slide-spec document', async () => {
    const user = userEvent.setup();
    const initial = createNativePipeline({
      id: 'project-details-ui', name: '经营复盘', goal: '管理层决策',
      createdAt: '2026-09-04T00:00:00.000Z',
    });
    initial.project.workflowStatus = 'detail_review';
    initial.slideSpecs = {
      version: { id: 'project-details-ui-slide-specs-v1', projectId: initial.project.id,
        sequence: 1, status: 'draft', createdAt: initial.project.createdAt, frozenAt: null },
      value: [{ id: 'slide-cover', title: '封面', body: ['旧文案'], tables: [], charts: [],
        shapes: [], sourceMap: [], imageGenerationBrief: '无文字封面' }],
    };
    const saved = structuredClone(initial);
    saved.revision = 2;
    saved.slideSpecs!.value[0]!.body = ['用户修改后的文案'];
    const approved = structuredClone(saved);
    approved.revision = 3;
    approved.slideSpecs!.version.status = 'frozen';
    approved.slideSpecs!.version.frozenAt = '2026-09-04T00:02:00.000Z';
    approved.project.workflowStatus = 'visual_review';
    approved.currentSlideId = 'slide-cover';
    const base = createDemoDesktopAdapter();
    const saveDetails = vi.fn(async () => saved);
    const approveDetails = vi.fn(async () => approved);
    const adapter = { ...base, mode: 'tauri' as const,
      loadProjectPipeline: vi.fn(async () => initial), saveDetails, approveDetails } satisfies DesktopAdapter;
    render(<NativeWorkspacePage adapter={adapter} projectId={initial.project.id}
      projectName={initial.project.name} projectGoal={initial.project.goal} onBack={() => {}} />);

    const editor = await screen.findByRole('textbox');
    const edited = structuredClone(initial.slideSpecs.value);
    edited[0]!.body = ['用户修改后的文案'];
    fireEvent.change(editor, { target: { value: JSON.stringify(edited) } });
    await user.click(screen.getByRole('button', { name: '保存修改' }));
    expect(saveDetails).toHaveBeenCalledWith(initial.project.id, edited);
    expect(await screen.findByDisplayValue(/用户修改后的文案/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '批准全部细化' }));
    expect(approveDetails).toHaveBeenCalledWith(initial.project.id);
    expect(await screen.findByText(/5\. 逐页视觉/)).toBeInTheDocument();
  });
});
