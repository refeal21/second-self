import { describe, expect, it } from 'vitest';
import { freezeVersion } from './version.js';

describe('version freezing', () => {
  it('returns an immutable approved snapshot without changing the draft', () => {
    const draft = {
      id: 'version-1',
      projectId: 'project-1',
      sequence: 1,
      status: 'draft' as const,
      createdAt: '2026-09-01T00:00:00.000Z',
      frozenAt: null,
    };

    const frozen = freezeVersion(draft, '2026-09-01T01:00:00.000Z');

    expect(frozen).toMatchObject({ status: 'frozen', frozenAt: '2026-09-01T01:00:00.000Z' });
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(draft).toMatchObject({ status: 'draft', frozenAt: null });
  });
});
