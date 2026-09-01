import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
} from 'node:fs/promises';
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

    await expect(artifacts.initializeProject('../outside')).rejects.toThrow();
    await expect(
      artifacts.write('project-1', '../outside.txt', 'nope'),
    ).rejects.toThrow('dot path components');
  });

  it.each(['', '.', '..', 'UPPER', 'bad/project'])(
    'rejects unsafe project identifier %j',
    async (projectId) => {
      const root = await mkdtemp(join(tmpdir(), 'digital-twin-artifacts-'));
      temporaryDirectories.push(root);
      const artifacts = new LocalWorkspaceArtifacts(root);

      await expect(artifacts.initializeProject(projectId)).rejects.toThrow(
        'Invalid project identifier',
      );
    },
  );

  it('rejects dot path components and cannot cross from slide specs into outline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'digital-twin-artifacts-'));
    temporaryDirectories.push(root);
    const artifacts = new LocalWorkspaceArtifacts(root);
    await artifacts.initializeProject('project-1');
    await artifacts.write(
      'project-1',
      'outline/outline-v1.json',
      'frozen-outline',
    );

    await expect(
      artifacts.write(
        'project-1',
        'slide-specs/../outline/outline-v1.json',
        'forged-spec',
      ),
    ).rejects.toThrow('dot path components');
    expect(
      await readFile(join(root, 'project-1/outline/outline-v1.json'), 'utf8'),
    ).toBe('frozen-outline');
  });

  it('uses create-only writes so a frozen artifact cannot be overwritten', async () => {
    const root = await mkdtemp(join(tmpdir(), 'digital-twin-artifacts-'));
    temporaryDirectories.push(root);
    const artifacts = new LocalWorkspaceArtifacts(root);
    await artifacts.initializeProject('project-1');
    await artifacts.write('project-1', 'outline/outline-v1.json', 'frozen');

    await expect(
      artifacts.write('project-1', 'outline/outline-v1.json', 'changed'),
    ).rejects.toThrow('already exists');
    expect(
      await readFile(join(root, 'project-1/outline/outline-v1.json'), 'utf8'),
    ).toBe('frozen');
  });

  it('rejects a symlink replacing one of the six fixed directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'digital-twin-artifacts-'));
    const outside = await mkdtemp(join(tmpdir(), 'digital-twin-outside-'));
    temporaryDirectories.push(root, outside);
    const artifacts = new LocalWorkspaceArtifacts(root);
    await artifacts.initializeProject('project-1');
    await rm(join(root, 'project-1/outline'), { recursive: true });
    await symlink(outside, join(root, 'project-1/outline'));

    await expect(
      artifacts.write('project-1', 'outline/escaped.json', 'nope'),
    ).rejects.toThrow('symbolic link');
    expect(await readdir(outside)).toEqual([]);
  });

  it('rejects a symlink in any existing nested directory component', async () => {
    const root = await mkdtemp(join(tmpdir(), 'digital-twin-artifacts-'));
    const outside = await mkdtemp(join(tmpdir(), 'digital-twin-outside-'));
    temporaryDirectories.push(root, outside);
    const artifacts = new LocalWorkspaceArtifacts(root);
    await artifacts.initializeProject('project-1');
    await mkdir(join(root, 'project-1/qa/run-1'));
    await symlink(outside, join(root, 'project-1/qa/run-1/profile'));

    await expect(
      artifacts.write('project-1', 'qa/run-1/profile/escaped.json', 'nope'),
    ).rejects.toThrow('symbolic link');
    expect(await readdir(outside)).toEqual([]);
  });
});
