import { describe, expect, it } from 'vitest';
import { approveMemoryProposal } from './memory.js';

describe('memory proposal approval', () => {
  it('creates durable memory only when a proposed preference is approved', () => {
    const proposal = {
      id: 'proposal-1',
      content: 'Prefer restrained green for successful states.',
      status: 'proposed' as const,
      createdAt: '2026-09-01T00:00:00.000Z',
      decidedAt: null,
    };

    const approved = approveMemoryProposal(proposal, '2026-09-01T02:00:00.000Z');

    expect(approved.proposal).toMatchObject({ status: 'approved', decidedAt: '2026-09-01T02:00:00.000Z' });
    expect(approved.memory).toEqual({
      proposalId: 'proposal-1',
      content: 'Prefer restrained green for successful states.',
      createdAt: '2026-09-01T02:00:00.000Z',
    });
    expect(proposal.status).toBe('proposed');
  });
});
