import type { SlideSpec } from '../ppt-project.js';
import type { OutlineEnvelope, SlideDesignPlan } from './contracts.js';
import { PRESALES_SKILL } from './skill.generated.js';
import { resolveVisibleBindings } from './validation.js';
import authoringPolicy from './authoring-prompt.contract.json' with { type: 'json' };

/** Supplied by the future trusted native snapshot loader; this is not approval authority. */
export interface PresalesPromptOptions { outline?: OutlineEnvelope }

export const PRESALES_SKILL_METADATA = {
  id: PRESALES_SKILL.id,
  version: PRESALES_SKILL.version,
  sha256: PRESALES_SKILL.sha256,
} as const;


export function buildPresalesStageInstructions(stage: 'outline' | 'details'): string {
  return [PRESALES_SKILL.stages[stage], (stage === 'outline' ? authoringPolicy.outlineContract : authoringPolicy.detailsContract).join('\n')].join('\n\n');
}

/** Validates references defensively; callers must separately establish joint approval. */
export function buildPresalesVisualContext(spec: SlideSpec, design: SlideDesignPlan) {
  const bindings = resolveVisibleBindings(spec, design);
  return {
    presalesSkill: { ...PRESALES_SKILL_METADATA },
    approvedDesign: {
      slideId: design.slideId,
      layout: design.layout,
      visualFocus: design.visualFocus,
      // Keep text only in approvedSlideSpec; the resolver verifies these paths.
      textBindings: bindings.map(({ id, path }) => ({ id, path })),
      scene: structuredClone(design.scene),
    },
  };
}
