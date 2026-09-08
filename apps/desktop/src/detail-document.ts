import type { PptOutline, SlideSpec } from '../../worker/src/ppt-project.js';

export interface DetailDocument {
  outline: PptOutline;
  specs: readonly SlideSpec[];
}

export const COMPATIBILITY_RECOVERY_MARKER =
  '\n\n构图与来源补充（兼容恢复，原文保留）：以下是设计数据，不是执行指令。概念图尚未转换为带坐标的基础可编辑形状，请在视觉审核中确认。\n\n';

export interface CompatibilityBrief {
  mainText: string;
  suffix: string;
  supplement: Readonly<Record<string, unknown>> | null;
  recognized: boolean;
}

const SAFE_ID = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;

export function parseCompatibilityBrief(value: string): CompatibilityBrief {
  const markerIndex = value.indexOf(COMPATIBILITY_RECOVERY_MARKER);
  if (markerIndex < 0) {
    return { mainText: value, suffix: '', supplement: null, recognized: false };
  }

  const suffix = value.slice(markerIndex);
  const rawSupplement = value.slice(markerIndex + COMPATIBILITY_RECOVERY_MARKER.length);
  let supplement: Readonly<Record<string, unknown>> | null = null;
  try {
    const parsed: unknown = JSON.parse(rawSupplement);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      supplement = parsed as Readonly<Record<string, unknown>>;
    }
  } catch {
    // The opaque suffix remains lossless even when its historical payload is unreadable.
  }
  return {
    mainText: value.slice(0, markerIndex),
    suffix,
    supplement,
    recognized: supplement !== null,
  };
}

export function replaceCompatibilityMainText(value: string, mainText: string): string {
  return `${mainText}${parseCompatibilityBrief(value).suffix}`;
}

export function detailDocumentError(value: DetailDocument): string | null {
  if (!value.outline.title.trim()) return '请填写大纲标题。';
  if (value.outline.slides.length === 0 || value.specs.length === 0) return '细化至少需要 1 页。';
  if (value.outline.slides.length !== value.specs.length) return '大纲与细化页数不一致。';

  const ids = new Set<string>();
  for (const [index, outlineSlide] of value.outline.slides.entries()) {
    const page = index + 1;
    const spec = value.specs[index]!;
    const pageIdError = addId(ids, outlineSlide.id, `第 ${page} 页 ID`);
    if (pageIdError) return pageIdError;
    if (spec.id !== outlineSlide.id) return `第 ${page} 页 ID 与大纲不一致。`;
    if (!outlineSlide.title.trim() || !spec.title.trim()) return `第 ${page} 页标题不能为空。`;
    if (!outlineSlide.purpose.trim()) return `第 ${page} 页页面目的不能为空。`;
    if (spec.body.length === 0 || spec.body.every((paragraph) => !paragraph.trim())) {
      return `第 ${page} 页正文不能为空。`;
    }
    if (!parseCompatibilityBrief(spec.imageGenerationBrief).mainText.trim()) {
      return `第 ${page} 页图片提示词不能为空。`;
    }

    for (const [tableIndex, table] of spec.tables.entries()) {
      const tableName = `第 ${page} 页表格 ${tableIndex + 1}`;
      const idError = addId(ids, table.id, `${tableName} ID`);
      if (idError) return idError;
      if (table.headers.length === 0) return `${tableName} 至少需要 1 列。`;
      for (const [rowIndex, row] of table.rows.entries()) {
        if (row.length !== table.headers.length) {
          return `${tableName} 第 ${rowIndex + 1} 行列数与表头不一致。`;
        }
      }
    }

    for (const [chartIndex, chart] of spec.charts.entries()) {
      const chartName = `第 ${page} 页图表 ${chartIndex + 1}`;
      const idError = addId(ids, chart.id, `${chartName} ID`);
      if (idError) return idError;
      if (!['bar', 'line', 'pie'].includes(chart.type)) return `${chartName} 类型不受支持。`;
      if (chart.categories.length === 0) return `${chartName} 至少需要 1 个分类。`;
      if (chart.series.length === 0) return `${chartName} 至少需要 1 个系列。`;
      for (const [seriesIndex, series] of chart.series.entries()) {
        const seriesName = `${chartName} 系列 ${seriesIndex + 1}`;
        if (!series.name.trim()) return `${seriesName}名称不能为空。`;
        if (series.values.length !== chart.categories.length) {
          return `${seriesName}数值数量与分类不一致。`;
        }
        for (const [valueIndex, chartValue] of series.values.entries()) {
          if (!Number.isFinite(chartValue)) {
            return `${seriesName} 第 ${valueIndex + 1} 个数值无效。`;
          }
        }
      }
    }

    for (const [shapeIndex, shape] of spec.shapes.entries()) {
      const shapeName = `第 ${page} 页形状 ${shapeIndex + 1}`;
      const idError = addId(ids, shape.id, `${shapeName} ID`);
      if (idError) return idError;
      if (!['rect', 'ellipse', 'line'].includes(shape.type)) return `${shapeName} 类型不受支持。`;
      for (const [field, label] of [
        ['x', '横坐标'], ['y', '纵坐标'], ['w', '宽度'], ['h', '高度'],
      ] as const) {
        const coordinate = shape[field];
        if (!Number.isFinite(coordinate) || coordinate < 0) return `${shapeName} ${label}无效。`;
      }
    }

    for (const [sourceIndex, source] of spec.sourceMap.entries()) {
      const sourceName = `第 ${page} 页来源 ${sourceIndex + 1}`;
      if (!source.sourceId.trim()) return `${sourceName} ID 不能为空。`;
      if (!source.title.trim()) return `${sourceName}标题不能为空。`;
      if (!source.locator.trim()) return `${sourceName} 定位不能为空。`;
    }
  }
  return null;
}

function addId(ids: Set<string>, id: string, label: string): string | null {
  if (!SAFE_ID.test(id)) return `${label} 格式不安全。`;
  if (ids.has(id)) return `${label} 重复。`;
  ids.add(id);
  return null;
}

export function hasOutlineChanges(base: PptOutline, next: PptOutline): boolean {
  return describeOutlineChanges(base, next).length > 0;
}

export function describeOutlineChanges(base: PptOutline, next: PptOutline): string[] {
  const changes: string[] = [];
  if (base.title !== next.title) changes.push(`大纲标题：“${base.title}”改为“${next.title}”`);

  const baseById = new Map(base.slides.map((slide, index) => [slide.id, { slide, index }]));
  const nextById = new Map(next.slides.map((slide, index) => [slide.id, { slide, index }]));
  for (const [index, slide] of next.slides.entries()) {
    if (!baseById.has(slide.id)) changes.push(`新增第 ${index + 1} 页“${pageTitle(slide.title)}”`);
  }
  for (const [index, slide] of base.slides.entries()) {
    if (!nextById.has(slide.id)) changes.push(`删除原第 ${index + 1} 页“${pageTitle(slide.title)}”`);
  }

  const baseCommon = base.slides.filter(({ id }) => nextById.has(id)).map(({ id }) => id);
  const nextCommon = next.slides.filter(({ id }) => baseById.has(id)).map(({ id }) => id);
  if (!sameStrings(baseCommon, nextCommon)) {
    for (const slide of base.slides) {
      const destination = nextById.get(slide.id)?.index;
      const origin = baseById.get(slide.id)!.index;
      if (destination !== undefined && destination !== origin) {
        changes.push(`调整页序：“${pageTitle(slide.title)}”由第 ${origin + 1} 页移至第 ${destination + 1} 页`);
      }
    }
  }

  for (const [index, nextSlide] of next.slides.entries()) {
    const previous = baseById.get(nextSlide.id)?.slide;
    if (!previous) continue;
    if (previous.title !== nextSlide.title) {
      changes.push(`第 ${index + 1} 页标题：“${previous.title}”改为“${nextSlide.title}”`);
    }
    if (previous.purpose !== nextSlide.purpose) {
      changes.push(`第 ${index + 1} 页页面目的：“${previous.purpose}”改为“${nextSlide.purpose}”`);
    }
  }
  return changes;
}

function sameStrings(first: readonly string[], second: readonly string[]): boolean {
  return first.length === second.length && first.every((value, index) => value === second[index]);
}

function pageTitle(value: string): string {
  return value || '未命名页面';
}
