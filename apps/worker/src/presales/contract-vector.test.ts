import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseDetailsEnvelope, parseOutlineEnvelope, resolveVisibleBindings } from './validation.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const vector = JSON.parse(
  readFileSync(
    resolve(REPO_ROOT, 'fixtures/presales/native-contract.json'),
    'utf8',
  ),
) as { analysis: unknown; pair: { schemaVersion: unknown; outline: unknown; details: unknown } };

describe('shared presales native contract vector', () => {
  it('validates the genuine five-page Chinese narrative, complete bindings and linked modules', () => {
    const five = JSON.parse(readFileSync(resolve(REPO_ROOT, 'fixtures/presales/five-page-acceptance.json'), 'utf8')) as typeof vector;
    const outline = parseOutlineEnvelope(five.pair.outline, five.analysis as never);
    const details = parseDetailsEnvelope(five.pair.details, outline, five.analysis as never);
    expect(outline.plan.pages.map(page => page.pageType)).toEqual(['goals', 'architecture', 'module', 'module', 'scenario']);
    expect(outline.plan.pages[1]?.moduleIds).toEqual(['sensing', 'response']);
    expect(details.designs[4]?.scene?.steps.map(step => step.moduleId)).toEqual(['sensing', 'response']);
    expect(new Set(details.specs.map(spec => spec.imageGenerationBrief)).size).toBe(5);
    details.specs.forEach((spec, index) => {
      const design = details.designs[index]!;
      expect(resolveVisibleBindings(spec, design)).toHaveLength(index === 4 ? 7 : 4);
      expect(JSON.stringify(spec)).not.toContain(design.speakerNotes);
    });
    const broken = structuredClone(five.pair.details) as { designs: { textBindings: unknown[] }[] };
    broken.designs[1]!.textBindings.pop();
    expect(() => parseDetailsEnvelope(broken, outline, five.analysis as never)).toThrow();
  });

  it('passes the TypeScript outline and rich-details validators', () => {
    expect(vector.pair.schemaVersion).toBe(1);
    const outline = parseOutlineEnvelope(vector.pair.outline, vector.analysis as never);
    const details = parseDetailsEnvelope(vector.pair.details, outline, vector.analysis as never);

    expect(details.specs[0]?.tables).toHaveLength(1);
    expect(details.specs[0]?.charts).toHaveLength(1);
    expect(details.specs[0]?.shapes).toHaveLength(1);
    expect(details.designs[0]?.scene?.steps).toHaveLength(2);
    expect(resolveVisibleBindings(details.specs[0]!, details.designs[0]!)).toHaveLength(15);
  });

  it.each(['1.0', '1e0'])(
    'accepts equivalent numeric schema spelling %s',
    (spelling) => {
      const draft = structuredClone(vector.pair);
      const numericVersion = JSON.parse(spelling) as unknown;
      const outline = draft.outline as {
        schemaVersion: unknown;
        plan: { schemaVersion: unknown };
      };
      const details = draft.details as { schemaVersion: unknown };
      outline.schemaVersion = numericVersion;
      outline.plan.schemaVersion = numericVersion;
      details.schemaVersion = numericVersion;

      const parsedOutline = parseOutlineEnvelope(draft.outline, vector.analysis as never);
      expect(
        parseDetailsEnvelope(draft.details, parsedOutline, vector.analysis as never),
      ).toEqual(draft.details);
    },
  );
});
