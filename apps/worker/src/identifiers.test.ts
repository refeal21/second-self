import { describe, expect, it } from 'vitest';
import { assertStrictIdentifier } from './identifiers.js';

describe('strict workflow identifiers', () => {
  it.each([
    '',
    '.',
    '..',
    'bad/id',
    'bad\\id',
    '-leading',
    'UPPER',
    '含中文',
    'space id',
  ])('rejects unsafe identifier %j', (value) => {
    expect(() => assertStrictIdentifier('slide', value)).toThrow(
      'Invalid slide identifier',
    );
  });

  it('accepts a conservative lowercase identifier', () => {
    expect(assertStrictIdentifier('slide', 'slide_1-a')).toBe('slide_1-a');
  });
});
