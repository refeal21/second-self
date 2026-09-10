import { describe, expect, it } from 'vitest';
import {
  richDetails,
  scenarioDetails,
  scenarioOutline,
  sourceAnalysis,
} from './fixtures.test-support.js';
import {
  parseDetailsEnvelope,
  parseOutlineEnvelope,
  resolveVisibleBindings,
} from './validation.js';

describe('presales outline envelope validation', () => {
  it('clones a valid draft without mutating the input', () => {
    const draft = scenarioOutline();
    const before = structuredClone(draft);

    const parsed = parseOutlineEnvelope(draft, sourceAnalysis());

    expect(draft).toEqual(before);
    expect(parsed).toEqual(before);
    expect(parsed).not.toBe(draft);
    expect(parsed.outline).not.toBe(draft.outline);
    draft.outline.title = 'Changed after parsing';
    expect(parsed.outline.title).toBe('Synthetic proposal');
  });

  it('rejects unknown envelope and nested fields', () => {
    const envelope = scenarioOutline() as unknown as Record<string, unknown>;
    envelope.approved = true;
    expect(() => parseOutlineEnvelope(envelope, sourceAnalysis())).toThrow(
      /unknown fields/,
    );

    const nested = scenarioOutline();
    (nested.plan.modules[0] as unknown as Record<string, unknown>).hash = 'fake';
    expect(() => parseOutlineEnvelope(nested, sourceAnalysis())).toThrow(
      /unknown fields/,
    );
  });

  it('rejects unsafe and duplicate identifiers', () => {
    const unsafe = scenarioOutline();
    unsafe.plan.modules[0]!.id = '../module';
    expect(() => parseOutlineEnvelope(unsafe, sourceAnalysis())).toThrow(
      /identifier/,
    );

    const duplicate = scenarioOutline();
    duplicate.plan.modules.push({ ...duplicate.plan.modules[0]! });
    expect(() => parseOutlineEnvelope(duplicate, sourceAnalysis())).toThrow(
      /module identifiers.*unique/i,
    );
  });

  it('rejects plan pages whose count or order differs from the outline', () => {
    const count = scenarioOutline();
    count.plan.pages = [];
    expect(() => parseOutlineEnvelope(count, sourceAnalysis())).toThrow(
      /pages.*outline.*count/i,
    );

    const order = twoPageOutline();
    order.plan.pages.reverse();
    expect(() => parseOutlineEnvelope(order, sourceAnalysis())).toThrow(
      /order/i,
    );
  });

  it('rejects dangling module references', () => {
    const draft = scenarioOutline();
    draft.plan.pages[0]!.moduleIds = ['module-missing'];
    expect(() => parseOutlineEnvelope(draft, sourceAnalysis())).toThrow(
      /unknown module/i,
    );
  });

  it.each(['architecture', 'overview'] as const)(
    'rejects a %s page missing a catalog module',
    (pageType) => {
      const draft = multiModuleOutline(pageType);
      draft.plan.pages[0]!.moduleIds = ['module-ops'];
      expect(() => parseOutlineEnvelope(draft, sourceAnalysis())).toThrow(
        /include every module/i,
      );
    },
  );

  it('allows architecture and overview together when both are explicit pages', () => {
    const draft = architectureAndOverviewOutline();
    expect(parseOutlineEnvelope(draft, sourceAnalysis())).toEqual(draft);
  });

  it('rejects a module never covered by a later module or scenario page', () => {
    const draft = scenarioOutline();
    draft.plan.pages[0]!.pageType = 'architecture';
    expect(() => parseOutlineEnvelope(draft, sourceAnalysis())).toThrow(
      /module-ops.*later module or scenario page/i,
    );
  });

  it('rejects module findings absent from source analysis', () => {
    const draft = scenarioOutline();
    draft.plan.modules[0]!.findingIds = ['finding-missing'];
    expect(() => parseOutlineEnvelope(draft, sourceAnalysis())).toThrow(
      /unknown finding/i,
    );
  });

  it('rejects outline provenance absent from source analysis', () => {
    const source = scenarioOutline();
    source.outline.slides[0]!.sourceIds = ['source-missing'];
    expect(() => parseOutlineEnvelope(source, sourceAnalysis())).toThrow(
      /unknown source/i,
    );

    const dataPoint = scenarioOutline();
    dataPoint.outline.slides[0]!.dataPointIds = ['point-missing'];
    expect(() => parseOutlineEnvelope(dataPoint, sourceAnalysis())).toThrow(
      /unknown data point/i,
    );
  });

  it('allows empty optional evidence collections', () => {
    const draft = scenarioOutline();
    draft.outline.slides[0]!.sourceIds = [];
    draft.outline.slides[0]!.findingIds = [];
    draft.outline.slides[0]!.dataPointIds = [];
    draft.plan.modules[0]!.findingIds = [];
    expect(parseOutlineEnvelope(draft, sourceAnalysis())).toEqual(draft);
  });

  it('rejects more than 100 pages or modules', () => {
    const pages = scenarioOutline();
    pages.outline.slides = Array.from({ length: 101 }, (_, index) => ({
      id: `slide-${index}`,
      title: `Slide ${index}`,
      purpose: 'Synthetic purpose',
    }));
    pages.plan.pages = pages.outline.slides.map((slide) => ({
      slideId: slide.id,
      pageType: 'cover' as const,
      keyMessage: 'Synthetic message',
      moduleIds: [],
    }));
    expect(() => parseOutlineEnvelope(pages, sourceAnalysis())).toThrow(
      /at most 100 pages/i,
    );

    const modules = scenarioOutline();
    modules.plan.modules = Array.from({ length: 101 }, (_, index) => ({
      id: `module-${index}`,
      name: `Module ${index}`,
      findingIds: [],
    }));
    expect(() => parseOutlineEnvelope(modules, sourceAnalysis())).toThrow(
      /at most 100 modules/i,
    );
  });
});

describe('presales detail envelope validation', () => {
  it('roundtrips a valid draft and resolves every visible leaf once', () => {
    const outline = scenarioOutline();
    const draft = richDetails();
    const parsed = parseDetailsEnvelope(draft, outline, sourceAnalysis());

    expect(parsed).toEqual(draft);
    expect(parsed).not.toBe(draft);
    expect(resolveVisibleBindings(parsed.specs[0]!, parsed.designs[0]!)).toEqual([
      { id: 'title', path: '/title', text: 'Incident response' },
      { id: 'trigger', path: '/body/0', text: 'Alert received' },
      { id: 'action', path: '/body/1', text: 'Dispatch' },
      { id: 'response', path: '/body/2', text: 'On-site response' },
      { id: 'outcome', path: '/body/3', text: 'Close review' },
      { id: 'table-header-0', path: '/tables/0/headers/0', text: 'Stage' },
      { id: 'table-header-1', path: '/tables/0/headers/1', text: 'Owner' },
      { id: 'table-row-0-0', path: '/tables/0/rows/0/0', text: 'Review' },
      { id: 'table-row-0-1', path: '/tables/0/rows/0/1', text: 'Operator' },
      { id: 'chart-category-0', path: '/charts/0/categories/0', text: 'Open' },
      { id: 'chart-category-1', path: '/charts/0/categories/1', text: 'Closed' },
      { id: 'chart-series-name-0', path: '/charts/0/series/0/name', text: 'Incidents' },
      { id: 'chart-value-0-0', path: '/charts/0/series/0/values/0', text: '7' },
      { id: 'chart-value-0-1', path: '/charts/0/series/0/values/1', text: '5' },
      { id: 'shape-text-0', path: '/shapes/0/text', text: 'Confirmed boundary' },
    ]);
  });

  it('does not mutate a frozen input or retain its references', () => {
    const draft = scenarioDetails();
    deepFreeze(draft);
    const parsed = parseDetailsEnvelope(draft, scenarioOutline(), sourceAnalysis());
    expect(parsed).toEqual(draft);
    expect(parsed.specs).not.toBe(draft.specs);
    expect(parsed.designs[0]!.scene).not.toBe(draft.designs[0]!.scene);
  });

  it('rejects unknown fields rather than accepting approval metadata', () => {
    const draft = scenarioDetails();
    (draft.designs[0] as unknown as Record<string, unknown>).approvedAt =
      '2026-09-10T00:00:00Z';
    expect(() =>
      parseDetailsEnvelope(draft, scenarioOutline(), sourceAnalysis()),
    ).toThrow(/unknown fields/);
  });

  it('rejects mismatched detail page order, title, and count', () => {
    const outline = twoPageOutline();
    const order = twoPageDetails();
    order.specs.reverse();
    order.designs.reverse();
    expect(() => parseDetailsEnvelope(order, outline, sourceAnalysis())).toThrow(
      /order/i,
    );

    const title = scenarioDetails();
    title.specs[0]!.title = 'Different title';
    expect(() =>
      parseDetailsEnvelope(title, scenarioOutline(), sourceAnalysis()),
    ).toThrow(/title/i);

    const count = scenarioDetails();
    count.designs = [];
    expect(() =>
      parseDetailsEnvelope(count, scenarioOutline(), sourceAnalysis()),
    ).toThrow(/count/i);
  });

  it('rejects a scene referencing an absent binding instead of silently dropping it', () => {
    const draft = scenarioDetails();
    draft.designs[0]!.scene!.steps[0]!.responseRef = 'absent';
    expect(() =>
      parseDetailsEnvelope(draft, scenarioOutline(), sourceAnalysis()),
    ).toThrow(/responseRef/);
  });

  it('rejects notes as a visible text binding', () => {
    const draft = scenarioDetails();
    draft.designs[0]!.textBindings[0]!.path = '/speakerNotes';
    expect(() =>
      parseDetailsEnvelope(draft, scenarioOutline(), sourceAnalysis()),
    ).toThrow(/path/);
  });

  it.each(['/body/01', '/body/-1', '/body/1.0', '/body/99', '/body/~1proto', '/__proto__/title', '/body/constructor']) (
    'rejects malformed or out-of-range visible path %s',
    (path) => {
      const draft = scenarioDetails();
      draft.designs[0]!.textBindings[1]!.path = path;
      expect(() =>
        parseDetailsEnvelope(draft, scenarioOutline(), sourceAnalysis()),
      ).toThrow(/path/);
    },
  );

  it('rejects duplicate binding paths and identifiers', () => {
    const duplicatePath = scenarioDetails();
    duplicatePath.designs[0]!.textBindings[1]!.path = '/title';
    expect(() =>
      parseDetailsEnvelope(duplicatePath, scenarioOutline(), sourceAnalysis()),
    ).toThrow(/binding path.*unique/i);

    const duplicateId = scenarioDetails();
    duplicateId.designs[0]!.textBindings[1]!.id = 'title';
    expect(() =>
      parseDetailsEnvelope(duplicateId, scenarioOutline(), sourceAnalysis()),
    ).toThrow(/binding identifiers.*unique/i);
  });

  it('rejects an unbound visible leaf', () => {
    const draft = scenarioDetails();
    draft.designs[0]!.scene = null;
    draft.designs[0]!.textBindings.pop();
    expect(() =>
      parseDetailsEnvelope(draft, scenarioOutline(), sourceAnalysis()),
    ).toThrow(/every visible leaf.*exactly one binding/i);
  });

  it('rejects unsupported, self, and duplicate scene edges', () => {
    const unsupported = scenarioDetails();
    unsupported.designs[0]!.scene!.edges[0]!.to = 'step-missing';
    expect(() =>
      parseDetailsEnvelope(unsupported, scenarioOutline(), sourceAnalysis()),
    ).toThrow(/edge.*unknown step/i);

    const self = scenarioDetails();
    self.designs[0]!.scene!.edges[0]!.to = 'step-1';
    expect(() =>
      parseDetailsEnvelope(self, scenarioOutline(), sourceAnalysis()),
    ).toThrow(/self edge/i);

    const duplicate = scenarioDetails();
    duplicate.designs[0]!.scene!.edges.push({ from: 'step-1', to: 'step-2' });
    expect(() =>
      parseDetailsEnvelope(duplicate, scenarioOutline(), sourceAnalysis()),
    ).toThrow(/scene edges.*unique/i);
  });

  it('rejects a scene module outside the page membership', () => {
    const outline = twoPageOutline();
    outline.plan.modules.push({
      id: 'module-security',
      name: 'Security review',
      findingIds: ['finding-security'],
    });
    outline.plan.pages[0]!.moduleIds = ['module-security'];
    const draft = twoPageDetails();
    draft.designs[0]!.scene!.steps[0]!.moduleId = 'module-ops';
    expect(() => parseDetailsEnvelope(draft, outline, sourceAnalysis())).toThrow(
      /moduleId.*page membership/i,
    );
  });

  it('rejects body strings instead of arrays', () => {
    const draft = scenarioDetails();
    (draft.specs[0] as unknown as Record<string, unknown>).body = 'One paragraph';
    expect(() =>
      parseDetailsEnvelope(draft, scenarioOutline(), sourceAnalysis()),
    ).toThrow(/body.*string array/i);
  });

  it('rejects non-finite numbers, chart width mismatch, and table width mismatch', () => {
    const number = richDetails();
    number.specs[0]!.charts[0]!.series[0]!.values[0] = Number.NaN;
    expect(() =>
      parseDetailsEnvelope(number, scenarioOutline(), sourceAnalysis()),
    ).toThrow(/chart.*values/i);

    const chart = richDetails();
    chart.specs[0]!.charts[0]!.series[0]!.values.pop();
    expect(() =>
      parseDetailsEnvelope(chart, scenarioOutline(), sourceAnalysis()),
    ).toThrow(/chart.*width/i);

    const table = richDetails();
    table.specs[0]!.tables[0]!.rows[0]!.pop();
    expect(() =>
      parseDetailsEnvelope(table, scenarioOutline(), sourceAnalysis()),
    ).toThrow(/table.*width/i);
  });

  it('rejects unknown finding, data point, and source references', () => {
    const finding = scenarioDetails();
    finding.specs[0]!.findingIds = ['finding-missing'];
    expect(() =>
      parseDetailsEnvelope(finding, scenarioOutline(), sourceAnalysis()),
    ).toThrow(/unknown finding/i);

    const point = scenarioDetails();
    point.specs[0]!.dataPointIds = ['point-missing'];
    expect(() =>
      parseDetailsEnvelope(point, scenarioOutline(), sourceAnalysis()),
    ).toThrow(/unknown data point/i);

    const source = scenarioDetails();
    source.specs[0]!.sourceMap[0]!.sourceId = 'source-missing';
    expect(() =>
      parseDetailsEnvelope(source, scenarioOutline(), sourceAnalysis()),
    ).toThrow(/unknown source/i);
  });

  it('accepts empty optional collections and does not guess semantics from text', () => {
    const outline = scenarioOutline();
    outline.outline.slides[0]!.findingIds = [];
    outline.outline.slides[0]!.dataPointIds = [];
    outline.plan.modules[0]!.findingIds = [];
    const draft = scenarioDetails();
    draft.specs[0]!.findingIds = [];
    draft.specs[0]!.dataPointIds = [];
    draft.specs[0]!.sourceMap = [];
    draft.specs[0]!.body[0] = 'Question: could this save 90% automatically?';
    expect(parseDetailsEnvelope(draft, outline, sourceAnalysis())).toEqual(draft);
  });

  it('enforces per-page binding, step, and edge bounds', () => {
    const bindings = scenarioDetails();
    bindings.designs[0]!.textBindings = Array.from({ length: 101 }, (_, index) => ({
      id: `binding-${index}`,
      path: '/title',
    }));
    expect(() =>
      parseDetailsEnvelope(bindings, scenarioOutline(), sourceAnalysis()),
    ).toThrow(/at most 100 text bindings/i);

    const steps = scenarioDetails();
    steps.designs[0]!.scene!.steps = Array.from({ length: 101 }, (_, index) => ({
      ...steps.designs[0]!.scene!.steps[0]!,
      id: `step-${index}`,
    }));
    expect(() =>
      parseDetailsEnvelope(steps, scenarioOutline(), sourceAnalysis()),
    ).toThrow(/at most 100 scene steps/i);

    const edges = scenarioDetails();
    edges.designs[0]!.scene!.edges = Array.from({ length: 401 }, () => ({
      from: 'step-1',
      to: 'step-2',
    }));
    expect(() =>
      parseDetailsEnvelope(edges, scenarioOutline(), sourceAnalysis()),
    ).toThrow(/at most 400 scene edges/i);
  });

  it('rejects descriptive strings over 20,000 characters', () => {
    const draft = scenarioDetails();
    draft.designs[0]!.speakerNotes = 'x'.repeat(20_001);
    expect(() =>
      parseDetailsEnvelope(draft, scenarioOutline(), sourceAnalysis()),
    ).toThrow(/20,000 characters/i);
  });

  it('rejects envelopes over 2 MiB', () => {
    const draft = scenarioDetails() as unknown as Record<string, unknown>;
    draft.padding = 'x'.repeat(2 * 1024 * 1024);
    expect(() =>
      parseDetailsEnvelope(draft, scenarioOutline(), sourceAnalysis()),
    ).toThrow(/2 MiB/i);
  });

  it('counts UTF-8 bytes, including multibyte text, toward the envelope bound', () => {
    const draft = scenarioDetails() as unknown as Record<string, unknown>;
    draft.padding = '界'.repeat(700_000);
    expect(() => parseDetailsEnvelope(draft, scenarioOutline(), sourceAnalysis())).toThrow(/2 MiB/);
  });

  it('rejects duplicate nested object and scene step identifiers', () => {
    const draft = richDetails();
    draft.specs[0]!.charts[0]!.id = 'table-1';
    expect(() => parseDetailsEnvelope(draft, scenarioOutline(), sourceAnalysis())).toThrow(/nested identifiers.*unique/i);
    const scene = scenarioDetails();
    scene.designs[0]!.scene!.steps[1]!.id = 'step-1';
    expect(() => parseDetailsEnvelope(scene, scenarioOutline(), sourceAnalysis())).toThrow(/step identifiers.*unique/i);
  });

  it('rejects duplicate pages even when matching counts are retained', () => {
    const draft = twoPageDetails();
    draft.specs[1]!.id = draft.specs[0]!.id;
    expect(() => parseDetailsEnvelope(draft, twoPageOutline(), sourceAnalysis())).toThrow(/identifiers.*unique/i);
    const outline = twoPageOutline();
    outline.outline.slides[1]!.id = outline.outline.slides[0]!.id;
    expect(() => parseOutlineEnvelope(outline, sourceAnalysis())).toThrow(/identifiers.*unique/i);
  });

  it.each([Number.POSITIVE_INFINITY, -1, '1'])(
    'rejects invalid shape geometry %s without coercion', (value) => {
      const draft = richDetails();
      (draft.specs[0]!.shapes[0] as unknown as Record<string, unknown>).x = value;
      expect(() => parseDetailsEnvelope(draft, scenarioOutline(), sourceAnalysis())).toThrow(/shape/i);
    },
  );

  it('rejects number strings and unsupported chart types without normalization', () => {
    const draft = richDetails();
    (draft.specs[0]!.charts[0]!.series[0]!.values as unknown[])[0] = '7';
    expect(() => parseDetailsEnvelope(draft, scenarioOutline(), sourceAnalysis())).toThrow(/chart values/i);
    const chart = richDetails();
    (chart.specs[0]!.charts[0] as unknown as Record<string, unknown>).type = 'donut';
    expect(() => parseDetailsEnvelope(chart, scenarioOutline(), sourceAnalysis())).toThrow(/chart type/i);
  });

  it('requires numeric chart values to have bindings too', () => {
    const draft = richDetails();
    draft.designs[0]!.textBindings = draft.designs[0]!.textBindings.filter(({ id }) => id !== 'chart-value-0-0');
    expect(() => parseDetailsEnvelope(draft, scenarioOutline(), sourceAnalysis())).toThrow(/every visible leaf/i);
  });

  it('accepts explicitly empty visible strings and empty scene collections', () => {
    const draft = richDetails();
    draft.specs[0]!.shapes[0]!.text = '';
    draft.specs[0]!.body[0] = '';
    draft.designs[0]!.scene = { steps: [], edges: [] };
    const parsed = parseDetailsEnvelope(draft, scenarioOutline(), sourceAnalysis());
    expect(resolveVisibleBindings(parsed.specs[0]!, parsed.designs[0]!)).toContainEqual({ id: 'shape-text-0', path: '/shapes/0/text', text: '' });
  });

  it('validates a caller-supplied outline again before using it as context', () => {
    const outline = scenarioOutline();
    (outline.plan as unknown as Record<string, unknown>).approved = true;
    expect(() => parseDetailsEnvelope(scenarioDetails(), outline, sourceAnalysis())).toThrow(/unknown fields/i);
  });

  it('validates bindings and scene references at the renderer helper boundary', () => {
    const draft = scenarioDetails();
    draft.designs[0]!.textBindings[1]!.path = '/imageGenerationBrief';
    expect(() => resolveVisibleBindings(draft.specs[0]!, draft.designs[0]!)).toThrow(/path/);
    draft.designs[0]!.textBindings[1]!.path = '/body/0';
    draft.designs[0]!.scene!.steps[0]!.triggerRef = 'absent';
    expect(() => resolveVisibleBindings(draft.specs[0]!, draft.designs[0]!)).toThrow(/triggerRef/);
  });
});

describe('presales unknown-input boundary', () => {
  it('rejects inherited fields and own prototype keys without pollution', () => {
    const inherited = Object.create(scenarioOutline()) as unknown;
    expect(() => parseOutlineEnvelope(inherited, sourceAnalysis())).toThrow(/plain JSON/);
    const raw = JSON.parse(JSON.stringify(scenarioOutline())) as Record<string, unknown>;
    Object.defineProperty(raw, '__proto__', { value: { polluted: true }, enumerable: true });
    expect(() => parseOutlineEnvelope(raw, sourceAnalysis())).toThrow(/unknown fields/);
    expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
  });

  it('does not invoke getters or serialization hooks', () => {
    let reads = 0;
    const getter = scenarioOutline();
    Object.defineProperty(getter, 'outline', { get: () => { reads++; throw new Error('Getter executed'); }, enumerable: true });
    expect(() => parseOutlineEnvelope(getter, sourceAnalysis())).toThrow(/data fields/);
    const hook = scenarioOutline() as unknown as Record<string, unknown>;
    hook.toJSON = () => { reads++; return {}; };
    expect(() => parseOutlineEnvelope(hook, sourceAnalysis())).toThrow(/JSON data/);
    expect(reads).toBe(0);
  });

  it('accepts plain null-prototype records and clones them into regular output', () => {
    const draft = scenarioOutline();
    const raw = Object.assign(Object.create(null) as object, draft);
    expect(parseOutlineEnvelope(raw, sourceAnalysis())).toEqual(draft);
  });

  it('rejects cycles, sparse arrays, symbols, undefined, and non-JSON primitives', () => {
    const cycle = scenarioOutline() as unknown as Record<string, unknown>;
    cycle.loop = cycle;
    const sparse = scenarioOutline();
    sparse.plan.pages.length = 3;
    const symbol = scenarioOutline();
    Object.defineProperty(symbol, Symbol('metadata'), { value: true });
    for (const raw of [cycle, sparse, symbol, undefined, 1n, () => null]) {
      expect(() => parseOutlineEnvelope(raw, sourceAnalysis())).toThrow();
    }
  });

  it('rejects unknown nested fields, missing fields, and unsupported versions', () => {
    const nested = richDetails();
    (nested.specs[0]!.charts[0]!.series[0] as unknown as Record<string, unknown>).label = 'Additional screen copy';
    expect(() => parseDetailsEnvelope(nested, scenarioOutline(), sourceAnalysis())).toThrow(/unknown fields/);
    const missing = scenarioDetails() as unknown as Record<string, unknown>;
    delete missing.schemaVersion;
    expect(() => parseDetailsEnvelope(missing, scenarioOutline(), sourceAnalysis())).toThrow(/missing fields/);
    const version = scenarioOutline() as unknown as Record<string, unknown>;
    version.schemaVersion = '1';
    expect(() => parseOutlineEnvelope(version, sourceAnalysis())).toThrow(/schemaVersion/);
  });
});

function twoPageOutline() {
  const first = scenarioOutline();
  const second = structuredClone(first.outline.slides[0]!);
  second.id = 'scenario-2';
  second.title = 'Review handoff';
  first.outline.slides.push(second);
  first.plan.pages.push({
    ...first.plan.pages[0]!,
    slideId: 'scenario-2',
    keyMessage: 'A second synthetic page.',
  });
  return first;
}

function twoPageDetails() {
  const draft = scenarioDetails();
  const spec = structuredClone(draft.specs[0]!);
  spec.id = 'scenario-2';
  spec.title = 'Review handoff';
  const design = structuredClone(draft.designs[0]!);
  design.slideId = 'scenario-2';
  draft.specs.push(spec);
  draft.designs.push(design);
  return draft;
}

function multiModuleOutline(pageType: 'architecture' | 'overview') {
  const draft = scenarioOutline();
  draft.plan.modules.push({
    id: 'module-security',
    name: 'Security review',
    findingIds: ['finding-security'],
  });
  draft.plan.pages[0]!.pageType = pageType;
  draft.plan.pages[0]!.moduleIds = ['module-ops', 'module-security'];
  const laterSlide = {
    id: 'module-coverage',
    title: 'Module coverage',
    purpose: 'Cover both confirmed modules',
  };
  draft.outline.slides.push(laterSlide);
  draft.plan.pages.push({
    slideId: laterSlide.id,
    pageType: 'module',
    keyMessage: 'Both modules have later coverage.',
    moduleIds: ['module-ops', 'module-security'],
  });
  return draft;
}

function architectureAndOverviewOutline() {
  const draft = multiModuleOutline('architecture');
  const overviewSlide = {
    id: 'overview-1',
    title: 'Overview',
    purpose: 'Show the explicitly requested overview',
  };
  draft.outline.slides.splice(1, 0, overviewSlide);
  draft.plan.pages.splice(1, 0, {
    slideId: overviewSlide.id,
    pageType: 'overview',
    keyMessage: 'Both explicit relationship pages use the same catalog.',
    moduleIds: ['module-ops', 'module-security'],
  });
  return draft;
}

function deepFreeze(value: unknown): void {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
}
