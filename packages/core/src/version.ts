import type { Version } from './types.js';

export function freezeVersion(
  version: Version,
  frozenAt: string,
): Readonly<Version> {
  if (version.status !== 'draft') {
    throw new Error('Only draft versions can be frozen');
  }

  return Object.freeze({ ...version, status: 'frozen', frozenAt });
}
