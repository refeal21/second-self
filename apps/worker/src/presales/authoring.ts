/** Pure context assembly shared by native-host requests and frontend previews.
 * This module grants no file-selection, dispatch, save, or approval authority. */
import type { SourceAnalysis } from '../ppt-project.js';
import type { VisualStyleState } from '../visual-style.js';
import type { OutlineEnvelope, DetailsEnvelope } from './contracts.js';
import { buildPresalesStageInstructions, PRESALES_SKILL_METADATA } from './planning.js';
import { parseDetailsEnvelope, parseOutlineEnvelope } from './validation.js';
import policy from './authoring-prompt.contract.json' with { type: 'json' };

export interface PairedAuthoringContext {
  name: string; brief: string;
  context: { taskBrief: string; sourceInstructions: Record<string,string>; outlineRequirements:string } | null;
  sources: { original: {id:string;fileName:string}; asset:{relativePath:string} }[];
  analysis: { original:{output:SourceAnalysis}; asset:{relativePath:string} };
  preferences: unknown; palette: VisualStyleState;
  skill: {id:string;version:string;sha256:string}; approvedOutline: OutlineEnvelope | null;
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a < b ? -1 : a > b ? 1 : 0).map(([k,v])=>[k,sorted(v)]));
  return value;
}

export function buildPairedAuthoringPrompt(stage:'outline'|'details', context:PairedAuthoringContext):string {
  if (context.skill.id !== PRESALES_SKILL_METADATA.id || context.skill.version !== PRESALES_SKILL_METADATA.version || context.skill.sha256 !== PRESALES_SKILL_METADATA.sha256) throw new Error('Paired authoring requires the current bundled skill');
  const outline = stage === 'details' ? parseOutlineEnvelope(context.approvedOutline,context.analysis.original.output) : null;
  const saved = context.context ?? {taskBrief:'',sourceInstructions:{},outlineRequirements:''};
  const input = {project:{name:context.name,goal:context.brief}, taskBrief:saved.taskBrief,
    sourceFiles:context.sources.map(s=>({sourceId:s.original.id,fileName:s.original.fileName,relativePath:s.asset.relativePath,instructions:saved.sourceInstructions[s.original.id]??''})),
    outlineRequirements:saved.outlineRequirements,currentAnalysis:context.analysis.asset.relativePath,
    approvedPreferences:context.preferences,presalesSkill:context.skill,
    ...(outline ? {approvedOutline:outline.outline,approvedPresalesPlan:outline.plan,confirmedVisualStyle:context.palette.profile ? context.palette : null}:{}),
  };
  return [stage === 'outline' ? policy.outlineTask : policy.detailsTask,buildPresalesStageInstructions(stage),policy.contextPolicy,policy.contextLabel,JSON.stringify(sorted(input),null,2),...policy.tail].join('\n');
}

export function parsePairedAuthoringResult(stage:'outline'|'details',raw:string,context:PairedAuthoringContext):OutlineEnvelope|DetailsEnvelope {
  if (new TextEncoder().encode(raw).length>2*1024*1024) throw new Error('Envelope exceeds 2 MiB');
  const value:unknown = JSON.parse(raw);
  return stage === 'outline' ? parseOutlineEnvelope(value,context.analysis.original.output)
    : parseDetailsEnvelope(value,parseOutlineEnvelope(context.approvedOutline,context.analysis.original.output),context.analysis.original.output);
}
