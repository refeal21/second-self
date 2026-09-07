/* @vitest-environment jsdom */

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  PptOutline,
  SourceAnalysis,
} from '../../worker/src/ppt-project.js';
import { OutlineEditor, outlineDraftError } from './outline-editor.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const analysis: SourceAnalysis = {
  findings: [
    { id: 'finding-growth', text: '年度收入同比增长 18%', sourceIds: ['source-report'] },
    { id: 'finding-risk', text: '续约率在第三季度回落', sourceIds: ['source-notes'] },
  ],
  dataPoints: [
    { id: 'data-revenue', label: '年度收入', value: 120, unit: '万元', sourceIds: ['source-report'] },
    { id: 'data-renewal', label: '续约率', value: '82%', sourceIds: ['source-notes'] },
  ],
  sourceMap: [
    { sourceId: 'source-report', title: '年度报告', locator: '第 3 页' },
    { sourceId: 'source-report', title: '年度报告', locator: '第 8 页，表 2' },
    { sourceId: 'source-notes', title: '访谈记录', locator: '第 12 段' },
  ],
};

const sources = [
  { id: 'source-report', fileName: '2026年度报告.pdf' },
  { id: 'source-notes', fileName: '客户访谈纪要.docx' },
  { id: 'source-raw', fileName: '尚未分析的附件.xlsx' },
] as const;

const initialOutline: PptOutline = {
  title: '年度经营复盘',
  slides: [
    {
      id: 'slide-overview',
      title: '增长概览',
      purpose: '帮助管理层了解全年增长结果',
      sourceIds: ['source-report'],
      findingIds: ['finding-growth'],
      dataPointIds: ['data-revenue'],
    },
    {
      id: 'slide-risk',
      title: '续约风险',
      purpose: '确定下季度的客户成功动作',
      sourceIds: ['source-notes'],
      findingIds: ['finding-risk'],
      dataPointIds: ['data-renewal'],
    },
  ],
};

function Harness({
  initial = initialOutline,
  sourceAnalysis = analysis,
  readOnly = false,
  disabled = false,
}: {
  initial?: PptOutline;
  sourceAnalysis?: SourceAnalysis | null;
  readOnly?: boolean;
  disabled?: boolean;
}) {
  const [outline, setOutline] = useState(initial);
  return (
    <OutlineEditor
      outline={outline}
      analysis={sourceAnalysis}
      sources={sources}
      readOnly={readOnly}
      disabled={disabled}
      onChange={setOutline}
    />
  );
}

function LockingHarness() {
  const [outline, setOutline] = useState(initialOutline);
  const [readOnly, setReadOnly] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setReadOnly(true)}>锁定编辑</button>
      <OutlineEditor
        outline={outline}
        analysis={analysis}
        sources={sources}
        readOnly={readOnly}
        disabled={false}
        onChange={setOutline}
      />
    </>
  );
}

describe('outlineDraftError', () => {
  it('accepts a complete outline and rejects blank, duplicate, and unsafe identities', () => {
    expect(outlineDraftError(initialOutline)).toBeNull();
    expect(outlineDraftError({ ...initialOutline, title: '  ' })).toContain('大纲标题');
    expect(outlineDraftError({ ...initialOutline, slides: [] })).toContain('至少需要 1 页');
    expect(outlineDraftError({ ...initialOutline, slides: [
      { ...initialOutline.slides[0]!, title: ' ' },
    ] })).toContain('第 1 页标题');
    expect(outlineDraftError({ ...initialOutline, slides: [
      { ...initialOutline.slides[0]!, purpose: '' },
    ] })).toContain('第 1 页页面目的');
    expect(outlineDraftError({ ...initialOutline, slides: [
      { ...initialOutline.slides[0]!, id: 'Unsafe ID' },
    ] })).toContain('ID 格式');
    expect(outlineDraftError({ ...initialOutline, slides: [
      initialOutline.slides[0]!,
      { ...initialOutline.slides[1]!, id: 'slide-overview' },
    ] })).toContain('ID 重复');
  });
});

describe('OutlineEditor', () => {
  it('uses auto-growing multiline title and purpose fields and recalculates on width changes', () => {
    let deckHeight = 42;
    const resizeCallbacks = new Map<Element, () => void>();
    vi.spyOn(HTMLTextAreaElement.prototype, 'scrollHeight', 'get')
      .mockImplementation(function scrollHeight(this: HTMLTextAreaElement) {
        return this.getAttribute('aria-label') === '大纲标题' ? deckHeight : 64;
      });
    class TestResizeObserver {
      readonly callback: ResizeObserverCallback;
      constructor(callback: ResizeObserverCallback) { this.callback = callback; }
      observe(target: Element) {
        resizeCallbacks.set(target, () => this.callback([], this as unknown as ResizeObserver));
      }
      disconnect() {}
      unobserve() {}
    }
    vi.stubGlobal('ResizeObserver', TestResizeObserver);

    render(<Harness readOnly />);

    const deckTitle = screen.getByRole('textbox', { name: '大纲标题' });
    const pageTitle = screen.getByRole('textbox', { name: '第 1 页标题' });
    const purpose = screen.getByRole('textbox', { name: '第 1 页页面目的' });
    for (const field of [deckTitle, pageTitle, purpose]) {
      expect(field.tagName).toBe('TEXTAREA');
      expect(field).toHaveAttribute('readonly');
    }
    expect(deckTitle).toHaveStyle({ height: '42px' });
    expect(pageTitle).toHaveStyle({ height: '64px' });
    expect(purpose).toHaveStyle({ height: '64px' });

    deckHeight = 104;
    resizeCallbacks.get(deckTitle)?.();
    expect(deckTitle).toHaveStyle({ height: '104px' });
  });

  it('shows a readable page document with every matching locator and keeps JSON collapsed', () => {
    render(<Harness />);

    expect(screen.getByRole('textbox', { name: '大纲标题' })).toHaveValue('年度经营复盘');
    const firstPage = screen.getByRole('article', { name: '第 1 页：增长概览' });
    expect(within(firstPage).getByRole('textbox', { name: '第 1 页标题' })).toHaveValue('增长概览');
    expect(within(firstPage).getByRole('textbox', { name: '第 1 页页面目的' }))
      .toHaveValue('帮助管理层了解全年增长结果');
    expect(within(firstPage).getByText('年度收入同比增长 18%')).toBeVisible();
    expect(within(firstPage).getByText('年度收入：120 万元')).toBeVisible();
    expect(within(firstPage).getAllByRole('listitem').filter(
      (item) => item.textContent?.includes('2026年度报告.pdf'),
    )).toHaveLength(2);
    expect(within(firstPage).getByText(/第 3 页/)).toBeVisible();
    expect(within(firstPage).getByText(/第 8 页，表 2/)).toBeVisible();

    const advanced = screen.getByText('高级信息（JSON，只读）').closest('details');
    expect(advanced).not.toHaveAttribute('open');
  });

  it('edits freeform fields and reorders pages without changing page identities or references', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const deckTitle = screen.getByRole('textbox', { name: '大纲标题' });
    await user.clear(deckTitle);
    await user.type(deckTitle, '董事会经营复盘');
    const firstTitle = screen.getByRole('textbox', { name: '第 1 页标题' });
    await user.clear(firstTitle);
    await user.type(firstTitle, '关键增长');
    await user.click(screen.getByRole('button', { name: '下移第 1 页' }));

    expect(screen.getByRole('textbox', { name: '大纲标题' })).toHaveValue('董事会经营复盘');
    expect(screen.getByRole('textbox', { name: '第 1 页标题' })).toHaveValue('续约风险');
    expect(screen.getByRole('textbox', { name: '第 2 页标题' })).toHaveValue('关键增长');
    await user.click(screen.getByText('高级信息（JSON，只读）'));
    const json = JSON.parse(screen.getByLabelText('大纲 JSON').textContent ?? '{}') as PptOutline;
    expect(json.slides.map(({ id }) => id)).toEqual(['slide-risk', 'slide-overview']);
    expect(json.slides[1]).toMatchObject({
      sourceIds: ['source-report'], findingIds: ['finding-growth'], dataPointIds: ['data-revenue'],
    });
  });

  it('keeps each page picker expanded when that stable page moves', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const firstPage = screen.getByRole('article', { name: '第 1 页：增长概览' });
    await user.click(within(firstPage).getByText('调整第 1 页材料'));
    expect(within(firstPage).getByText('调整第 1 页材料').closest('details')).toHaveAttribute('open');
    await user.click(screen.getByRole('button', { name: '下移第 1 页' }));

    const movedPage = screen.getByRole('article', { name: '第 2 页：增长概览' });
    expect(within(movedPage).getByText('调整第 2 页材料').closest('details')).toHaveAttribute('open');
  });

  it('adds a blank safe page and deletes only after inline confirmation while protecting the last page', async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ title: '单页大纲', slides: [initialOutline.slides[0]!] }} />);

    expect(screen.getByRole('button', { name: '删除第 1 页' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '新增页面' }));
    expect(screen.getByRole('textbox', { name: '第 2 页标题' })).toHaveValue('');

    await user.click(screen.getByText('高级信息（JSON，只读）'));
    let json = JSON.parse(screen.getByLabelText('大纲 JSON').textContent ?? '{}') as PptOutline;
    expect(json.slides[0]!.id).toBe('slide-overview');
    expect(json.slides[1]!.id).toMatch(/^slide-[a-f\d-]{36}$/);
    expect(json.slides[1]).toEqual({ id: json.slides[1]!.id, title: '', purpose: '' });

    await user.click(screen.getByRole('button', { name: '删除第 1 页' }));
    expect(screen.getByRole('alert')).toHaveTextContent('确认删除第 1 页');
    expect(screen.getByRole('textbox', { name: '第 1 页标题' })).toHaveValue('增长概览');
    await user.click(screen.getByRole('button', { name: '取消删除第 1 页' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '删除第 1 页' }));
    await user.click(screen.getByRole('button', { name: '确认删除第 1 页' }));
    expect(screen.getAllByRole('article')).toHaveLength(1);
    expect(screen.getByRole('button', { name: '删除第 1 页' })).toBeDisabled();
    json = JSON.parse(screen.getByLabelText('大纲 JSON').textContent ?? '{}') as PptOutline;
    expect(json.slides[0]!.id).toMatch(/^slide-[a-f\d-]{36}$/);
  });

  it('lets a page select findings, data, and sources while unioning evidence source IDs', async () => {
    const user = userEvent.setup();
    render(<Harness initial={{
      title: '证据选择',
      slides: [{ id: 'slide-new', title: '新页面', purpose: '选择证据' }],
    }} />);

    expect(screen.getByText('此页尚未绑定核心事实；不会根据来源自动推断事实。')).toBeVisible();
    await user.click(screen.getByText('调整第 1 页材料'));
    expect(screen.getByRole('checkbox', { name: '来源：尚未分析的附件.xlsx（尚未出现在材料分析中）' }))
      .toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: '来源：客户访谈纪要.docx' }));
    await user.click(screen.getByRole('checkbox', { name: '结论：年度收入同比增长 18%' }));
    await user.click(screen.getByRole('checkbox', { name: '数据：续约率：82%' }));

    expect(screen.getByText('年度收入同比增长 18%')).toBeVisible();
    expect(screen.getByText('续约率：82%')).toBeVisible();
    await user.click(screen.getByText('高级信息（JSON，只读）'));
    let json = JSON.parse(screen.getByLabelText('大纲 JSON').textContent ?? '{}') as PptOutline;
    expect(json.slides[0]).toMatchObject({
      findingIds: ['finding-growth'],
      dataPointIds: ['data-renewal'],
      sourceIds: ['source-notes', 'source-report'],
    });

    await user.click(screen.getByRole('checkbox', { name: '结论：年度收入同比增长 18%' }));
    json = JSON.parse(screen.getByLabelText('大纲 JSON').textContent ?? '{}') as PptOutline;
    expect(json.slides[0]!.findingIds).toEqual([]);
    expect(json.slides[0]!.sourceIds).toEqual(['source-notes', 'source-report']);
  });

  it('locks an evidence-required source until its finding is deselected', async () => {
    const user = userEvent.setup();
    render(<Harness initial={{
      title: '证据来源联动',
      slides: [{ id: 'slide-linked', title: '联动页', purpose: '验证来源状态' }],
    }} />);

    await user.click(screen.getByText('调整第 1 页材料'));
    await user.click(screen.getByRole('checkbox', { name: '结论：年度收入同比增长 18%' }));
    const requiredSource = screen.getByRole('checkbox', {
      name: '来源：2026年度报告.pdf（被本页事实或数据引用，请先取消对应引用）',
    });
    expect(requiredSource).toBeChecked();
    expect(requiredSource).toBeDisabled();

    fireEvent.change(requiredSource, { target: { checked: false } });
    await user.click(screen.getByText('高级信息（JSON，只读）'));
    let json = JSON.parse(screen.getByLabelText('大纲 JSON').textContent ?? '{}') as PptOutline;
    expect(json.slides[0]!.sourceIds).toEqual(['source-report']);

    await user.click(screen.getByRole('checkbox', { name: '结论：年度收入同比增长 18%' }));
    const removableSource = screen.getByRole('checkbox', { name: '来源：2026年度报告.pdf' });
    expect(removableSource).toBeEnabled();
    expect(removableSource).toBeChecked();
    await user.click(removableSource);
    json = JSON.parse(screen.getByLabelText('大纲 JSON').textContent ?? '{}') as PptOutline;
    expect(json.slides[0]!.findingIds).toEqual([]);
    expect(json.slides[0]!.sourceIds).toEqual([]);
  });

  it('shows a legacy derived-only source as required without adding a sourceIds array', async () => {
    const user = userEvent.setup();
    render(<Harness initial={{
      title: '旧大纲',
      slides: [{
        id: 'slide-legacy', title: '旧页面', purpose: '保留旧结构',
        findingIds: ['finding-growth'],
      }],
    }} />);

    await user.click(screen.getByText('调整第 1 页材料'));
    const requiredSource = screen.getByRole('checkbox', {
      name: '来源：2026年度报告.pdf（被本页事实或数据引用，请先取消对应引用）',
    });
    expect(requiredSource).toBeChecked();
    expect(requiredSource).toBeDisabled();
    await user.click(screen.getByText('高级信息（JSON，只读）'));
    const json = JSON.parse(screen.getByLabelText('大纲 JSON').textContent ?? '{}') as PptOutline;
    expect(json.slides[0]).not.toHaveProperty('sourceIds');
    expect(json.slides[0]!.findingIds).toEqual(['finding-growth']);
  });

  it('preserves unresolved references in JSON and explains missing evidence without exposing opaque IDs', async () => {
    const user = userEvent.setup();
    render(<Harness initial={{
      title: '历史大纲',
      slides: [{
        id: 'slide-history', title: '历史页', purpose: '保留旧引用',
        sourceIds: ['source-missing'], findingIds: ['finding-missing'], dataPointIds: ['data-missing'],
      }],
    }} />);

    expect(screen.getAllByText(/无法解析/).length).toBeGreaterThanOrEqual(3);
    expect(screen.queryByText('source-missing')).not.toBeInTheDocument();
    expect(screen.queryByText('finding-missing')).not.toBeInTheDocument();
    await user.click(screen.getByText('高级信息（JSON，只读）'));
    expect(screen.getByLabelText('大纲 JSON')).toHaveTextContent('source-missing');
    expect(screen.getByLabelText('大纲 JSON')).toHaveTextContent('finding-missing');
  });

  it('blocks every mutation in read-only and disabled modes', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<Harness readOnly />);

    expect(screen.getByRole('textbox', { name: '大纲标题' })).toHaveAttribute('readonly');
    expect(screen.getByRole('textbox', { name: '第 1 页标题' })).toHaveAttribute('readonly');
    expect(screen.getByRole('button', { name: '下移第 1 页' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '删除第 1 页' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '新增页面' })).toBeDisabled();
    unmount();

    render(<Harness disabled />);
    const title = screen.getByRole('textbox', { name: '大纲标题' });
    expect(title).toBeDisabled();
    await user.click(screen.getByText('调整第 1 页材料'));
    expect(within(screen.getByRole('article', { name: '第 1 页：增长概览' }))
      .getByRole('checkbox', { name: '结论：年度收入同比增长 18%' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '下移第 1 页' })).toBeDisabled();
  });

  it('disables a pending inline deletion confirmation when the editor becomes read-only', async () => {
    const user = userEvent.setup();
    render(<LockingHarness />);

    await user.click(screen.getByRole('button', { name: '删除第 1 页' }));
    expect(screen.getByRole('button', { name: '确认删除第 1 页' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: '锁定编辑' }));

    expect(screen.getByRole('button', { name: '确认删除第 1 页' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '取消删除第 1 页' })).toBeDisabled();
  });
});
