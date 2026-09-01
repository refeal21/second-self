import type { Version } from '@digital-twin/core';
import {
  type ApprovedVisualAsset,
  PptProjectService,
  type SlideSpec,
} from './ppt-project.js';

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
  capability: 'imagegen';
  message: string;
}

export type GeneratedSlideVisual =
  | GeneratedVisualAsset
  | VisualGenerationBlocked;

export interface VisualGenerationRequest {
  projectId: string;
  slideId: string;
  specVersionId: string;
  spec: SlideSpec;
  imageGenerationBrief: string;
}

export interface VisualGenerationGateway {
  generate(request: VisualGenerationRequest): Promise<GeneratedSlideVisual>;
}

export type VisualGenerationServiceResult =
  | VisualGenerationBlocked
  | {
      status: 'generated';
      version: Version;
      asset: ApprovedVisualAsset;
    };

export class VisualGenerationService {
  private readonly activeProjects = new Set<string>();

  constructor(
    private readonly projects: PptProjectService,
    private readonly gateway: VisualGenerationGateway,
  ) {}

  async generate(
    projectId: string,
    slideId: string,
  ): Promise<VisualGenerationServiceResult> {
    if (this.activeProjects.has(projectId)) {
      throw new Error(
        'A slide visual is already being generated for this project',
      );
    }
    this.activeProjects.add(projectId);
    try {
      const { spec, version } = this.projects.getApprovedSlideSpec(
        projectId,
        slideId,
      );
      const result = await this.gateway.generate({
        projectId,
        slideId,
        specVersionId: version.id,
        spec,
        imageGenerationBrief: spec.imageGenerationBrief,
      });
      if (result.status === 'blocked') return result;
      const visual = await this.projects.recordGeneratedSlideVisual(
        projectId,
        slideId,
        result,
      );
      if (!visual.asset)
        throw new Error('Generated visual did not produce an asset');
      return {
        status: 'generated',
        version: { ...visual.version },
        asset: { ...visual.asset },
      };
    } finally {
      this.activeProjects.delete(projectId);
    }
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
  listCapabilities(): Promise<readonly string[]>;
  runImageGenTurn(
    request: CodexImageGenTurnRequest,
  ): Promise<GeneratedSlideVisual>;
}

export class CodexVisualGenerationGateway implements VisualGenerationGateway {
  constructor(
    private readonly turnRunner: CodexImageGenTurnRunner,
    private readonly projectCwd: string,
  ) {}

  async generate(
    request: VisualGenerationRequest,
  ): Promise<GeneratedSlideVisual> {
    const capabilities = await this.turnRunner.listCapabilities();
    if (
      !capabilities.some((capability) =>
        capability
          .toLowerCase()
          .replaceAll(/[^a-z]/g, '')
          .includes('imagegen'),
      )
    ) {
      return {
        status: 'blocked',
        reason: 'capability_unavailable',
        capability: 'imagegen',
        message: 'The Codex ImageGen skill/tool is unavailable.',
      };
    }

    return this.turnRunner.runImageGenTurn({
      kind: 'imagegen',
      cwd: this.projectCwd,
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
