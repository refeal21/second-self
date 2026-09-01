import type { ApprovedMemory, MemoryProposal } from './types.js';

export interface ApprovedMemoryProposal {
  proposal: Readonly<MemoryProposal>;
  memory: ApprovedMemory;
}

export function approveMemoryProposal(
  proposal: MemoryProposal,
  approvedAt: string,
): ApprovedMemoryProposal {
  if (proposal.status !== 'proposed') {
    throw new Error('Only proposed memory can be approved');
  }

  return {
    proposal: Object.freeze({ ...proposal, status: 'approved', decidedAt: approvedAt }),
    memory: { proposalId: proposal.id, content: proposal.content, createdAt: approvedAt },
  };
}
