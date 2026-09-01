export const pptWorkflowStages = [
  'intake',
  'source_analysis',
  'outline_review',
  'detail_review',
  'visual_review',
  'conversion',
  'qa',
  'completed',
] as const;

export type PptWorkflowStage = (typeof pptWorkflowStages)[number];
export type WorkflowStatus = PptWorkflowStage | 'blocked';
export type VersionStatus = 'draft' | 'frozen';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected';
export type MemoryProposalStatus = 'proposed' | 'approved' | 'rejected';

export interface Project {
  id: string;
  name: string;
  workflowStatus: WorkflowStatus;
  createdAt: string;
  updatedAt: string;
}

export interface Version {
  id: string;
  projectId: string;
  sequence: number;
  status: VersionStatus;
  createdAt: string;
  frozenAt: string | null;
}

export interface Approval {
  id: string;
  projectId: string;
  versionId: string;
  stage: PptWorkflowStage;
  slideId?: string;
  status: ApprovalStatus;
  decidedAt: string | null;
}

export interface Task {
  id: string;
  projectId: string | null;
  status: 'queued' | 'running' | 'completed' | 'blocked' | 'cancelled';
  createdAt: string;
  updatedAt: string;
}

export interface Artifact {
  id: string;
  projectId: string;
  versionId: string;
  path: string;
  kind: string;
  createdAt: string;
}

export interface MemoryProposal {
  id: string;
  content: string;
  status: MemoryProposalStatus;
  createdAt: string;
  decidedAt: string | null;
}

export interface ApprovedMemory {
  proposalId: string;
  content: string;
  createdAt: string;
}
