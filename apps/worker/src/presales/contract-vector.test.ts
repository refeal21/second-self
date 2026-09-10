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
});
