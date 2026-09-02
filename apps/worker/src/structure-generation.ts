import type { Version } from '@digital-twin/core';
import {
  PptProjectService,
  type PptOutline,
  type SlideSpec,
  type SourceAnalysis,
  type SourceAnalysisEvidence,
} from './ppt-project.js';

export interface OutlineGenerationRequest {
  projectId: string;
  analysis: SourceAnalysis;
  analysisEvidence: SourceAnalysisEvidence;
}

export interface OutlineGenerationGateway {
  generate(request: OutlineGenerationRequest): Promise<PptOutline>;
}

export class OutlineGenerationService {
  readonly #projects: PptProjectService;
  readonly #gateway: OutlineGenerationGateway;

  constructor(projects: PptProjectService, gateway: OutlineGenerationGateway) {
    this.#projects = projects;
    this.#gateway = gateway;
  }

  async generate(projectId: string): Promise<Version> {
    const snapshot = this.#projects.getProjectSnapshot(projectId);
    if (
      snapshot.project.workflowStatus !== 'source_analysis' ||
      !snapshot.sourceAnalysis ||
      !snapshot.sourceAnalysisEvidence
    ) {
      throw new Error(
        'Outline generation requires completed validated source analysis',
      );
    }
    const outline = await this.#gateway.generate({
      projectId,
      analysis: snapshot.sourceAnalysis,
      analysisEvidence: snapshot.sourceAnalysisEvidence,
    });
    return this.#projects.submitOutline(projectId, outline);
  }
}

export interface SlideSpecGenerationRequest {
  projectId: string;
  outline: PptOutline;
  outlineVersion: Version;
  analysis: SourceAnalysis;
}

export interface SlideSpecGenerationGateway {
  generate(request: SlideSpecGenerationRequest): Promise<readonly SlideSpec[]>;
}

export class SlideSpecGenerationService {
  readonly #projects: PptProjectService;
  readonly #gateway: SlideSpecGenerationGateway;

  constructor(
    projects: PptProjectService,
    gateway: SlideSpecGenerationGateway,
  ) {
    this.#projects = projects;
    this.#gateway = gateway;
  }

  async generate(projectId: string): Promise<Version> {
    const snapshot = this.#projects.getProjectSnapshot(projectId);
    if (
      snapshot.project.workflowStatus !== 'detail_review' ||
      snapshot.outline?.version.status !== 'frozen' ||
      !snapshot.sourceAnalysis
    ) {
      throw new Error('Slide-spec generation requires a frozen outline');
    }
    const specs = await this.#gateway.generate({
      projectId,
      outline: snapshot.outline.value,
      outlineVersion: snapshot.outline.version,
      analysis: snapshot.sourceAnalysis,
    });
    return this.#projects.submitSlideSpecs(projectId, specs);
  }
}
