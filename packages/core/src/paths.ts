import { isAbsolute, relative, resolve } from 'node:path';

export function defaultWorkspace(homeDirectory: string): string {
  return resolve(homeDirectory, 'Documents', 'DigitalTwinWorkspace');
}

export function resolveWorkspaceWritePath(workspaceRoot: string, candidatePath: string): string {
  const workspace = resolve(workspaceRoot);
  const candidate = isAbsolute(candidatePath)
    ? resolve(candidatePath)
    : resolve(workspace, candidatePath);
  const relation = relative(workspace, candidate);

  if (relation.startsWith('..') || isAbsolute(relation)) {
    throw new Error('Write path is outside the workspace');
  }

  return candidate;
}
