import { assertStrictIdentifier } from '../identifiers.js';
import type { PptOutline, SlideSpec, SourceAnalysis, SourceCitation } from '../ppt-project.js';
import type { DetailsEnvelope, OutlineEnvelope, PagePlan, PageType, PresalesModule, SlideDesignPlan } from './contracts.js';

const MAX_BYTES = 2 * 1024 * 1024;

// Inspect data descriptors before reading values: model JSON cannot contain getters,
// custom prototypes, symbols, sparse arrays, cycles, or executable serialization hooks.
function checkPayload(raw: unknown): void {
  let bytes = 0;
  const ancestors = new Set<object>();
  const encoder = new TextEncoder();
  function add(text: string): void {
    bytes += encoder.encode(text).length;
    if (bytes > MAX_BYTES) throw new Error('Envelope exceeds 2 MiB');
  }
  function visit(value: unknown, depth: number): void {
    if (typeof value === 'string') {
      if (value.length > MAX_BYTES) throw new Error('Envelope exceeds 2 MiB');
      add(JSON.stringify(value));
      return;
    }
    if (value === null || typeof value === 'boolean' || typeof value === 'number') {
      add(JSON.stringify(value));
      return;
    }
    if (typeof value !== 'object' || depth > 32) throw new Error('Envelope must contain bounded JSON data');
    if (ancestors.has(value)) throw new Error('Envelope cannot contain cycles');
    const isArray = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== (isArray ? Array.prototype : Object.prototype) && !(prototype === null && !isArray)) {
      throw new Error('Envelope must contain plain JSON objects');
    }
    if (isArray && value.length > MAX_BYTES) throw new Error('Envelope exceeds 2 MiB');
    const keys = Reflect.ownKeys(value);
    if (isArray && keys.length !== value.length + 1) throw new Error('Envelope arrays must be dense JSON arrays');
    ancestors.add(value);
    add(isArray ? '[' : '{');
    let count = 0;
    for (const key of keys) {
      if (isArray && key === 'length') continue;
      if (typeof key !== 'string') throw new Error('Envelope cannot contain symbol fields');
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!('value' in descriptor) || !descriptor.enumerable) throw new Error('Envelope requires enumerable data fields');
      if (isArray && key !== String(count)) throw new Error('Envelope arrays must use canonical indices');
      if (count++ > 0) add(',');
      if (!isArray) { add(JSON.stringify(key)); add(':'); }
      visit(descriptor.value, depth + 1);
    }
    add(isArray ? ']' : '}');
    ancestors.delete(value);
  }
  visit(raw, 0);
}

function record(value: unknown, required: readonly string[], optional: readonly string[], field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} must be an object`);
  const result = value as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  if (Object.keys(result).some((key) => !allowed.has(key))) throw new Error(`${field} has unknown fields`);
  if (required.some((key) => !Object.hasOwn(result, key))) throw new Error(`${field} has missing fields`);
  return result;
}

function string(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  if (value.length > 20_000) throw new Error(`${field} exceeds 20,000 characters`);
  return value;
}

function id(value: unknown): string { return assertStrictIdentifier('slide', value); }

function array(value: unknown, field: string, maximum = MAX_BYTES): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  if (value.length > maximum) throw new Error(`At most ${maximum} ${field} are allowed`);
  return value as unknown[];
}

function strings(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be a string array`);
  return value.map((item: unknown) => string(item, field));
}

function unique(values: readonly string[], field: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${field} must be unique`);
}

function ids(value: unknown, field: string): string[] {
  const result = array(value, field).map(id);
  unique(result, field);
  return result;
}

function version(value: unknown): 1 {
  if (value !== 1) throw new Error('schemaVersion must be 1');
  return 1;
}

function choice<T extends string>(value: unknown, choices: readonly T[], field: string): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) throw new Error(`${field} is invalid`);
  return value as T;
}

function references(values: readonly string[], known: ReadonlySet<string>, field: string): void {
  for (const value of values) if (!known.has(value)) throw new Error(`Unknown ${field}: ${value}`);
}

function evidence(analysis: SourceAnalysis) {
  return {
    findings: new Set(analysis.findings.map((item) => item.id)),
    points: new Set(analysis.dataPoints.map((item) => item.id)),
    sources: new Set(analysis.sourceMap.map((item) => item.sourceId)),
  };
}

function optionalIds(object: Record<string, unknown>, field: string): string[] | undefined {
  return Object.hasOwn(object, field) ? ids(object[field], field) : undefined;
}

export function parseOutlineEnvelope(raw: unknown, analysis: SourceAnalysis): OutlineEnvelope {
  checkPayload(raw);
  const envelope = record(raw, ['schemaVersion', 'outline', 'plan'], [], 'outline envelope');
  version(envelope.schemaVersion);
  const outline = record(envelope.outline, ['title', 'slides'], [], 'outline');
  const known = evidence(analysis);
  const slides: PptOutline['slides'] = array(outline.slides, 'pages', 100).map((value) => {
    const slide = record(value, ['id', 'title', 'purpose'], ['sourceIds', 'findingIds', 'dataPointIds'], 'outline slide');
    const sourceIds = optionalIds(slide, 'sourceIds');
    const findingIds = optionalIds(slide, 'findingIds');
    const dataPointIds = optionalIds(slide, 'dataPointIds');
    references(sourceIds ?? [], known.sources, 'source');
    references(findingIds ?? [], known.findings, 'finding');
    references(dataPointIds ?? [], known.points, 'data point');
    return {
      id: id(slide.id), title: string(slide.title, 'slide title'), purpose: string(slide.purpose, 'slide purpose'),
      ...(sourceIds === undefined ? {} : { sourceIds }),
      ...(findingIds === undefined ? {} : { findingIds }),
      ...(dataPointIds === undefined ? {} : { dataPointIds }),
    };
  });
  if (!slides.length) throw new Error('Outline requires pages');
  unique(slides.map((slide) => slide.id), 'Outline slide identifiers');
  const plan = record(envelope.plan, ['schemaVersion', 'modules', 'pages'], [], 'plan');
  version(plan.schemaVersion);
  const modules: PresalesModule[] = array(plan.modules, 'modules', 100).map((value) => {
    const module = record(value, ['id', 'name', 'findingIds'], [], 'module');
    const findingIds = ids(module.findingIds, 'module findingIds');
    references(findingIds, known.findings, 'finding');
    return { id: id(module.id), name: string(module.name, 'module name'), findingIds };
  });
  unique(modules.map((module) => module.id), 'Module identifiers');
  const moduleIds = new Set(modules.map((module) => module.id));
  const pages: PagePlan[] = array(plan.pages, 'pages', 100).map((value) => {
    const page = record(value, ['slideId', 'pageType', 'keyMessage', 'moduleIds'], [], 'page');
    const membership = ids(page.moduleIds, 'page moduleIds');
    references(membership, moduleIds, 'module');
    return {
      slideId: id(page.slideId),
      pageType: choice<PageType>(page.pageType, ['cover', 'goals', 'architecture', 'overview', 'module', 'scenario', 'closing'], 'pageType'),
      keyMessage: string(page.keyMessage, 'keyMessage'), moduleIds: membership,
    };
  });
  if (pages.length !== slides.length) throw new Error('Plan pages and outline must have the same count');
  unique(pages.map((page) => page.slideId), 'Page identifiers');
  pages.forEach((page, index) => {
    if (page.slideId !== slides[index]!.id) throw new Error('Plan pages must match outline identifiers and order');
    if (page.pageType === 'architecture' || page.pageType === 'overview') {
      if (page.moduleIds.length !== modules.length) throw new Error('Architecture and overview must include every module');
      for (const moduleId of page.moduleIds) {
        if (!pages.slice(index + 1).some((later) => (later.pageType === 'module' || later.pageType === 'scenario') && later.moduleIds.includes(moduleId))) {
          throw new Error(`${moduleId} requires a later module or scenario page`);
        }
      }
    }
  });
  for (const module of modules) {
    if (!pages.some((page) => (page.pageType === 'module' || page.pageType === 'scenario') && page.moduleIds.includes(module.id))) {
      throw new Error(`${module.id} requires coverage by a later module or scenario page`);
    }
  }
  return { schemaVersion: 1, outline: { title: string(outline.title, 'outline title'), slides }, plan: { schemaVersion: 1, modules, pages } };
}

function citation(value: unknown): SourceCitation {
  const item = record(value, ['sourceId', 'title', 'locator'], ['url'], 'source citation');
  return { sourceId: id(item.sourceId), title: string(item.title, 'citation title'), locator: string(item.locator, 'citation locator'),
    ...(Object.hasOwn(item, 'url') ? { url: string(item.url, 'citation url') } : {}) };
}

function finite(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${field} must be finite numbers`);
  return value;
}

function parseSpec(value: unknown): SlideSpec {
  const spec = record(value, ['id', 'title', 'body', 'tables', 'charts', 'shapes', 'sourceMap', 'imageGenerationBrief'], ['findingIds', 'dataPointIds'], 'slide spec');
  const findingIds = optionalIds(spec, 'findingIds');
  const dataPointIds = optionalIds(spec, 'dataPointIds');
  const tables: SlideSpec['tables'] = array(spec.tables, 'tables').map((value) => {
    const table = record(value, ['id', 'headers', 'rows'], [], 'table');
    const headers = strings(table.headers, 'table headers');
    const rows = array(table.rows, 'table rows').map((value) => {
      const row = strings(value, 'table row');
      if (row.length !== headers.length) throw new Error('Table row width must match headers');
      return row;
    });
    return { id: id(table.id), headers, rows };
  });
  const charts: SlideSpec['charts'] = array(spec.charts, 'charts').map((value) => {
    const chart = record(value, ['id', 'type', 'categories', 'series'], [], 'chart');
    const categories = strings(chart.categories, 'chart categories');
    const series = array(chart.series, 'chart series').map((value) => {
      const entry = record(value, ['name', 'values'], [], 'chart series');
      const values = array(entry.values, 'chart values').map((value) => finite(value, 'chart values'));
      if (values.length !== categories.length) throw new Error('Chart series width must match categories');
      return { name: string(entry.name, 'chart series name'), values };
    });
    return { id: id(chart.id), type: choice(chart.type, ['bar', 'line', 'pie'] as const, 'chart type'), categories, series };
  });
  const shapes: SlideSpec['shapes'] = array(spec.shapes, 'shapes').map((value) => {
    const shape = record(value, ['id', 'type', 'x', 'y', 'w', 'h'], ['fill', 'line', 'text'], 'shape');
    const x = finite(shape.x, 'shape x'); const y = finite(shape.y, 'shape y');
    const w = finite(shape.w, 'shape w'); const h = finite(shape.h, 'shape h');
    if ([x, y, w, h].some((number) => number < 0)) throw new Error('Shape geometry must be nonnegative');
    return { id: id(shape.id), type: choice(shape.type, ['rect', 'ellipse', 'line'] as const, 'shape type'), x, y, w, h,
      ...(Object.hasOwn(shape, 'fill') ? { fill: string(shape.fill, 'shape fill') } : {}),
      ...(Object.hasOwn(shape, 'line') ? { line: string(shape.line, 'shape line') } : {}),
      ...(Object.hasOwn(shape, 'text') ? { text: string(shape.text, 'shape text') } : {}) };
  });
  unique([...tables, ...charts, ...shapes].map((item) => item.id), 'Slide nested identifiers');
  const sourceMap = array(spec.sourceMap, 'sourceMap').map(citation);
  unique(sourceMap.map((item) => item.sourceId), 'Source citation identifiers');
  return { id: id(spec.id), title: string(spec.title, 'slide title'), body: strings(spec.body, 'body'), tables, charts, shapes, sourceMap,
    imageGenerationBrief: string(spec.imageGenerationBrief, 'imageGenerationBrief'),
    ...(findingIds === undefined ? {} : { findingIds }), ...(dataPointIds === undefined ? {} : { dataPointIds }) };
}

function parseDesign(value: unknown): SlideDesignPlan {
  const design = record(value, ['slideId', 'layout', 'visualFocus', 'speakerNotes', 'textBindings', 'scene'], [], 'design');
  const textBindings = array(design.textBindings, 'text bindings', 100).map((value) => {
    const binding = record(value, ['id', 'path'], [], 'binding');
    return { id: id(binding.id), path: string(binding.path, 'binding path') };
  });
  unique(textBindings.map((binding) => binding.id), 'Binding identifiers');
  unique(textBindings.map((binding) => binding.path), 'Binding paths');
  let scene: SlideDesignPlan['scene'] = null;
  if (design.scene !== null) {
    const rawScene = record(design.scene, ['steps', 'edges'], [], 'scene');
    const steps = array(rawScene.steps, 'scene steps', 100).map((value) => {
      const step = record(value, ['id', 'moduleId', 'actor', 'location', 'triggerRef', 'actionRef', 'responseRef', 'outcomeRef'], [], 'scene step');
      return { id: id(step.id), moduleId: id(step.moduleId), actor: string(step.actor, 'actor'), location: string(step.location, 'location'),
        triggerRef: id(step.triggerRef), actionRef: id(step.actionRef), responseRef: id(step.responseRef), outcomeRef: id(step.outcomeRef) };
    });
    unique(steps.map((step) => step.id), 'Scene step identifiers');
    const edges = array(rawScene.edges, 'scene edges', 400).map((value) => {
      const edge = record(value, ['from', 'to'], [], 'scene edge');
      return { from: id(edge.from), to: id(edge.to) };
    });
    const stepIds = new Set(steps.map((step) => step.id));
    unique(edges.map((edge) => `${edge.from}/${edge.to}`), 'Scene edges');
    for (const edge of edges) {
      if (!stepIds.has(edge.from) || !stepIds.has(edge.to)) throw new Error('Scene edge references an unknown step');
      if (edge.from === edge.to) throw new Error('Scene cannot contain a self edge');
    }
    const bindingIds = new Set(textBindings.map((binding) => binding.id));
    for (const step of steps) {
      for (const ref of ['triggerRef', 'actionRef', 'responseRef', 'outcomeRef'] as const) {
        if (!bindingIds.has(step[ref])) throw new Error(`Scene ${ref} references an absent binding`);
      }
    }
    scene = { steps, edges };
  }
  return { slideId: id(design.slideId), layout: string(design.layout, 'layout'), visualFocus: string(design.visualFocus, 'visualFocus'),
    speakerNotes: string(design.speakerNotes, 'speakerNotes'), textBindings, scene };
}

function visibleBindings(spec: SlideSpec, design: SlideDesignPlan): { id: string; path: string; text: string }[] {
  if (spec.id !== design.slideId) throw new Error('Design slideId must match spec');
  const leaves = new Map<string, string>([['/title', spec.title]]);
  spec.body.forEach((text, index) => leaves.set(`/body/${index}`, text));
  spec.tables.forEach((table, index) => {
    table.headers.forEach((text, column) => leaves.set(`/tables/${index}/headers/${column}`, text));
    table.rows.forEach((row, rowIndex) => row.forEach((text, column) => leaves.set(`/tables/${index}/rows/${rowIndex}/${column}`, text)));
  });
  spec.charts.forEach((chart, index) => {
    chart.categories.forEach((text, category) => leaves.set(`/charts/${index}/categories/${category}`, text));
    chart.series.forEach((series, seriesIndex) => {
      leaves.set(`/charts/${index}/series/${seriesIndex}/name`, series.name);
      series.values.forEach((value, valueIndex) => leaves.set(`/charts/${index}/series/${seriesIndex}/values/${valueIndex}`, String(value)));
    });
  });
  spec.shapes.forEach((shape, index) => { if (shape.text !== undefined) leaves.set(`/shapes/${index}/text`, shape.text); });
  const result = design.textBindings.map((binding) => {
    if (!leaves.has(binding.path)) throw new Error(`Unsupported visible binding path: ${binding.path}`);
    return { ...binding, text: leaves.get(binding.path)! };
  });
  if (result.length !== leaves.size) throw new Error('Every visible leaf requires exactly one binding');
  return result;
}

/** Renderer defense in depth; resolving a draft never establishes approval. */
export function resolveVisibleBindings(spec: SlideSpec, design: SlideDesignPlan): { id: string; path: string; text: string }[] {
  checkPayload({ spec, design });
  return visibleBindings(parseSpec(spec), parseDesign(design));
}

export function parseDetailsEnvelope(raw: unknown, outline: OutlineEnvelope, analysis: SourceAnalysis): DetailsEnvelope {
  checkPayload(raw);
  const context = parseOutlineEnvelope(outline, analysis);
  const envelope = record(raw, ['schemaVersion', 'specs', 'designs'], [], 'details envelope');
  version(envelope.schemaVersion);
  const specs = array(envelope.specs, 'pages', 100).map(parseSpec);
  const designs = array(envelope.designs, 'pages', 100).map(parseDesign);
  if (specs.length !== context.outline.slides.length || designs.length !== specs.length) throw new Error('Details and outline page count must match');
  unique(specs.map((spec) => spec.id), 'Slide spec identifiers');
  unique(designs.map((design) => design.slideId), 'Design identifiers');
  const known = evidence(analysis);
  specs.forEach((spec, index) => {
    const slide = context.outline.slides[index]!;
    const design = designs[index]!;
    if (spec.id !== slide.id || design.slideId !== slide.id) throw new Error('Details must preserve outline identifiers and order');
    if (spec.title !== slide.title) throw new Error('Details title must match outline title');
    references(spec.findingIds ?? [], known.findings, 'finding');
    references(spec.dataPointIds ?? [], known.points, 'data point');
    references(spec.sourceMap.map((item) => item.sourceId), known.sources, 'source');
    for (const step of design.scene?.steps ?? []) {
      if (!context.plan.pages[index]!.moduleIds.includes(step.moduleId)) throw new Error('Scene moduleId is outside page membership');
    }
    visibleBindings(spec, design);
  });
  return { schemaVersion: 1, specs, designs };
}
