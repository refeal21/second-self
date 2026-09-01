import type { PptWorkflowStage, WorkflowStatus } from './types.js';

const nextStage: Partial<Record<PptWorkflowStage, PptWorkflowStage>> = {
  intake: 'source_analysis',
  source_analysis: 'outline_review',
  outline_review: 'detail_review',
  detail_review: 'visual_review',
  visual_review: 'conversion',
  conversion: 'qa',
  qa: 'completed',
};

export function canTransition(from: WorkflowStatus, to: WorkflowStatus): boolean {
  if (to === 'blocked') {
    return from !== 'completed' && from !== 'blocked';
  }

  return from !== 'blocked' && nextStage[from] === to;
}
