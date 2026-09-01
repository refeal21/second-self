const STRICT_IDENTIFIER = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;

export function assertStrictIdentifier(
  kind: 'project' | 'request' | 'slide' | 'source' | 'version',
  value: string,
): string {
  if (!STRICT_IDENTIFIER.test(value)) {
    throw new Error(`Invalid ${kind} identifier: ${JSON.stringify(value)}`);
  }
  return value;
}
