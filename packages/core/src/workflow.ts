import type { ApprovalStatus, PptWorkflowStage, WorkflowStatus } from './types.js';

const nextStage: Partial<Record<PptWorkflowStage, PptWorkflowStage>> = {
  intake: 'source_analysis',
  source_analysis: 'outline_review',
  outline_review: 'detail_review',
  detail_review: 'visual_review',
  visual_review: 'conversion',
  conversion: 'qa',
  qa: 'completed',
};

export interface WorkflowApproval {
  stage: PptWorkflowStage;
  status: ApprovalStatus;
  slideId?: string;
}

export interface WorkflowTransitionContext {
  approvals: readonly WorkflowApproval[];
  visualSlideIds?: readonly string[];
}

const emptyTransitionContext: WorkflowTransitionContext = { approvals: [] };

export function canTransition(
  from: WorkflowStatus,
  to: WorkflowStatus,
  context: WorkflowTransitionContext = emptyTransitionContext,
): boolean {
  if (to === 'blocked') {
    return from !== 'completed' && from !== 'blocked';
  }

  if (from === 'blocked' || nextStage[from] !== to) {
    return false;
  }

  if (from === 'outline_review' || from === 'detail_review') {
    return hasApprovedStage(context.approvals, from);
  }

  if (from === 'visual_review') {
    const visualSlideIds = context.visualSlideIds ?? [];
    return visualSlideIds.length > 0
      && visualSlideIds.every((slideId) => hasApprovedStage(context.approvals, from, slideId));
  }

  return true;
}

function hasApprovedStage(
  approvals: readonly WorkflowApproval[],
  stage: PptWorkflowStage,
  slideId?: string,
): boolean {
  return approvals.some((approval) => (
    approval.stage === stage
    && approval.status === 'approved'
    && (slideId === undefined || approval.slideId === slideId)
  ));
}
