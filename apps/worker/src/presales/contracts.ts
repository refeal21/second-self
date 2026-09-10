import type { PptOutline, SlideSpec } from '../ppt-project.js';

export type PageType = 'cover' | 'goals' | 'architecture' | 'overview' | 'module' | 'scenario' | 'closing';

export interface PresalesModule {
  id: string;
  name: string;
  findingIds: string[];
}

export interface PagePlan {
  slideId: string;
  pageType: PageType;
  keyMessage: string;
  moduleIds: string[];
}

export interface PresalesPlan {
  schemaVersion: 1;
  modules: PresalesModule[];
  pages: PagePlan[];
}

export interface TextBinding { id: string; path: string }

export interface SceneStep {
  id: string;
  moduleId: string;
  actor: string;
  location: string;
  triggerRef: string;
  actionRef: string;
  responseRef: string;
  outcomeRef: string;
}

export interface SceneEdge { from: string; to: string }

export interface SlideDesignPlan {
  slideId: string;
  layout: string;
  visualFocus: string;
  speakerNotes: string;
  textBindings: TextBinding[];
  scene: { steps: SceneStep[]; edges: SceneEdge[] } | null;
}

/** Model drafts only. These envelopes do not convey approval authority. */
export interface OutlineEnvelope {
  schemaVersion: 1;
  outline: PptOutline;
  plan: PresalesPlan;
}

export interface DetailsEnvelope {
  schemaVersion: 1;
  specs: SlideSpec[];
  designs: SlideDesignPlan[];
}
