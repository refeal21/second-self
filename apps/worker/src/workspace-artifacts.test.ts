import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LocalWorkspaceArtifacts,
  PROJECT_ARTIFACT_DIRECTORIES,
} from './workspace-artifacts.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('local workspace artifact boundary', () => {
  it('creates exactly the six project artifact folders and writes inside them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'digital-twin-artifacts-'));
    temporaryDirectories.push(root);
    const artifacts = new LocalWorkspaceArtifacts(root);

    await artifacts.initializeProject('project-1');
    await artifacts.write(
      'project-1',
      'outline/outline-v1.json',
      '{"title":"Plan"}',
    );

    expect(await readdir(join(root, 'project-1'))).toEqual(
      [...PROJECT_ARTIFACT_DIRECTORIES].sort(),
    );
    expect(
      await readFile(join(root, 'project-1/outline/outline-v1.json'), 'utf8'),
    ).toBe('{"title":"Plan"}');
  });

  it('rejects project ids and artifact paths that escape the workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'digital-twin-artifacts-'));
    temporaryDirectories.push(root);
    const artifacts = new LocalWorkspaceArtifacts(root);

    await expect(artifacts.initializeProject('../outside')).rejects.toThrow(
      'outside the workspace',
    );
    await expect(
      artifacts.write('project-1', '../outside.txt', 'nope'),
    ).rejects.toThrow('outside the project');
  });
});
