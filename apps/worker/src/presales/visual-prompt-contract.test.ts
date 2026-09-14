import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildPageVisualPrompt } from '../visual-prompt.js';
import { PRESALES_SKILL } from './skill.generated.js';

describe('shared native/renderer visual prompt', () => {
  it('preserves exact visible values while excluding notes and provenance in the shared golden payload', () => {
    const golden = JSON.parse(readFileSync(new URL('../../../../fixtures/presales/visual-prompt-golden.json', import.meta.url), 'utf8'));
    const prompt = buildPageVisualPrompt({ slideId: golden.spec.id, spec: golden.spec, designPlan: golden.design, style: golden.style }, golden.feedback);
    const payload = JSON.parse(prompt.slice(prompt.lastIndexOf('\n\n{') + 2));
    expect(payload).toEqual({ ...golden.expectedPayload, presalesSkill: { id: PRESALES_SKILL.id, version: PRESALES_SKILL.version, sha256: PRESALES_SKILL.sha256 } });
    for (const fragment of golden.instructionFragments) expect(prompt).toContain(fragment);
    expect(prompt).not.toContain('SECRET');
    const nativeBundle = JSON.parse(readFileSync(new URL('./skill.bundle.generated.json', import.meta.url), 'utf8'));
    expect(nativeBundle).toEqual(PRESALES_SKILL);
  });
});
