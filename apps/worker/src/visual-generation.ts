import type { Version } from '@digital-twin/core';
import { PNG } from 'pngjs';
import {
  type ApprovedVisualAsset,
  type ProjectMutationPort,
  type PptProjectService,
  type SlideSpec,
} from './ppt-project.js';
import { buildPageVisualPrompt } from './visual-prompt.js';

export type VisualAssetUsage =
  | 'full_slide_reference'
  | 'text_free_background'
  | 'complex_visual';

export interface GeneratedVisualAsset {
  status: 'generated';
  image: Uint8Array;
  mediaType: 'image/png';
  usage: VisualAssetUsage;
  textFree: boolean;
  altText: string;
}

export interface VisualGenerationBlocked {
  status: 'blocked';
  reason: 'capability_unavailable';
  capability: 'image_gen.imagegen';
  message: string;
}

export type GeneratedSlideVisual =
  | GeneratedVisualAsset
  | VisualGenerationBlocked;

export interface VisualGenerationRequest {
  projectId: string;
  projectCwd: string;
  slideId: string;
  specVersionId: string;
  spec: SlideSpec;
  imageGenerationBrief: string;
}

export interface VisualGenerationGateway {
  capability(): Promise<VisualGenerationCapability>;
  generate(request: VisualGenerationRequest): Promise<GeneratedSlideVisual>;
}

export interface VisualGenerationCapability {
  id: string;
  status: 'available' | 'unavailable' | 'disabled';
}

export type VisualGenerationServiceResult =
  | VisualGenerationBlocked
  | {
      status: 'generated';
      version: Version;
      asset: ApprovedVisualAsset;
    };

export class VisualGenerationService {
  readonly #projects: PptProjectService;
  readonly #gateway: VisualGenerationGateway;
  readonly #mutations: ProjectMutationPort;

  constructor(
    projects: PptProjectService,
    gateway: VisualGenerationGateway,
    mutations: ProjectMutationPort,
  ) {
    this.#projects = projects;
    this.#gateway = gateway;
    this.#mutations = mutations;
  }

  async generate(
    projectId: string,
    slideId: string,
  ): Promise<VisualGenerationServiceResult> {
    let release: (() => void) | undefined;
    try {
      release = this.#mutations.acquireOperation(
        projectId,
        'slide visual generation',
      );
      const { spec, version } = this.#projects.getApprovedSlideSpec(
        projectId,
        slideId,
      );
      const projectCwd = await this.#projects.projectDirectory(projectId);
      const result = await this.#gateway.generate({
        projectId,
        projectCwd,
        slideId,
        specVersionId: version.id,
        spec,
        imageGenerationBrief: spec.imageGenerationBrief,
      });
      assertVisualGenerationResult(result);
      if (result.status === 'blocked') {
        this.#mutations.blockVisualGeneration(
          projectId,
          slideId,
          result.message,
        );
        return result;
      }
      const visual = await this.#mutations.storeGeneratedVisual({
        projectId,
        slideId,
        generated: result,
      });
      if (!visual.asset)
        throw new Error('Generated visual did not produce an asset');
      return {
        status: 'generated',
        version: { ...visual.version },
        asset: { ...visual.asset },
      };
    } finally {
      release?.();
    }
  }

  async resume(projectId: string): Promise<void> {
    const capability = await this.#gateway.capability();
    if (
      capability.id !== 'image_gen.imagegen' ||
      capability.status !== 'available'
    ) {
      throw new Error('The ImageGen capability is still unavailable');
    }
    this.#mutations.resumeVisualReview(projectId);
  }
}

function assertVisualGenerationResult(
  result: unknown,
): asserts result is GeneratedSlideVisual {
  if (!result || typeof result !== 'object') {
    throw new Error(
      'visual generation result does not match the runtime schema',
    );
  }
  const candidate = result as Record<string, unknown>;
  if (candidate.status === 'blocked') {
    if (
      candidate.reason !== 'capability_unavailable' ||
      candidate.capability !== 'image_gen.imagegen' ||
      typeof candidate.message !== 'string'
    ) {
      throw new Error(
        'visual generation result does not match the runtime schema',
      );
    }
    return;
  }
  if (
    candidate.status !== 'generated' ||
    !(candidate.image instanceof Uint8Array) ||
    candidate.mediaType !== 'image/png' ||
    ![
      'full_slide_reference',
      'text_free_background',
      'complex_visual',
    ].includes(candidate.usage as VisualAssetUsage) ||
    typeof candidate.textFree !== 'boolean' ||
    typeof candidate.altText !== 'string'
  ) {
    throw new Error(
      'visual generation result does not match the runtime schema',
    );
  }
  try {
    PNG.sync.read(Buffer.from(candidate.image));
  } catch {
    throw new Error('visual generation result must contain a decodable PNG');
  }
}

export interface CodexImageGenTurnRequest {
  kind: 'imagegen';
  cwd: string;
  projectId: string;
  slideId: string;
  specVersionId: string;
  prompt: string;
}

export interface CodexImageGenTurnRunner {
  listCapabilities(): Promise<readonly VisualGenerationCapability[]>;
  runImageGenTurn(
    request: CodexImageGenTurnRequest,
  ): Promise<GeneratedSlideVisual>;
}

export class CodexVisualGenerationGateway implements VisualGenerationGateway {
  constructor(private readonly turnRunner: CodexImageGenTurnRunner) {}

  async capability(): Promise<VisualGenerationCapability> {
    const capabilities = await this.turnRunner.listCapabilities();
    return (
      capabilities.find(({ id }) => id === 'image_gen.imagegen') ?? {
        id: 'image_gen.imagegen',
        status: 'unavailable',
      }
    );
  }

  async generate(
    request: VisualGenerationRequest,
  ): Promise<GeneratedSlideVisual> {
    const capability = await this.capability();
    if (capability.status !== 'available') {
      return {
        status: 'blocked',
        reason: 'capability_unavailable',
        capability: 'image_gen.imagegen',
        message: 'The Codex ImageGen skill/tool is unavailable.',
      };
    }

    return this.turnRunner.runImageGenTurn({
      kind: 'imagegen',
      cwd: request.projectCwd,
      projectId: request.projectId,
      slideId: request.slideId,
      specVersionId: request.specVersionId,
      prompt: buildPageVisualPrompt(request),
    });
  }
}
