import { describe, expect, it } from 'vitest';
import { goldenOutline, goldenSlideSpecs, goldenSourceAnalysis } from './golden-project.js';
import { parseNativePipelineAction } from './native-pipeline.js';
import { DETAIL_SPEC_CONTRACT, normalizeGeneratedSlideSpecs } from './slide-spec-contract.js';

describe('generated slide detail compatibility boundary', () => {
  const normalize = (raw: unknown) => normalizeGeneratedSlideSpecs(raw, goldenOutline(), goldenSourceAnalysis());
  it('does not change canonical approved-content text or geometry', () => {
    const input = goldenSlideSpecs();
    expect(normalize(input)).toEqual(input);
    expect(normalize(input)).not.toBe(input);
  });
  it('recovers observed legacy forms without losing diagram, table or source annotations', () => {
    const raw = structuredClone(goldenSlideSpecs()) as unknown as Record<string, unknown>[];
    const original = {
      ...raw[0], body: '第一段。\n\n第二段。',
      tables: [{ id: 'table-legacy', title: '结构计数', columns: ['模块', '数量'], rows: [['服务', 6]], note: '不是上线数量' }],
      shapes: [{ id: 'diagram-1', type: 'flowDiagram', nodes: [{ id: 'node-1', label: '受理' }], layout: '横向', note: '规划关系' }],
      sourceMap: [{ sourceId: 'source-report', locator: '第 1 页', targets: ['/body'], basis: '材料结论', analysisRefs: ['f1'] }],
    };
    raw[0] = original;
    const specs = normalize(raw);
    expect(specs[0]!.body).toEqual(['第一段。\n\n第二段。']);
    expect(specs[0]!.tables).toEqual([{ id: 'table-legacy', headers: ['模块', '数量'], rows: [['服务', '6']] }]);
    expect(specs[0]!.shapes).toEqual([]);
    expect(specs[0]!.sourceMap[0]).toEqual({ sourceId: 'source-report', title: goldenSourceAnalysis().sourceMap.find(s => s.sourceId === 'source-report')!.title, locator: '第 1 页' });
    expect(specs[0]!.imageGenerationBrief).toContain(JSON.stringify(original.shapes));
    expect(specs[0]!.imageGenerationBrief).toContain('不是上线数量');
    expect(specs[0]!.imageGenerationBrief).toContain('材料结论');
    expect(raw[0]).toEqual(original);
    expect(() => parseNativePipelineAction({ kind: 'details.submit', at: 'now', specs })).not.toThrow();
  });
  it.each([
    ['unknown slide fields', { unexpected: 'value' }, /第 1 页.*unexpected/],
    ['unknown diagram types', { shapes: [{ id: 'a', type: 'unrecognized' }] }, /第 1 页.*shapes/],
    ['missing citations', { sourceMap: [{ sourceId: 'unknown', locator: 'page' }] }, /第 1 页.*sourceMap/],
    ['changed title', { title: '改变了已批准标题' }, /第 1 页.*标题/],
    ['changed id', { id: 'different' }, /第 1 页.*id/],
    ['ambiguous table headers', { tables: [{ id: 't', columns: ['a'], headers: ['b'], rows: [] }] }, /第 1 页.*tables/],
    ['object table cells', { tables: [{ id: 't', headers: ['a'], rows: [[{ x: 1 }]] }] }, /第 1 页.*rows/],
  ])('rejects %s before returning a usable draft', (_name, patch, error) => {
    const raw = [...structuredClone(goldenSlideSpecs())];
    raw[0] = { ...raw[0]!, ...patch } as typeof raw[0];
    expect(() => normalize(raw)).toThrow(error);
  });
  it('rejects missing and reordered pages instead of silently pairing by index', () => {
    expect(() => normalize(goldenSlideSpecs().slice(1))).toThrow(/页数/);
    expect(() => normalize([...goldenSlideSpecs()].reverse())).toThrow(/第 1 页.*id/);
  });
});

describe('complete-slide detail generation contract', () => {
  it('asks for a finished page brief that includes approved copy and data', () => {
    expect(DETAIL_SPEC_CONTRACT).toContain('完整成品页');
    expect(DETAIL_SPEC_CONTRACT).toContain('标题、正文、表格、图表');
    expect(DETAIL_SPEC_CONTRACT).toContain('纯背景');
    expect(DETAIL_SPEC_CONTRACT).toContain('无文字');
  });
});
