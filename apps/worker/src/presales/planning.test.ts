import { describe, expect, it } from 'vitest';
import { scenarioDetails } from './fixtures.test-support.js';
import { buildPresalesVisualContext } from './planning.js';

describe('presales renderer context', () => {
  it('rejects a binding to non-visible notes before constructing image data', () => {
    const { specs, designs } = scenarioDetails();
    designs[0]!.textBindings[0]!.path = '/speakerNotes';
    expect(() => buildPresalesVisualContext(specs[0]!, designs[0]!)).toThrow(/path/);
  });

  it('returns independent reference data without a duplicated copy of the visible text', () => {
    const { specs, designs } = scenarioDetails();
    const context = buildPresalesVisualContext(specs[0]!, designs[0]!);
    expect(context.approvedDesign.textBindings).toEqual([
      { id: 'title', path: '/title' }, { id: 'trigger', path: '/body/0' },
      { id: 'action', path: '/body/1' }, { id: 'response', path: '/body/2' },
      { id: 'outcome', path: '/body/3' },
    ]);
    designs[0]!.scene!.steps[0]!.actor = 'Changed actor';
    expect(context.approvedDesign.scene!.steps[0]!.actor).toBe('Operator');
    expect(JSON.stringify(context)).not.toContain('Alert received');
    expect(context.approvedDesign).not.toHaveProperty('speakerNotes');
  });
});
