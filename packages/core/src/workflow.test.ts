import { describe, expect, it } from 'vitest';
import { canTransition } from './workflow.js';

describe('PPT workflow transitions', () => {
  it('allows only the next fixed stage and rejects a skipped approval stage', () => {
    expect(canTransition('source_analysis', 'outline_review')).toBe(true);
    expect(canTransition('source_analysis', 'detail_review')).toBe(false);
  });

  it('requires approval before leaving outline review', () => {
    expect(canTransition('outline_review', 'detail_review', { approvals: [] })).toBe(false);
    expect(canTransition('outline_review', 'detail_review', {
      approvals: [{ stage: 'outline_review', status: 'approved' }],
    })).toBe(true);
  });

  it('requires approval before leaving detail review', () => {
    expect(canTransition('detail_review', 'visual_review', { approvals: [] })).toBe(false);
    expect(canTransition('detail_review', 'visual_review', {
      approvals: [{ stage: 'detail_review', status: 'approved' }],
    })).toBe(true);
  });

  it('requires every visual slide to be approved before conversion', () => {
    const context = {
      approvals: [
        { stage: 'visual_review' as const, status: 'approved' as const, slideId: 'slide-1' },
      ],
      visualSlideIds: ['slide-1', 'slide-2'],
    };

    expect(canTransition('visual_review', 'conversion', context)).toBe(false);
    expect(canTransition('visual_review', 'conversion', {
      ...context,
      approvals: [
        ...context.approvals,
        { stage: 'visual_review', status: 'approved', slideId: 'slide-2' },
      ],
    })).toBe(true);
  });
});
