/* @vitest-environment jsdom */

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SourceAnalysis } from '../../worker/src/ppt-project.js';
import {
  COMPATIBILITY_RECOVERY_MARKER,
  detailDocumentError,
  parseCompatibilityBrief,
  type DetailDocument,
} from './detail-document.js';
import { DetailEditor, DetailPageIndex } from './detail-editor.js';

afterEach(() => {
  cleanup();
  window.history.replaceState({}, '', '#/');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const analysis: SourceAnalysis = {
  findings: [
    { id: 'finding-growth', text: '收入同比增长 18%', sourceIds: ['source-report'] },
    { id: 'finding-risk', text: '续约存在下行风险', sourceIds: ['source-notes'] },
  ],
  dataPoints: [
    { id: 'data-revenue', label: '收入', value: 128, unit: '万元', sourceIds: ['source-report'] },
  ],
  sourceMap: [
    { sourceId: 'source-report', title: '年度报告', locator: '第 3 页' },
    { sourceId: 'source-report', title: '年度报告', locator: '第 8 页，表 2' },
    { sourceId: 'source-notes', title: '访谈记录', locator: '第 12 段' },
  ],
};

const sources = [
  { id: 'source-report', fileName: '2026 年度报告.pdf' },
  { id: 'source-notes', fileName: '客户访谈纪要.docx' },
] as const;

const originalSuffix = `${COMPATIBILITY_RECOVERY_MARKER}${JSON.stringify({
  conceptualShapes: [{ id: 'flow-old', type: 'flowDiagram', nodes: ['输入', '<script>不执行</script>'] }],
  'table-0': { id: 'table-old', title: '历史指标', note: '来自恢复原稿' },
  'citation-0': { sourceId: 'source-report', basis: '原始来源说明' },
})}`;
const originalBrief = `蓝色商务数据页${originalSuffix}`;

const initialDocument: DetailDocument = {
  outline: {
    title: '年度经营复盘',
    slides: [
      { id: 'slide-overview', title: '增长概览', purpose: '说明全年经营结果' },
      { id: 'slide-plan', title: '行动计划', purpose: '明确下一步动作' },
    ],
  },
  specs: [
    {
      id: 'slide-overview', title: '增长概览', body: ['原始正文', '保留段落'],
      findingIds: ['finding-growth'], dataPointIds: ['data-revenue'],
      tables: [{ id: 'table-kpi', headers: ['指标', '2026'], rows: [['收入', '128']] }],
      charts: [{
        id: 'chart-growth', type: 'bar', categories: ['2025', '2026'],
        series: [{ name: '收入', values: [108, 128] }],
      }],
      shapes: [{
        id: 'shape-callout', type: 'rect', x: 1, y: 2, w: 3, h: 1,
        fill: '#ffffff', line: '#223344', text: '增长 18%',
      }],
      sourceMap: [{ sourceId: 'source-report', title: '年度报告', locator: '第 3 页' }],
      imageGenerationBrief: originalBrief,
    },
    {
      id: 'slide-plan', title: '行动计划', body: ['聚焦重点行业'],
      tables: [], charts: [], shapes: [], sourceMap: [], imageGenerationBrief: '路线图布局',
    },
  ],
};

function Harness({
  initial = initialDocument,
  readOnly = false,
  disabled = false,
  idPrefix,
  onValue,
}: {
  initial?: DetailDocument;
  readOnly?: boolean;
  disabled?: boolean;
  idPrefix?: string;
  onValue?: (value: DetailDocument) => void;
}) {
  const [value, setValue] = useState(initial);
  return <DetailEditor value={value} analysis={analysis} sources={sources}
    readOnly={readOnly} disabled={disabled} idPrefix={idPrefix}
    onChange={(next) => { onValue?.(next); setValue(next); }} />;
}

describe('DetailEditor document editing', () => {
  it('edits controlled title, purpose and body while preserving arrays, newlines, and opaque brief suffix', () => {
    let latest = initialDocument;
    render(<Harness onValue={(value) => { latest = value; }} />);

    fireEvent.change(screen.getByRole('textbox', { name: '第 1 页标题' }), {
      target: { value: '关键增长' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: '第 1 页页面目的' }), {
      target: { value: '让管理层快速理解增长来源' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: '第 1 页正文第 1 段' }), {
      target: { value: '调整后正文\n仍是同一段' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: '第 1 页图片提示词' }), {
      target: { value: '改成克制的蓝色数据页' },
    });

    expect(latest.outline.slides[0]).toMatchObject({
      id: 'slide-overview', title: '关键增长', purpose: '让管理层快速理解增长来源',
    });
    expect(latest.specs[0]!.title).toBe('关键增长');
    expect(latest.specs[0]!.body).toEqual(['调整后正文\n仍是同一段', '保留段落']);
    expect(latest.specs[0]!.imageGenerationBrief).toBe(`改成克制的蓝色数据页${originalSuffix}`);
    expect(parseCompatibilityBrief(latest.specs[0]!.imageGenerationBrief).suffix).toBe(originalSuffix);
    expect(screen.queryByRole('textbox', { name: '逐页细化 JSON' })).toBeNull();
  });

  it('shows and preserves a legacy spec title mismatch until an explicit title or structural edit', async () => {
    const user = userEvent.setup();
    const legacy: DetailDocument = {
      ...initialDocument,
      specs: initialDocument.specs.map((spec, index) => index === 0
        ? { ...spec, title: '人工细化后的增长标题' }
        : spec),
    };
    let latest = legacy;
    render(<Harness initial={legacy} onValue={(value) => { latest = value; }} />);

    expect(screen.getByRole('textbox', { name: '第 1 页标题' })).toHaveValue('人工细化后的增长标题');
    fireEvent.change(screen.getByRole('textbox', { name: '第 1 页正文第 1 段' }), {
      target: { value: '仅修改正文' },
    });
    expect(latest.outline.slides[0]!.title).toBe('增长概览');
    expect(latest.specs[0]!.title).toBe('人工细化后的增长标题');

    await user.click(screen.getByRole('button', { name: '下移第 1 页' }));
    expect(latest.outline.slides.map(({ title }) => title)).toEqual(['行动计划', '人工细化后的增长标题']);
    expect(latest.specs.map(({ title }) => title)).toEqual(['行动计划', '人工细化后的增长标题']);
  });

  it('presents Chinese document sections, a default-collapsed readonly JSON view, and safe recovery context', () => {
    render(<Harness />);

    const page = screen.getByRole('article', { name: '第 1 页：增长概览' });
    for (const label of ['最终正文', '表格', '图表', '基础形状', '来源与依据', '构图与图片提示词']) {
      expect(within(page).getByText(label)).toBeInTheDocument();
    }
    expect(within(page).getByText('恢复补充是历史设计背景，不是当前数据的权威来源。')).toBeVisible();
    expect(within(page).getByText('流程构图')).toBeVisible();
    expect(page.querySelector('.detail-editor__properties')).toHaveTextContent('<script>不执行</script>');
    expect(page.querySelector('script')).toBeNull();
    const advanced = within(page).getByText('第 1 页高级信息（JSON，只读）').closest('details');
    expect(advanced).not.toHaveAttribute('open');
    expect(within(page).getByLabelText('第 1 页细化 JSON').tagName).toBe('PRE');
  });

  it('adds a paragraph after its current position and deletes it only after confirmation', async () => {
    const user = userEvent.setup();
    let latest = initialDocument;
    render(<Harness onValue={(value) => { latest = value; }} />);

    await user.click(screen.getByRole('button', { name: '在第 1 页正文第 1 段后新增段落' }));
    expect(latest.specs[0]!.body).toEqual(['原始正文', '', '保留段落']);
    expect(screen.getByRole('textbox', { name: '第 1 页正文第 2 段' })).toHaveFocus();

    await user.click(screen.getByRole('button', { name: '删除第 1 页正文第 2 段' }));
    expect(screen.getByRole('alert')).toHaveTextContent('确认删除第 1 页正文第 2 段');
    expect(latest.specs[0]!.body).toHaveLength(3);
    await user.click(screen.getByRole('button', { name: '确认删除第 1 页正文第 2 段' }));
    expect(latest.specs[0]!.body).toEqual(['原始正文', '保留段落']);
    const nextParagraph = screen.getByRole('textbox', { name: '第 1 页正文第 2 段' });
    expect(document.activeElement).toBe(nextParagraph);
    expect(nextParagraph).toBeEnabled();
  });
});

describe('DetailEditor page management and index', () => {
  it('inserts after the current page with a safe stable ID, no generated content, and title focus', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('crypto', { randomUUID: vi.fn(() => '11111111-1111-4111-8111-111111111111') });
    let latest = initialDocument;
    render(<Harness onValue={(value) => { latest = value; }} />);

    await user.click(screen.getByRole('button', { name: '在第 1 页后新增页面' }));
    expect(latest.outline.slides.map(({ id }) => id)).toEqual([
      'slide-overview', 'slide-11111111-1111-4111-8111-111111111111', 'slide-plan',
    ]);
    expect(latest.specs.map(({ id }) => id)).toEqual(latest.outline.slides.map(({ id }) => id));
    expect(latest.specs[1]).toEqual({
      id: 'slide-11111111-1111-4111-8111-111111111111', title: '', body: [''],
      tables: [], charts: [], shapes: [], sourceMap: [], imageGenerationBrief: '',
    });
    expect(screen.getByRole('textbox', { name: '第 2 页标题' })).toHaveFocus();
    expect(detailDocumentError(latest)).toContain('第 2 页标题');
  });

  it('retries generated IDs that collide with IDs retained in restored supplements', async () => {
    const user = userEvent.setup();
    const collision = '33333333-3333-4333-8333-333333333333';
    const available = '44444444-4444-4444-8444-444444444444';
    const restoredId = `slide-${collision}`;
    const recovered: DetailDocument = {
      ...initialDocument,
      specs: initialDocument.specs.map((spec, index) => index === 0 ? {
        ...spec,
        imageGenerationBrief: `原提示词${COMPATIBILITY_RECOVERY_MARKER}${JSON.stringify({
          conceptualShapes: [{ id: restoredId, type: 'flowDiagram' }],
        })}`,
      } : spec),
    };
    vi.stubGlobal('crypto', {
      randomUUID: vi.fn()
        .mockReturnValueOnce(collision)
        .mockReturnValueOnce(available),
    });
    let latest = recovered;
    render(<Harness initial={recovered} onValue={(value) => { latest = value; }} />);

    await user.click(screen.getByRole('button', { name: '在第 1 页后新增页面' }));
    expect(latest.outline.slides[1]!.id).toBe(`slide-${available}`);
    expect(latest.outline.slides[1]!.id).not.toBe(restoredId);
  });

  it('moves complete ID-associated pages, keeps focus with the moved page, and confirms page deletion', async () => {
    const user = userEvent.setup();
    let latest = initialDocument;
    render(<Harness onValue={(value) => { latest = value; }} />);

    await user.click(screen.getByRole('button', { name: '下移第 1 页' }));
    expect(latest.outline.slides.map(({ id }) => id)).toEqual(['slide-plan', 'slide-overview']);
    expect(latest.specs.map(({ id }) => id)).toEqual(['slide-plan', 'slide-overview']);
    expect(latest.specs[1]!.tables[0]!.id).toBe('table-kpi');
    expect(screen.getByRole('button', { name: '上移第 2 页' })).toHaveFocus();

    await user.click(screen.getByRole('button', { name: '删除第 2 页' }));
    expect(screen.getByRole('alert')).toHaveTextContent('确认删除第 2 页“增长概览”');
    await user.click(screen.getByRole('button', { name: '确认删除第 2 页' }));
    expect(latest.specs.map(({ id }) => id)).toEqual(['slide-plan']);
    expect(screen.getByRole('article', { name: '第 1 页：行动计划' })).toHaveFocus();
    expect(screen.getByRole('button', { name: '删除第 1 页' })).toBeDisabled();
  });

  it('focuses an enabled move control after moving a page into the first position', async () => {
    const user = userEvent.setup();
    let latest = initialDocument;
    render(<Harness onValue={(value) => { latest = value; }} />);

    await user.click(screen.getByRole('button', { name: '上移第 2 页' }));

    expect(latest.specs.map(({ id }) => id)).toEqual(['slide-plan', 'slide-overview']);
    const enabledMove = screen.getByRole('button', { name: '下移第 1 页' });
    expect(document.activeElement).toBe(enabledMove);
    expect(enabledMove).toBeEnabled();
  });

  it('performs page management locally without network or model requests', async () => {
    const user = userEvent.setup();
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('crypto', { randomUUID: vi.fn(() => '55555555-5555-4555-8555-555555555555') });
    render(<Harness />);

    await user.click(screen.getByRole('button', { name: '在第 1 页后新增页面' }));
    await user.click(screen.getByRole('button', { name: '下移第 1 页' }));
    expect(fetch).not.toHaveBeenCalled();
  });

  it('creates collision-free stable page anchors for editor and history indexes', () => {
    render(<>
      <DetailPageIndex value={initialDocument} idPrefix="draft" />
      <DetailPageIndex value={initialDocument} idPrefix="history-v1" />
      <Harness idPrefix="draft" />
    </>);

    expect(screen.getAllByRole('navigation', { name: '逐页细化目录' })).toHaveLength(2);
    const indexes = screen.getAllByRole('navigation', { name: '逐页细化目录' });
    expect(within(indexes[0]!).getByRole('link', { name: '第 1 页：增长概览' })).toHaveAttribute(
      'href', '#draft-page-slide-overview',
    );
    expect(within(indexes[1]!).getByRole('link', { name: '第 1 页：增长概览' })).toHaveAttribute(
      'href', '#history-v1-page-slide-overview',
    );
    expect(screen.getByRole('article', { name: '第 1 页：增长概览' })).toHaveAttribute(
      'id', 'draft-page-slide-overview',
    );
  });

  it('scrolls and focuses an indexed page without replacing the App workspace hash route', async () => {
    const user = userEvent.setup();
    window.history.replaceState({}, '', '#/workspace/project-route');
    render(<>
      <DetailPageIndex value={initialDocument} idPrefix="draft" />
      <Harness idPrefix="draft" />
    </>);
    const target = screen.getByRole('article', { name: '第 2 页：行动计划' });
    const scrollIntoView = vi.fn();
    target.scrollIntoView = scrollIntoView;

    await user.click(screen.getByRole('link', { name: '第 2 页：行动计划' }));

    expect(window.location.hash).toBe('#/workspace/project-route');
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start' });
    expect(document.activeElement).toBe(target);
  });

  it('uses idPrefix for every DOM identity when draft and readonly history render together', () => {
    render(<>
      <Harness idPrefix="draft" />
      <Harness idPrefix="history-v1" readOnly />
    </>);

    const ids = [...document.querySelectorAll<HTMLElement>('[id]')].map(({ id }) => id);
    expect(ids).toHaveLength(new Set(ids).size);
    expect(ids).toContain('draft-body-slide-overview');
    expect(ids).toContain('history-v1-body-slide-overview');
  });
});

describe('DetailEditor nested structured content', () => {
  it('edits table strings and adds rows and columns while keeping the table rectangular', async () => {
    const user = userEvent.setup();
    let latest = initialDocument;
    render(<Harness onValue={(value) => { latest = value; }} />);

    fireEvent.change(screen.getByRole('textbox', { name: '第 1 页表格 1 第 1 行第 2 列' }), {
      target: { value: '00128' },
    });
    expect(latest.specs[0]!.tables[0]!.rows[0]![1]).toBe('00128');
    await user.click(screen.getByRole('button', { name: '第 1 页表格 1 新增行' }));
    await user.click(screen.getByRole('button', { name: '第 1 页表格 1 新增列' }));
    expect(latest.specs[0]!.tables[0]).toEqual({
      id: 'table-kpi', headers: ['指标', '2026', ''], rows: [['收入', '00128', ''], ['', '', '']],
    });

    await user.click(screen.getByRole('button', { name: '删除第 1 页表格 1 第 3 列' }));
    expect(screen.getByRole('alert')).toHaveTextContent('确认删除第 1 页表格 1 第 3 列');
    await user.click(screen.getByRole('button', { name: '确认删除第 1 页表格 1 第 3 列' }));
    expect(latest.specs[0]!.tables[0]!.headers).toEqual(['指标', '2026']);
    expect(latest.specs[0]!.tables[0]!.rows.every((row) => row.length === 2)).toBe(true);

    await user.click(screen.getByRole('button', { name: '删除第 1 页表格 1 第 2 行' }));
    expect(screen.getByRole('alert')).toHaveTextContent('确认删除第 1 页表格 1 第 2 行');
    await user.click(screen.getByRole('button', { name: '确认删除第 1 页表格 1 第 2 行' }));
    expect(latest.specs[0]!.tables[0]!.rows).toEqual([['收入', '00128']]);
  });

  it('adds and deletes whole tables only through explicit confirmation', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('crypto', { randomUUID: vi.fn(() => '22222222-2222-4222-8222-222222222222') });
    let latest = initialDocument;
    render(<Harness onValue={(value) => { latest = value; }} />);

    await user.click(screen.getByRole('button', { name: '第 1 页新增表格' }));
    expect(latest.specs[0]!.tables[1]).toEqual({
      id: 'table-22222222-2222-4222-8222-222222222222', headers: [''], rows: [['']],
    });
    await user.click(screen.getByRole('button', { name: '删除第 1 页表格 2' }));
    expect(latest.specs[0]!.tables).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: '确认删除第 1 页表格 2' }));
    expect(latest.specs[0]!.tables).toHaveLength(1);
  });

  it('edits chart categories and series and represents blank numeric input as invalid rather than zero', async () => {
    const user = userEvent.setup();
    let latest = initialDocument;
    render(<Harness onValue={(value) => { latest = value; }} />);

    fireEvent.change(screen.getByRole('spinbutton', { name: '第 1 页图表 1 系列 1 第 2 个数值' }), {
      target: { value: '' },
    });
    expect(Number.isNaN(latest.specs[0]!.charts[0]!.series[0]!.values[1])).toBe(true);
    expect(detailDocumentError(latest)).toContain('第 1 页图表 1 系列 1 第 2 个数值');

    await user.click(screen.getByRole('button', { name: '第 1 页图表 1 新增分类' }));
    expect(latest.specs[0]!.charts[0]!.categories).toEqual(['2025', '2026', '']);
    expect(latest.specs[0]!.charts[0]!.series[0]!.values).toHaveLength(3);
    await user.click(screen.getByRole('button', { name: '第 1 页图表 1 新增系列' }));
    expect(latest.specs[0]!.charts[0]!.series[1]).toEqual({ name: '', values: [Number.NaN, Number.NaN, Number.NaN] });

    await user.click(screen.getByRole('button', { name: '删除第 1 页图表 1 分类 3' }));
    expect(screen.getByRole('alert')).toHaveTextContent('确认删除第 1 页图表 1 分类 3');
    await user.click(screen.getByRole('button', { name: '确认删除第 1 页图表 1 分类 3' }));
    expect(latest.specs[0]!.charts[0]!.categories).toEqual(['2025', '2026']);
    expect(latest.specs[0]!.charts[0]!.series.every((series) => series.values.length === 2)).toBe(true);

    await user.click(screen.getByRole('button', { name: '删除第 1 页图表 1 系列 2' }));
    await user.click(screen.getByRole('button', { name: '确认删除第 1 页图表 1 系列 2' }));
    expect(latest.specs[0]!.charts[0]!.series).toHaveLength(1);
  });

  it('accepts decimal chart values without native number-input step mismatch', () => {
    let latest = initialDocument;
    render(<Harness onValue={(value) => { latest = value; }} />);
    const input = screen.getByRole('spinbutton', {
      name: '第 1 页图表 1 系列 1 第 1 个数值',
    }) as HTMLInputElement;
    expect(input).toHaveAttribute('step', 'any');

    fireEvent.change(input, { target: { value: '108.5' } });

    expect(latest.specs[0]!.charts[0]!.series[0]!.values[0]).toBe(108.5);
    expect(input.validity.stepMismatch).toBe(false);
  });

  it('edits basic shape fields without turning recovered conceptual diagrams into shapes', () => {
    let latest = initialDocument;
    render(<Harness onValue={(value) => { latest = value; }} />);

    fireEvent.change(screen.getByRole('spinbutton', { name: '第 1 页形状 1 横坐标' }), {
      target: { value: '2.5' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: '第 1 页形状 1文字' }), {
      target: { value: '更新后的标注' },
    });
    expect(latest.specs[0]!.shapes[0]).toMatchObject({ id: 'shape-callout', x: 2.5, text: '更新后的标注' });
    expect(latest.specs[0]!.shapes).toHaveLength(1);
  });

  it('selects an analyzed citation, edits its locator, then removes that exact current citation', async () => {
    const user = userEvent.setup();
    let latest = initialDocument;
    render(<Harness onValue={(value) => { latest = value; }} />);

    const firstPage = screen.getByRole('article', { name: '第 1 页：增长概览' });
    await user.click(within(firstPage).getByText('调整第 1 页来源与依据'));
    await user.click(within(firstPage).getByRole('checkbox', { name: '结论：续约存在下行风险' }));
    await user.click(within(firstPage).getByRole('checkbox', { name: '来源：客户访谈纪要.docx，第 12 段' }));
    expect(latest.specs[0]!.findingIds).toEqual(['finding-growth', 'finding-risk']);
    expect(latest.specs[0]!.sourceMap[1]).toEqual(analysis.sourceMap[2]);
    fireEvent.change(screen.getByRole('textbox', { name: '第 1 页来源 2 定位' }), {
      target: { value: '第 12-13 段' },
    });
    expect(latest.specs[0]!.sourceMap[1]!.locator).toBe('第 12-13 段');

    await user.click(within(firstPage).getByRole('button', { name: '移除第 1 页来源 2' }));
    expect(latest.specs[0]!.sourceMap).toEqual([
      { sourceId: 'source-report', title: '年度报告', locator: '第 3 页' },
    ]);
  });
});

describe('DetailEditor locking', () => {
  it.each([
    { readOnly: true, disabled: false, expected: 'readonly' },
    { readOnly: false, disabled: true, expected: 'disabled' },
  ])('blocks every mutation in $expected mode', async ({ readOnly, disabled }) => {
    const user = userEvent.setup();
    const onValue = vi.fn();
    render(<Harness readOnly={readOnly} disabled={disabled} onValue={onValue} />);

    const title = screen.getByRole('textbox', { name: '第 1 页标题' });
    if (readOnly) expect(title).toHaveAttribute('readonly');
    if (disabled) expect(title).toBeDisabled();
    expect(screen.getByRole('button', { name: '在第 1 页后新增页面' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '下移第 1 页' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '删除第 1 页' })).toBeDisabled();
    fireEvent.change(title, { target: { value: '不应写入' } });
    await user.click(screen.getByRole('button', { name: '第 1 页新增表格' }));
    expect(onValue).not.toHaveBeenCalled();
  });
});
