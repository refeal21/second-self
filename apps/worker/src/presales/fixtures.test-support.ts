import type {
  DetailsEnvelope,
  OutlineEnvelope,
  SlideDesignPlan,
} from './contracts.js';
import type { SlideSpec, SourceAnalysis } from '../ppt-project.js';

type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> };

export function sourceAnalysis(): SourceAnalysis {
  return {
    findings: [
      {
        id: 'finding-ops',
        text: 'Operators follow a four-step incident workflow.',
        sourceIds: ['source-a'],
      },
      {
        id: 'finding-security',
        text: 'Security review is a separately confirmed module.',
        sourceIds: ['source-a'],
      },
    ],
    dataPoints: [
      {
        id: 'point-volume',
        label: 'Reviewed incidents',
        value: 12,
        sourceIds: ['source-a'],
      },
    ],
    sourceMap: [
      {
        sourceId: 'source-a',
        title: 'Synthetic operating note',
        locator: 'section 1',
      },
    ],
  };
}

export function scenarioOutline(): Mutable<OutlineEnvelope> {
  return {
    schemaVersion: 1,
    outline: {
      title: 'Synthetic proposal',
      slides: [
        {
          id: 'scenario-1',
          title: 'Incident response',
          purpose: 'Show the confirmed operating sequence',
          sourceIds: ['source-a'],
          findingIds: ['finding-ops'],
          dataPointIds: ['point-volume'],
        },
      ],
    },
    plan: {
      schemaVersion: 1,
      modules: [
        {
          id: 'module-ops',
          name: 'Incident operations',
          findingIds: ['finding-ops'],
        },
      ],
      pages: [
        {
          slideId: 'scenario-1',
          pageType: 'scenario',
          keyMessage: 'A confirmed sequence connects each handoff.',
          moduleIds: ['module-ops'],
        },
      ],
    },
  };
}

export function scenarioDetails(): Mutable<DetailsEnvelope> {
  return {
    schemaVersion: 1,
    specs: [scenarioSpec()],
    designs: [scenarioDesign()],
  };
}

export function richDetails(): Mutable<DetailsEnvelope> {
  const draft = scenarioDetails();
  draft.specs[0]!.tables = [
    {
      id: 'table-1',
      headers: ['Stage', 'Owner'],
      rows: [['Review', 'Operator']],
    },
  ];
  draft.specs[0]!.charts = [
    {
      id: 'chart-1',
      type: 'bar',
      categories: ['Open', 'Closed'],
      series: [{ name: 'Incidents', values: [7, 5] }],
    },
  ];
  draft.specs[0]!.shapes = [
    {
      id: 'shape-1',
      type: 'rect',
      x: 1,
      y: 2,
      w: 3,
      h: 4,
      text: 'Confirmed boundary',
    },
  ];
  draft.designs[0]!.textBindings.push(
    { id: 'table-header-0', path: '/tables/0/headers/0' },
    { id: 'table-header-1', path: '/tables/0/headers/1' },
    { id: 'table-row-0-0', path: '/tables/0/rows/0/0' },
    { id: 'table-row-0-1', path: '/tables/0/rows/0/1' },
    { id: 'chart-category-0', path: '/charts/0/categories/0' },
    { id: 'chart-category-1', path: '/charts/0/categories/1' },
    { id: 'chart-series-name-0', path: '/charts/0/series/0/name' },
    { id: 'chart-value-0-0', path: '/charts/0/series/0/values/0' },
    { id: 'chart-value-0-1', path: '/charts/0/series/0/values/1' },
    { id: 'shape-text-0', path: '/shapes/0/text' },
  );
  return draft;
}

function scenarioSpec(): Mutable<SlideSpec> {
  return {
    id: 'scenario-1',
    title: 'Incident response',
    body: ['Alert received', 'Dispatch', 'On-site response', 'Close review'],
    findingIds: ['finding-ops'],
    dataPointIds: ['point-volume'],
    tables: [],
    charts: [],
    shapes: [],
    sourceMap: [
      {
        sourceId: 'source-a',
        title: 'Synthetic operating note',
        locator: 'section 1',
      },
    ],
    imageGenerationBrief: 'Use a directional sequence with one clear handoff.',
  };
}

function scenarioDesign(): SlideDesignPlan {
  return {
    slideId: 'scenario-1',
    layout: 'Directional storyboard',
    visualFocus: 'The handoff sequence',
    speakerNotes: 'Explain the synthetic example without adding screen text.',
    textBindings: [
      { id: 'title', path: '/title' },
      { id: 'trigger', path: '/body/0' },
      { id: 'action', path: '/body/1' },
      { id: 'response', path: '/body/2' },
      { id: 'outcome', path: '/body/3' },
    ],
    scene: {
      steps: [
        {
          id: 'step-1',
          moduleId: 'module-ops',
          actor: 'Operator',
          location: 'Operations room',
          triggerRef: 'trigger',
          actionRef: 'action',
          responseRef: 'response',
          outcomeRef: 'outcome',
        },
        {
          id: 'step-2',
          moduleId: 'module-ops',
          actor: 'Reviewer',
          location: 'Review desk',
          triggerRef: 'outcome',
          actionRef: 'action',
          responseRef: 'response',
          outcomeRef: 'title',
        },
      ],
      edges: [{ from: 'step-1', to: 'step-2' }],
    },
  };
}
