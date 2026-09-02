import {
  constants,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  unlink,
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { assertStrictIdentifier } from './identifiers.js';

export const PROJECT_ARTIFACT_DIRECTORIES = [
  'exports',
  'outline',
  'qa',
  'slide-specs',
  'sources',
  'visuals',
] as const;

export type ProjectArtifactDirectory =
  (typeof PROJECT_ARTIFACT_DIRECTORIES)[number];

export interface WorkspaceArtifacts {
  initializeProject(projectId: string): Promise<void>;
  projectDirectory?(projectId: string): Promise<string>;
  write(
    projectId: string,
    relativePath: string,
    contents: string | Uint8Array,
  ): Promise<string>;
  read?(projectId: string, relativePath: string): Promise<Uint8Array>;
}

export interface WorkspaceArtifactAccess extends WorkspaceArtifacts {
  resolvePath(projectId: string, relativePath: string): Promise<string>;
  read(projectId: string, relativePath: string): Promise<Uint8Array>;
  ensureDirectory(projectId: string, relativePath: string): Promise<string>;
  list(
    projectId: string,
    relativeDirectory: string,
  ): Promise<readonly string[]>;
}

/**
 * Accept a create-only write that reached durable storage before its adapter
 * reported failure, but only when the stored bytes exactly match the request.
 */
export async function writeArtifactOrAdoptExact(
  artifacts: WorkspaceArtifacts,
  projectId: string,
  relativePath: string,
  contents: string | Uint8Array,
): Promise<string | undefined> {
  try {
    return await artifacts.write(projectId, relativePath, contents);
  } catch (error) {
    if (!artifacts.read) throw error;
    const persisted = await artifacts
      .read(projectId, relativePath)
      .catch(() => undefined);
    const expected =
      typeof contents === 'string'
        ? new TextEncoder().encode(contents)
        : contents;
    if (!persisted || !Buffer.from(persisted).equals(Buffer.from(expected))) {
      throw error;
    }
    const access = artifacts as WorkspaceArtifacts & {
      resolvePath?: (
        projectId: string,
        relativePath: string,
      ) => Promise<string>;
    };
    return access.resolvePath
      ? access.resolvePath(projectId, relativePath)
      : undefined;
  }
}

export class LocalWorkspaceArtifacts implements WorkspaceArtifactAccess {
  private readonly workspaceRoot: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = resolve(workspaceRoot);
  }

  async initializeProject(projectId: string): Promise<void> {
    assertStrictIdentifier('project', projectId);
    await this.initializeWorkspaceRoot();
    const projectRoot = this.projectRoot(projectId);
    await this.mkdirChecked(projectRoot);
    for (const directory of PROJECT_ARTIFACT_DIRECTORIES) {
      await this.mkdirChecked(join(projectRoot, directory));
    }
    const entries = (await readdir(projectRoot)).sort();
    if (
      entries.join('\0') !== [...PROJECT_ARTIFACT_DIRECTORIES].sort().join('\0')
    ) {
      throw new Error(
        'Project must contain exactly the six artifact directories',
      );
    }
  }

  async projectDirectory(projectId: string): Promise<string> {
    const projectRoot = this.projectRoot(projectId);
    await this.assertDirectoryWithoutSymlink(this.workspaceRoot);
    await this.assertDirectoryWithoutSymlink(projectRoot);
    return projectRoot;
  }

  async ensureDirectory(
    projectId: string,
    relativePath: string,
  ): Promise<string> {
    const path = await this.checkedArtifactPath(projectId, relativePath, true);
    await this.assertExistingComponentsWithoutSymlinks(
      this.projectRoot(projectId),
      path,
      true,
    );
    await this.assertDirectoryWithoutSymlink(path);
    return path;
  }

  async write(
    projectId: string,
    relativePath: string,
    contents: string | Uint8Array,
  ): Promise<string> {
    const path = await this.checkedArtifactPath(projectId, relativePath, true);
    const parent = dirname(path);
    await this.assertExistingComponentsWithoutSymlinks(
      this.projectRoot(projectId),
      parent,
      true,
    );
    const temporaryPath = join(parent, `.${randomUUID()}.tmp`);
    let temporaryCreated = false;
    let committed = false;
    try {
      const handle = await open(
        temporaryPath,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      temporaryCreated = true;
      try {
        await handle.writeFile(contents);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.assertExistingComponentsWithoutSymlinks(
        this.projectRoot(projectId),
        parent,
        false,
      );
      await link(temporaryPath, path);
      committed = true;
      await unlink(temporaryPath).catch(() => undefined);
      temporaryCreated = false;
    } catch (error) {
      if (temporaryCreated && !committed) {
        await unlink(temporaryPath).catch(() => undefined);
      }
      if (isNodeError(error) && error.code === 'EEXIST') {
        throw new Error(`Artifact already exists: ${relativePath}`);
      }
      throw error;
    }
    return path;
  }

  async read(projectId: string, relativePath: string): Promise<Uint8Array> {
    const path = await this.checkedArtifactPath(projectId, relativePath, false);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  }

  async resolvePath(projectId: string, relativePath: string): Promise<string> {
    return this.checkedArtifactPath(projectId, relativePath, false);
  }

  async list(
    projectId: string,
    relativeDirectory: string,
  ): Promise<readonly string[]> {
    const path = await this.checkedArtifactPath(
      projectId,
      relativeDirectory,
      false,
    );
    await this.assertDirectoryWithoutSymlink(path);
    return readdir(path);
  }

  private projectRoot(projectId: string): string {
    assertStrictIdentifier('project', projectId);
    return join(this.workspaceRoot, projectId);
  }

  private async checkedArtifactPath(
    projectId: string,
    candidatePath: string,
    createParents: boolean,
  ): Promise<string> {
    const projectRoot = this.projectRoot(projectId);
    const components = candidatePath.split('/');
    if (
      isAbsolute(candidatePath) ||
      candidatePath.includes('\\') ||
      components.some(
        (component) =>
          component === '' || component === '.' || component === '..',
      )
    ) {
      if (
        components.some((component) => component === '.' || component === '..')
      ) {
        throw new Error('Artifact path contains dot path components');
      }
      throw new Error('Artifact path is outside the project');
    }
    const directory = components[0];
    if (
      !PROJECT_ARTIFACT_DIRECTORIES.includes(
        directory as ProjectArtifactDirectory,
      )
    ) {
      throw new Error('Artifact path is outside the project');
    }
    await this.assertDirectoryWithoutSymlink(this.workspaceRoot);
    await this.assertDirectoryWithoutSymlink(projectRoot);
    const path = join(projectRoot, ...components);
    await this.assertExistingComponentsWithoutSymlinks(
      projectRoot,
      dirname(path),
      createParents,
    );
    const existing = await lstat(path).catch((error: unknown) => {
      if (isNodeError(error) && error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (existing?.isSymbolicLink()) {
      throw new Error(
        `Artifact path contains a symbolic link: ${candidatePath}`,
      );
    }
    return path;
  }

  private async assertExistingComponentsWithoutSymlinks(
    projectRoot: string,
    targetDirectory: string,
    createMissing: boolean,
  ): Promise<void> {
    const relation = targetDirectory.slice(projectRoot.length);
    const components = relation.split('/').filter(Boolean);
    let current = projectRoot;
    for (const component of components) {
      current = join(current, component);
      const status = await lstat(current).catch((error: unknown) => {
        if (isNodeError(error) && error.code === 'ENOENT') return undefined;
        throw error;
      });
      if (!status && createMissing) {
        await mkdir(current);
        await this.assertDirectoryWithoutSymlink(current);
        continue;
      }
      if (!status) {
        throw new Error(`Artifact directory does not exist: ${current}`);
      }
      if (status.isSymbolicLink()) {
        throw new Error(`Artifact path contains a symbolic link: ${current}`);
      }
      if (!status.isDirectory()) {
        throw new Error(
          `Artifact path component is not a directory: ${current}`,
        );
      }
    }
  }

  private async mkdirChecked(path: string): Promise<void> {
    await mkdir(path).catch((error: unknown) => {
      if (!isNodeError(error) || error.code !== 'EEXIST') throw error;
    });
    await this.assertDirectoryWithoutSymlink(path);
  }

  private async initializeWorkspaceRoot(): Promise<void> {
    const parsed = parse(this.workspaceRoot);
    const components = this.workspaceRoot
      .slice(parsed.root.length)
      .split('/')
      .filter(Boolean);
    let current = parsed.root;
    await this.assertDirectoryWithoutSymlink(current);
    let creating = false;
    for (const component of components) {
      current = join(current, component);
      const status = await lstat(current).catch((error: unknown) => {
        if (isNodeError(error) && error.code === 'ENOENT') return undefined;
        throw error;
      });
      if (status) {
        if (status.isSymbolicLink()) {
          throw new Error(
            `Workspace root path contains a symbolic link: ${current}`,
          );
        }
        if (!status.isDirectory()) {
          throw new Error(
            `Workspace root path component is not a directory: ${current}`,
          );
        }
        if (creating) {
          throw new Error(
            `Workspace root changed while it was being created: ${current}`,
          );
        }
        continue;
      }
      creating = true;
      await mkdir(current);
      await this.assertDirectoryWithoutSymlink(current);
    }
  }

  private async assertDirectoryWithoutSymlink(path: string): Promise<void> {
    const status = await lstat(path);
    if (status.isSymbolicLink()) {
      throw new Error(`Artifact path contains a symbolic link: ${path}`);
    }
    if (!status.isDirectory()) {
      throw new Error(`Artifact path component is not a directory: ${path}`);
    }
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
