import { describe, expect, it } from 'vitest';
import type { PptOutline, SlideSpec } from '../../worker/src/ppt-project.js';
import {
  COMPATIBILITY_RECOVERY_MARKER,
  describeOutlineChanges,
  detailDocumentError,
  hasOutlineChanges,
  parseCompatibilityBrief,
  replaceCompatibilityMainText,
  type DetailDocument,
} from './detail-document.js';

const outline: PptOutline = {
  title: '经营复盘',
  slides: [
    { id: 'slide-overview', title: '经营概览', purpose: '说明核心结果' },
    { id: 'slide-plan', title: '下一步', purpose: '明确行动计划' },
  ],
};

const specs: readonly SlideSpec[] = [
  {
    id: 'slide-overview', title: '经营概览', body: ['收入增长'],
    tables: [{ id: 'table-kpi', headers: ['指标', '数值'], rows: [['收入', '128']] }],
    charts: [{
      id: 'chart-kpi', type: 'bar', categories: ['2025', '2026'],
      series: [{ name: '收入', values: [108, 128] }],
    }],
    shapes: [{ id: 'shape-note', type: 'rect', x: 1, y: 1, w: 2, h: 1, text: '增长' }],
    sourceMap: [{ sourceId: 'source-report', title: '年度报告', locator: '第 3 页' }],
    imageGenerationBrief: '蓝色商务数据页',
  },
  {
    id: 'slide-plan', title: '下一步', body: ['扩大重点行业覆盖'],
    tables: [], charts: [], shapes: [], sourceMap: [], imageGenerationBrief: '清晰路线图',
  },
];

function documentWith(nextSpecs = specs, nextOutline = outline): DetailDocument {
  return { outline: nextOutline, specs: nextSpecs };
}

describe('detailDocumentError', () => {
  it('accepts a complete aligned document and reports page-specific required fields', () => {
    expect(detailDocumentError(documentWith())).toBeNull();
    expect(detailDocumentError(documentWith(specs, { ...outline, title: ' ' }))).toBe('请填写大纲标题。');
    expect(detailDocumentError(documentWith([], { ...outline, slides: [] }))).toBe('细化至少需要 1 页。');
    expect(detailDocumentError(documentWith([{ ...specs[0]!, title: ' ' }], {
      ...outline, slides: [{ ...outline.slides[0]!, title: ' ' }],
    }))).toContain('第 1 页标题');
    expect(detailDocumentError(documentWith([{ ...specs[0]!, body: ['   '] }], {
      ...outline, slides: [outline.slides[0]!],
    }))).toContain('第 1 页正文');
    expect(detailDocumentError(documentWith([{ ...specs[0]!, imageGenerationBrief: '' }], {
      ...outline, slides: [outline.slides[0]!],
    }))).toContain('第 1 页图片提示词');
  });

  it('accepts and preserves a legacy v1 document whose approved outline title differs from its spec title', () => {
    const legacy = documentWith([
      { ...specs[0]!, title: '人工细化后的经营标题' }, specs[1]!,
    ]);
    expect(detailDocumentError(legacy)).toBeNull();
    expect(legacy.outline.slides[0]!.title).toBe('经营概览');
    expect(legacy.specs[0]!.title).toBe('人工细化后的经营标题');
  });

  it('rejects page mismatches, duplicate or unsafe IDs, ragged tables, and invalid chart values', () => {
    expect(detailDocumentError(documentWith(specs.slice(0, 1)))).toContain('页数');
    expect(detailDocumentError(documentWith([
      { ...specs[0]!, id: 'slide-plan' }, specs[1]!,
    ]))).toContain('第 1 页 ID');
    const overlongId = `slide-${'x'.repeat(70)}`;
    expect(detailDocumentError(documentWith([
      { ...specs[0]!, id: overlongId }, specs[1]!,
    ], {
      ...outline, slides: [{ ...outline.slides[0]!, id: overlongId }, outline.slides[1]!],
    }))).toContain('第 1 页 ID 格式');
    expect(detailDocumentError(documentWith([
      specs[0]!, { ...specs[1]!, id: 'slide-overview' },
    ], {
      ...outline,
      slides: [outline.slides[0]!, { ...outline.slides[1]!, id: 'slide-overview' }],
    }))).toContain('ID 重复');
    expect(detailDocumentError(documentWith([
      { ...specs[0]!, tables: [{ ...specs[0]!.tables[0]!, rows: [['收入']] }] }, specs[1]!,
    ]))).toContain('第 1 页表格 1 第 1 行');
    expect(detailDocumentError(documentWith([
      { ...specs[0]!, charts: [{ ...specs[0]!.charts[0]!, series: [{ name: '收入', values: [108] }] }] },
      specs[1]!,
    ]))).toContain('第 1 页图表 1 系列 1');
    expect(detailDocumentError(documentWith([
      { ...specs[0]!, charts: [{ ...specs[0]!.charts[0]!, series: [{ name: '收入', values: [108, Number.NaN] }] }] },
      specs[1]!,
    ]))).toContain('第 1 页图表 1 系列 1 第 2 个数值');
  });

  it('validates nested identities, citation fields, and basic shape geometry', () => {
    expect(detailDocumentError(documentWith([
      { ...specs[0]!, tables: [{ ...specs[0]!.tables[0]!, id: 'Unsafe ID' }] }, specs[1]!,
    ]))).toContain('第 1 页表格 1 ID');
    expect(detailDocumentError(documentWith([
      { ...specs[0]!, sourceMap: [{ ...specs[0]!.sourceMap[0]!, locator: ' ' }] }, specs[1]!,
    ]))).toContain('第 1 页来源 1 定位');
    expect(detailDocumentError(documentWith([
      { ...specs[0]!, shapes: [{ ...specs[0]!.shapes[0]!, x: -1 }] }, specs[1]!,
    ]))).toContain('第 1 页形状 1 横坐标');
  });

  it('scopes table, chart and shape identity uniqueness to each page', () => {
    const secondPageWithReusedNestedIds: SlideSpec = {
      ...specs[1]!,
      tables: structuredClone(specs[0]!.tables),
      charts: structuredClone(specs[0]!.charts),
      shapes: structuredClone(specs[0]!.shapes),
    };
    const compatible = documentWith([specs[0]!, secondPageWithReusedNestedIds]);

    expect(detailDocumentError(compatible)).toBeNull();
    expect(compatible.specs[1]!.tables[0]!.id).toBe('table-kpi');
    expect(compatible.specs[1]!.charts[0]!.id).toBe('chart-kpi');
    expect(compatible.specs[1]!.shapes[0]!.id).toBe('shape-note');

    expect(detailDocumentError(documentWith([{
      ...specs[0]!,
      tables: [specs[0]!.tables[0]!, { ...specs[0]!.tables[0]! }],
    }, specs[1]!]))).toContain('第 1 页表格 2 ID 重复');
    expect(detailDocumentError(documentWith([{
      ...specs[0]!,
      charts: [{ ...specs[0]!.charts[0]!, id: 'table-kpi' }],
    }, specs[1]!]))).toContain('第 1 页图表 1 ID 重复');
    expect(detailDocumentError(documentWith([{
      ...specs[0]!,
      shapes: [{ ...specs[0]!.shapes[0]!, id: 'chart-kpi' }],
    }, specs[1]!]))).toContain('第 1 页形状 1 ID 重复');
  });
});

describe('outline change detection', () => {
  it('treats page title, purpose, insertion, deletion and order as structural changes', () => {
    const renamed = { ...outline, slides: [
      { ...outline.slides[0]!, title: '关键经营结果', purpose: '突出结论' }, outline.slides[1]!,
    ] };
    expect(hasOutlineChanges(outline, structuredClone(outline))).toBe(false);
    expect(hasOutlineChanges(outline, renamed)).toBe(true);
    expect(describeOutlineChanges(outline, renamed)).toEqual([
      '第 1 页标题：“经营概览”改为“关键经营结果”',
      '第 1 页页面目的：“说明核心结果”改为“突出结论”',
    ]);

    const reordered = { ...outline, slides: [outline.slides[1]!, outline.slides[0]!] };
    expect(describeOutlineChanges(outline, reordered)).toEqual([
      '调整页序：“经营概览”由第 1 页移至第 2 页',
      '调整页序：“下一步”由第 2 页移至第 1 页',
    ]);

    const inserted = { ...outline, slides: [
      outline.slides[0]!, { id: 'slide-new', title: '新增分析', purpose: '补充风险' }, outline.slides[1]!,
    ] };
    expect(describeOutlineChanges(outline, inserted)).toEqual(['新增第 2 页“新增分析”']);
    expect(describeOutlineChanges(inserted, outline)).toEqual(['删除原第 2 页“新增分析”']);
  });
});

describe('compatibility recovery brief', () => {
  const suffixObject = {
    conceptualShapes: [{ id: 'concept-1', type: 'flowDiagram', nodes: ['输入', '输出'] }],
    'table-0': { id: 'table-old', title: '历史指标', note: '按旧索引保存' },
    'citation-0': { sourceId: 'source-report', basis: '访谈与报告交叉验证' },
  };
  const suffix = `${COMPATIBILITY_RECOVERY_MARKER}${JSON.stringify(suffixObject)}`;

  it('splits only the exact recovery marker and derives known data without changing raw bytes', () => {
    const original = `保持 {"ordinary":true} 的普通提示词${suffix}`;
    expect(parseCompatibilityBrief(original)).toEqual({
      mainText: '保持 {"ordinary":true} 的普通提示词',
      suffix,
      supplement: suffixObject,
      recognized: true,
    });
    expect(parseCompatibilityBrief(`普通提示词\n\n构图与来源补充：{"x":1}`)).toEqual({
      mainText: `普通提示词\n\n构图与来源补充：{"x":1}`,
      suffix: '', supplement: null, recognized: false,
    });
  });

  it('preserves recognized and unsupported suffixes byte-for-byte across repeated main-text edits', () => {
    const valid = `原提示词${suffix}`;
    const once = replaceCompatibilityMainText(valid, '新提示词\n保留换行');
    const twice = replaceCompatibilityMainText(once, '再次修改');
    expect(once).toBe(`新提示词\n保留换行${suffix}`);
    expect(twice).toBe(`再次修改${suffix}`);

    const malformedSuffix = `${COMPATIBILITY_RECOVERY_MARKER}{not valid json}\n  `;
    const malformed = `原提示词${malformedSuffix}`;
    expect(parseCompatibilityBrief(malformed)).toMatchObject({
      mainText: '原提示词', suffix: malformedSuffix, supplement: null, recognized: false,
    });
    expect(replaceCompatibilityMainText(malformed, '安全的新提示词')).toBe(`安全的新提示词${malformedSuffix}`);
  });
});
