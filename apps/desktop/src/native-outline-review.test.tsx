/* @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNativePipeline } from '../../worker/src/native-pipeline.js';
import type { PptOutline } from '../../worker/src/ppt-project.js';
import { createDemoDesktopAdapter, type DesktopAdapter } from './desktop-adapter.js';
import { NativeWorkspacePage } from './native-workspace.js';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function setup() {
  let saved = createNativePipeline({ id: 'project-outline-ui', name: '经营复盘',
    goal: '管理层决策', createdAt: '2026-09-07T00:00:00.000Z' });
  saved.project.workflowStatus = 'outline_review';
  saved.sources = [{ id: 'source-report', fileName: '季度经营报告.pdf', mediaType: 'application/pdf',
    relativePath: 'sources/report.pdf', sha256: 'a'.repeat(64), byteLength: 1 }];
  saved.analysis = { requestId: 'analysis-1', artifactRelativePath: 'sources/analysis.json',
    sha256: 'b'.repeat(64), output: {
      findings: [{ id: 'finding-growth', text: '业务增长放缓，需要改善现金流。', sourceIds: ['source-report'] }],
      dataPoints: [{ id: 'data-growth', label: '同比增长', value: 12, unit: '%', sourceIds: ['source-report'] }],
      sourceMap: [{ sourceId: 'source-report', title: '季度经营报告', locator: '第 3 页' }],
    } };
  saved.outline = { version: { id: 'outline-v1', projectId: saved.project.id, sequence: 1,
    status: 'draft', createdAt: saved.project.createdAt, frozenAt: null }, value: {
      title: '季度经营复盘', slides: [
        { id: 'slide-growth', title: '经营概览', purpose: '解释本季度的变化',
          sourceIds: ['source-report'], findingIds: ['finding-growth'], dataPointIds: ['data-growth'] },
        { id: 'slide-plan', title: '下一步计划', purpose: '确定优先级', sourceIds: ['source-report'] },
      ],
    } };
  const saveOutline = vi.fn(async (_id: string, outline: PptOutline) => {
    saved = structuredClone(saved);
    saved.revision += 1;
    saved.outline!.value = structuredClone(outline);
    return structuredClone(saved);
  });
  const approveOutline = vi.fn(async () => {
    saved = structuredClone(saved);
    saved.project.workflowStatus = 'detail_review';
    saved.outline!.version.status = 'frozen';
    saved.outline!.version.frozenAt = '2026-09-07T01:00:00.000Z';
    return structuredClone(saved);
  });
  const adapter = { ...createDemoDesktopAdapter(), mode: 'tauri' as const,
    loadProjectPipeline: vi.fn(async () => structuredClone(saved)), saveOutline, approveOutline,
    generateOutline: vi.fn(), analyzeProject: vi.fn(), saveProjectContext: vi.fn(),
  } as unknown as DesktopAdapter;
  const onBack = vi.fn();
  const mount = () => render(<NativeWorkspacePage adapter={adapter} projectId={saved.project.id}
    projectName={saved.project.name} projectGoal={saved.project.goal} onBack={onBack} />);
  return { adapter, saveOutline, approveOutline, onBack, mount, getSaved: () => saved };
}

describe('document outline review integration', () => {
  it('reuses the existing outline, saves the visible draft with stable references, then freezes exactly that content', async () => {
    const test = setup(); test.mount();
    const title = await screen.findByRole('textbox', { name: '第 1 页标题' });
    expect(title).toHaveValue('经营概览');
    expect(screen.queryByRole('textbox', { name: '整份大纲 JSON' })).not.toBeInTheDocument();
    expect(screen.getByText('业务增长放缓，需要改善现金流。')).toBeVisible();
    expect(screen.getByRole('button', { name: '保存修改' })).toBeDisabled();
    fireEvent.change(title, { target: { value: '现金流与增长' } });
    expect(screen.getByRole('button', { name: '批准整份大纲' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '批准整份大纲' })).toBeEnabled());
    expect(test.saveOutline.mock.calls[0]?.[1].slides[0]).toEqual({
      id: 'slide-growth', title: '现金流与增长', purpose: '解释本季度的变化',
      sourceIds: ['source-report'], findingIds: ['finding-growth'], dataPointIds: ['data-growth'],
    });
    // Native saves retain the same version ID; subsequent changes must still be tracked.
    fireEvent.change(screen.getByRole('textbox', { name: '第 1 页页面目的' }), { target: { value: '提出投入建议' } });
    expect(screen.getByRole('button', { name: '批准整份大纲' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '批准整份大纲' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '批准整份大纲' }));
    expect(await screen.findByRole('button', { name: '生成逐页细化' })).toBeEnabled();
    fireEvent.click(screen.getByText('已批准大纲（只读）'));
    expect(screen.getByRole('textbox', { name: '第 1 页标题' })).toHaveAttribute('readonly');
    expect(screen.getByRole('textbox', { name: '第 1 页页面目的' })).toHaveValue('提出投入建议');
    expect(test.getSaved().outline?.version.status).toBe('frozen');
    expect(test.adapter.generateOutline).not.toHaveBeenCalled();
    expect(test.adapter.analyzeProject).not.toHaveBeenCalled();
  });

  it('retains unsaved edits on persistence failure and never approves them', async () => {
    const test = setup();
    test.saveOutline.mockRejectedValueOnce(new Error('磁盘暂时不可用'));
    test.mount();
    fireEvent.change(await screen.findByRole('textbox', { name: '第 1 页标题' }), { target: { value: '暂存标题' } });
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('磁盘暂时不可用');
    expect(screen.getByRole('textbox', { name: '第 1 页标题' })).toHaveValue('暂存标题');
    expect(screen.getByRole('button', { name: '保存修改' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '批准整份大纲' })).toBeDisabled();
    expect(test.approveOutline).not.toHaveBeenCalled();
  });

  it('locks editing while saving and blocks empty titles before persistence', async () => {
    const test = setup();
    let finish!: () => void;
    test.saveOutline.mockImplementationOnce(async (_id, outline) => {
      await new Promise<void>((resolve) => { finish = resolve; });
      const next = structuredClone(test.getSaved()); next.outline!.value = outline; return next;
    });
    test.mount();
    const title = await screen.findByRole('textbox', { name: '第 1 页标题' });
    fireEvent.change(title, { target: { value: ' ' } });
    expect(screen.getByRole('button', { name: '保存修改' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '批准整份大纲' })).toBeDisabled();
    fireEvent.change(title, { target: { value: '新标题' } });
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
    expect(title).toBeDisabled();
    expect(screen.getByRole('button', { name: '新增页面' })).toBeDisabled();
    finish();
    await waitFor(() => expect(title).toBeEnabled());
  });

  it('does not silently invalidate an unsaved outline when editing generation context', async () => {
    const test = setup(); test.mount();
    fireEvent.change(await screen.findByRole('textbox', { name: '第 1 页标题' }), { target: { value: '尚未保存' } });
    fireEvent.click(screen.getByText('项目说明与提示词'));
    fireEvent.change(screen.getByRole('textbox', { name: '本次任务说明' }), { target: { value: '新背景' } });
    expect(screen.getByRole('button', { name: '保存说明' })).toBeDisabled();
    expect(screen.getByText('请先保存大纲修改，再更改生成说明。')).toBeVisible();
    // Saving a draft is not AI generation or approval; both drafts can be saved in sequence.
    expect(screen.getByRole('button', { name: '保存修改' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '保存说明' })).toBeEnabled());
    expect(screen.getByRole('button', { name: '批准整份大纲' })).toBeDisabled();
    expect(test.adapter.saveProjectContext).not.toHaveBeenCalled();
  });

  it('confirms leaving an unsaved draft in a standalone workspace', async () => {
    const test = setup(); test.mount();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    fireEvent.change(await screen.findByRole('textbox', { name: '第 1 页标题' }), { target: { value: '尚未保存' } });
    fireEvent.click(screen.getByRole('button', { name: '返回 PPT 项目' }));
    expect(confirm).toHaveBeenCalledOnce(); expect(test.onBack).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: '返回 PPT 项目' }));
    expect(test.onBack).toHaveBeenCalledOnce();
  });
});
