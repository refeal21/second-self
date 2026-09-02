const STRICT_IDENTIFIER = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;

export function assertStrictIdentifier(
  kind: 'project' | 'request' | 'slide' | 'source' | 'version',
  value: unknown,
): string {
  if (typeof value !== 'string' || !STRICT_IDENTIFIER.test(value)) {
    throw new Error(`Invalid ${kind} identifier: ${JSON.stringify(value)}`);
  }
  return value;
}
