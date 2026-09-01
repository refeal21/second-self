import { describe, expect, it } from 'vitest';
import { canTransition } from './workflow.js';

describe('PPT workflow transitions', () => {
  it('allows only the next fixed stage and rejects a skipped approval stage', () => {
    expect(canTransition('source_analysis', 'outline_review')).toBe(true);
    expect(canTransition('source_analysis', 'detail_review')).toBe(false);
  });
});
