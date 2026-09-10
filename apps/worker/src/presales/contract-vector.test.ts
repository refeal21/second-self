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
