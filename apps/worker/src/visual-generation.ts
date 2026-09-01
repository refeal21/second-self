import type { Version } from '@digital-twin/core';
import {
  type ApprovedVisualAsset,
  PptProjectService,
  type SlideSpec,
} from './ppt-project.js';
import { STORE_GENERATED_VISUAL } from './visual-evidence.js';

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
  constructor(
    private readonly projects: PptProjectService,
    private readonly gateway: VisualGenerationGateway,
  ) {}

  async generate(
    projectId: string,
    slideId: string,
  ): Promise<VisualGenerationServiceResult> {
    let release: (() => void) | undefined;
    try {
      release = this.projects.acquireProjectOperation(
        projectId,
        'slide visual generation',
      );
      const { spec, version } = this.projects.getApprovedSlideSpec(
        projectId,
        slideId,
      );
      const projectCwd = await this.projects.projectDirectory(projectId);
      const result = await this.gateway.generate({
        projectId,
        projectCwd,
        slideId,
        specVersionId: version.id,
        spec,
        imageGenerationBrief: spec.imageGenerationBrief,
      });
      if (result.status === 'blocked') {
        this.projects.blockVisualGeneration(projectId, slideId, result.message);
        return result;
      }
      const visual = await this.projects[STORE_GENERATED_VISUAL]({
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
    const capability = await this.gateway.capability();
    if (
      capability.id !== 'image_gen.imagegen' ||
      capability.status !== 'available'
    ) {
      throw new Error('The ImageGen capability is still unavailable');
    }
    this.projects.resumeVisualReview(projectId);
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
      prompt: buildPagePrompt(request),
    });
  }
}

function buildPagePrompt(request: VisualGenerationRequest): string {
  return [
    `Generate the visual for page ${request.slideId} only.`,
    `Image-generation brief: ${request.imageGenerationBrief}`,
    'The approved structured slide spec below is the only authority for text, data, and citations.',
    'OCR, inferred text, or text visible in an approved image must never overwrite the structured slide spec.',
    'Return one PNG and classify it as a full-slide reference, explicitly text-free background, or complex visual asset.',
    JSON.stringify(request.spec, null, 2),
  ].join('\n\n');
}
