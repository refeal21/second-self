import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const unlink = vi.hoisted(() => vi.fn());

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  unlink.mockImplementation(async (path: string | Buffer | URL) => {
    if (String(path).endsWith('.tmp')) {
      const error = Object.assign(
        new Error('simulated temporary cleanup failure'),
        {
          code: 'EIO',
        },
      );
      throw error;
    }
    return actual.unlink(path);
  });
  return { ...actual, unlink };
});

import { LocalWorkspaceArtifacts } from './workspace-artifacts.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  unlink.mockClear();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('local artifact post-commit cleanup', () => {
  it('acknowledges a final hard-link commit when temporary cleanup later fails', async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), 'artifact-post-commit-')),
    );
    temporaryDirectories.push(root);
    const artifacts = new LocalWorkspaceArtifacts(root);
    await artifacts.initializeProject('project-1');

    await expect(
      artifacts.write('project-1', 'sources/analysis.json', 'committed'),
    ).resolves.toBe(join(root, 'project-1/sources/analysis.json'));
    expect(
      await readFile(join(root, 'project-1/sources/analysis.json'), 'utf8'),
    ).toBe('committed');
    expect(unlink).toHaveBeenCalled();
  });
});
