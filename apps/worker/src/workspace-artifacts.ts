import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, sep } from 'node:path';
import { resolveWorkspaceWritePath } from '@digital-twin/core';

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
  write(
    projectId: string,
    relativePath: string,
    contents: string | Uint8Array,
  ): Promise<string>;
  read?(projectId: string, relativePath: string): Promise<Uint8Array>;
}

export interface WorkspaceArtifactAccess extends WorkspaceArtifacts {
  resolvePath(projectId: string, relativePath: string): string;
  read(projectId: string, relativePath: string): Promise<Uint8Array>;
  list(
    projectId: string,
    relativeDirectory: string,
  ): Promise<readonly string[]>;
}

export class LocalWorkspaceArtifacts implements WorkspaceArtifactAccess {
  constructor(private readonly workspaceRoot: string) {}

  async initializeProject(projectId: string): Promise<void> {
    const projectRoot = this.projectRoot(projectId);
    await Promise.all(
      PROJECT_ARTIFACT_DIRECTORIES.map((directory) =>
        mkdir(resolveWorkspaceWritePath(projectRoot, directory), {
          recursive: true,
        }),
      ),
    );
  }

  async write(
    projectId: string,
    relativePath: string,
    contents: string | Uint8Array,
  ): Promise<string> {
    const path = this.artifactPath(projectId, relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents);
    return path;
  }

  async read(projectId: string, relativePath: string): Promise<Uint8Array> {
    return readFile(this.artifactPath(projectId, relativePath));
  }

  resolvePath(projectId: string, relativePath: string): string {
    return this.artifactPath(projectId, relativePath);
  }

  async list(
    projectId: string,
    relativeDirectory: string,
  ): Promise<readonly string[]> {
    return readdir(this.artifactPath(projectId, `${relativeDirectory}/.`));
  }

  private projectRoot(projectId: string): string {
    if (
      projectId.length === 0 ||
      projectId.includes('/') ||
      projectId.includes('\\')
    ) {
      throw new Error('Project path is outside the workspace');
    }
    return resolveWorkspaceWritePath(this.workspaceRoot, projectId);
  }

  private artifactPath(projectId: string, candidatePath: string): string {
    const projectRoot = this.projectRoot(projectId);
    let path: string;
    try {
      path = resolveWorkspaceWritePath(projectRoot, candidatePath);
    } catch {
      throw new Error('Artifact path is outside the project');
    }
    const relation = relative(projectRoot, path);
    const directory = relation.split(sep)[0];
    if (
      isAbsolute(candidatePath) ||
      !PROJECT_ARTIFACT_DIRECTORIES.includes(
        directory as ProjectArtifactDirectory,
      )
    ) {
      throw new Error('Artifact path is outside the project');
    }
    return path;
  }
}
