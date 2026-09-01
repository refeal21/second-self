import {
  canTransition,
  freezeVersion,
  type Approval,
  type PptWorkflowStage,
  type Project,
  type Version,
  type WorkflowTransitionContext,
} from '@digital-twin/core';
import { basename } from 'node:path';
import type { WorkspaceArtifacts } from './workspace-artifacts.js';
import type {
  GeneratedVisualAsset,
  GeneratedSlideVisual,
  VisualAssetUsage,
} from './visual-generation.js';

export interface SourceAttachment {
  id: string;
  fileName: string;
  mediaType: string;
  contents: Uint8Array;
}

export interface AttachedSource {
  id: string;
  fileName: string;
  mediaType: string;
  artifactPath: string;
}

export interface SourceFinding {
  id: string;
  text: string;
  sourceIds: readonly string[];
}

export interface SourceDataPoint {
  id: string;
  label: string;
  value: number | string;
  unit?: string;
  sourceIds?: readonly string[];
}

export interface SourceCitation {
  sourceId: string;
  title: string;
  locator: string;
  url?: string;
}

export interface SourceAnalysis {
  findings: readonly SourceFinding[];
  dataPoints: readonly SourceDataPoint[];
  sourceMap: readonly SourceCitation[];
}

export interface PptOutline {
  title: string;
  slides: readonly { id: string; title: string; purpose: string }[];
}

export interface SlideTable {
  id: string;
  headers: readonly string[];
  rows: readonly (readonly string[])[];
}

export interface SlideChart {
  id: string;
  type: 'bar' | 'line' | 'pie';
  categories: readonly string[];
  series: readonly { name: string; values: readonly number[] }[];
}

export interface SlideShape {
  id: string;
  type: 'rect' | 'ellipse' | 'line';
  x: number;
  y: number;
  w: number;
  h: number;
  fill?: string;
  line?: string;
  text?: string;
}

export interface SlideSpec {
  id: string;
  title: string;
  body: readonly string[];
  tables: readonly SlideTable[];
  charts: readonly SlideChart[];
  shapes: readonly SlideShape[];
  sourceMap: readonly SourceCitation[];
  imageGenerationBrief: string;
}

interface Versioned<T> {
  version: Version;
  value: T;
}

export interface ApprovedVisualAsset {
  artifactPath: string;
  mediaType: 'image/png';
  usage: VisualAssetUsage;
  textFree: boolean;
  altText: string;
}

export interface SlideVisualVersion {
  slideId: string;
  version: Version;
  asset: ApprovedVisualAsset | null;
}

interface ProjectState {
  project: Project;
  sources: AttachedSource[];
  sourceAnalysis: SourceAnalysis | null;
  outline: Versioned<PptOutline> | null;
  slideSpecs: Versioned<readonly SlideSpec[]> | null;
  visuals: Record<string, SlideVisualVersion[]>;
  exportPath: string | null;
  qaStatus: 'passed' | 'failed' | null;
  approvals: Approval[];
}

export interface PptProjectSnapshot {
  project: Project;
  sources: readonly AttachedSource[];
  sourceAnalysis: SourceAnalysis | null;
  outline: Versioned<PptOutline> | null;
  slideSpecs: Versioned<readonly SlideSpec[]> | null;
  visuals: Readonly<Record<string, readonly SlideVisualVersion[]>>;
  exportPath: string | null;
  qaStatus: 'passed' | 'failed' | null;
  approvals: readonly Approval[];
}

export class PptProjectService {
  private readonly projects = new Map<string, ProjectState>();

  constructor(private readonly artifacts: WorkspaceArtifacts) {}

  async createProject(input: {
    id: string;
    name: string;
    createdAt: string;
  }): Promise<Project> {
    if (this.projects.has(input.id))
      throw new Error(`Project already exists: ${input.id}`);
    await this.artifacts.initializeProject(input.id);
    const project: Project = {
      id: input.id,
      name: input.name,
      workflowStatus: 'intake',
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    };
    this.projects.set(project.id, {
      project,
      sources: [],
      sourceAnalysis: null,
      outline: null,
      slideSpecs: null,
      visuals: {},
      exportPath: null,
      qaStatus: null,
      approvals: [],
    });
    return { ...project };
  }

  async attachSource(
    projectId: string,
    input: SourceAttachment,
  ): Promise<AttachedSource> {
    const state = this.requireStage(projectId, 'intake');
    if (basename(input.fileName) !== input.fileName)
      throw new Error('Source file name must not contain a path');
    const relativePath = `sources/${input.id}-${input.fileName}`;
    const artifactPath = await this.artifacts.write(
      projectId,
      relativePath,
      input.contents,
    );
    const source = {
      id: input.id,
      fileName: input.fileName,
      mediaType: input.mediaType,
      artifactPath,
    };
    state.sources.push(source);
    return { ...source };
  }

  beginSourceAnalysis(projectId: string): void {
    const state = this.requireStage(projectId, 'intake');
    this.transition(state, 'source_analysis');
  }

  async recordSourceAnalysis(
    projectId: string,
    analysis: SourceAnalysis,
  ): Promise<void> {
    const state = this.requireStage(projectId, 'source_analysis');
    state.sourceAnalysis = structuredClone(analysis);
    await this.artifacts.write(
      projectId,
      'sources/analysis.json',
      JSON.stringify(analysis, null, 2),
    );
  }

  async submitOutline(
    projectId: string,
    outline: PptOutline,
  ): Promise<Version> {
    const state = this.requireStage(projectId, 'source_analysis');
    if (!state.sourceAnalysis)
      throw new Error('Source analysis must be recorded before outline review');
    if (outline.slides.length === 0)
      throw new Error('Outline must contain at least one slide');
    const version = this.newVersion(projectId, 'outline', 1);
    state.outline = { version, value: structuredClone(outline) };
    await this.artifacts.write(
      projectId,
      'outline/outline-v1.json',
      JSON.stringify(outline, null, 2),
    );
    this.transition(state, 'outline_review');
    return { ...version };
  }

  approveOutline(projectId: string, decidedAt: string): Readonly<Version> {
    const state = this.requireStage(projectId, 'outline_review');
    if (!state.outline) throw new Error('No outline is awaiting approval');
    const frozen = freezeVersion(state.outline.version, decidedAt);
    state.outline.version = frozen;
    state.approvals.push(
      this.approval(projectId, frozen.id, 'outline_review', decidedAt),
    );
    this.transition(state, 'detail_review');
    return frozen;
  }

  async submitSlideSpecs(
    projectId: string,
    specs: readonly SlideSpec[],
  ): Promise<Version> {
    const state = this.requireStage(projectId, 'detail_review');
    if (!state.outline || state.outline.version.status !== 'frozen') {
      throw new Error('Approved outline is required before slide details');
    }
    const expectedSlideIds = state.outline.value.slides.map(({ id }) => id);
    if (
      specs.length !== expectedSlideIds.length ||
      !expectedSlideIds.every((slideId) =>
        specs.some((spec) => spec.id === slideId),
      )
    ) {
      throw new Error('Slide specs must cover every approved outline page');
    }
    const version = this.newVersion(projectId, 'slide-specs', 1);
    state.slideSpecs = { version, value: structuredClone(specs) };
    await Promise.all(
      specs.flatMap((spec) => [
        this.artifacts.write(
          projectId,
          `slide-specs/${spec.id}-v1.json`,
          JSON.stringify(spec, null, 2),
        ),
        this.artifacts.write(
          projectId,
          `slide-specs/${spec.id}-v1-image-brief.txt`,
          spec.imageGenerationBrief,
        ),
      ]),
    );
    return { ...version };
  }

  approveSlideSpecs(projectId: string, decidedAt: string): Readonly<Version> {
    const state = this.requireStage(projectId, 'detail_review');
    if (!state.slideSpecs)
      throw new Error('No slide specs are awaiting approval');
    const frozen = freezeVersion(state.slideSpecs.version, decidedAt);
    state.slideSpecs.version = frozen;
    state.approvals.push(
      this.approval(projectId, frozen.id, 'detail_review', decidedAt),
    );
    this.transition(state, 'visual_review');
    return frozen;
  }

  getProjectSnapshot(projectId: string): PptProjectSnapshot {
    const state = this.requireProject(projectId);
    return structuredClone(state);
  }

  getApprovedSlideSpec(
    projectId: string,
    slideId: string,
  ): { spec: SlideSpec; version: Version } {
    const state = this.requireStage(projectId, 'visual_review');
    const versioned = state.slideSpecs;
    if (!versioned || versioned.version.status !== 'frozen') {
      throw new Error(
        'Approved slide specs are required for visual generation',
      );
    }
    const spec = versioned.value.find((candidate) => candidate.id === slideId);
    if (!spec) throw new Error(`Unknown approved slide: ${slideId}`);
    return { spec: structuredClone(spec), version: { ...versioned.version } };
  }

  async recordGeneratedSlideVisual(
    projectId: string,
    slideId: string,
    generated: GeneratedVisualAsset,
  ): Promise<SlideVisualVersion> {
    return this.storeVisual(projectId, slideId, generated, true);
  }

  async replaceSlideVisual(
    projectId: string,
    slideId: string,
    generated: GeneratedSlideVisual,
  ): Promise<SlideVisualVersion> {
    if (generated.status !== 'generated')
      throw new Error('A blocked visual cannot replace a slide');
    return this.storeVisual(projectId, slideId, generated, false);
  }

  approveSlideVisual(
    projectId: string,
    slideId: string,
    decidedAt: string,
  ): Readonly<Version> {
    const state = this.requireStage(projectId, 'visual_review');
    const current = this.currentVisual(state, slideId);
    if (!current.asset)
      throw new Error(`Slide ${slideId} has no generated visual to approve`);
    const frozen = freezeVersion(current.version, decidedAt);
    current.version = frozen;
    state.approvals.push({
      ...this.approval(projectId, frozen.id, 'visual_review', decidedAt),
      slideId,
    });
    return frozen;
  }

  reopenApprovedSlide(
    projectId: string,
    slideId: string,
    reopenedAt: string,
  ): SlideVisualVersion {
    const state = this.requireStage(projectId, 'visual_review');
    const current = this.currentVisual(state, slideId);
    const approved = state.approvals.some(
      (approval) =>
        approval.stage === 'visual_review' &&
        approval.slideId === slideId &&
        approval.versionId === current.version.id &&
        approval.status === 'approved',
    );
    if (current.version.status !== 'frozen' || !approved) {
      throw new Error(
        `Only the current approved slide ${slideId} can be reopened`,
      );
    }
    const reopened: SlideVisualVersion = {
      slideId,
      version: this.newVersion(
        projectId,
        `visual-${slideId}`,
        current.version.sequence + 1,
        reopenedAt,
      ),
      asset: null,
    };
    (state.visuals[slideId] ??= []).push(reopened);
    return structuredClone(reopened);
  }

  completeVisualReview(projectId: string): void {
    const state = this.requireStage(projectId, 'visual_review');
    const slideIds = state.slideSpecs?.value.map(({ id }) => id) ?? [];
    const currentApprovals = slideIds.map((slideId) => {
      const current = this.currentVisual(state, slideId);
      const approval = state.approvals.find(
        (candidate) =>
          candidate.stage === 'visual_review' &&
          candidate.slideId === slideId &&
          candidate.versionId === current.version.id &&
          candidate.status === 'approved',
      );
      if (!approval || current.version.status !== 'frozen') {
        throw new Error(`Current visual for slide ${slideId} is not approved`);
      }
      return approval;
    });
    this.transition(state, 'conversion', {
      approvals: currentApprovals,
      visualSlideIds: slideIds,
    });
  }

  getApprovedDeck(projectId: string): {
    specs: readonly SlideSpec[];
    visuals: Readonly<Record<string, SlideVisualVersion>>;
  } {
    const state = this.requireStage(projectId, 'conversion');
    if (!state.slideSpecs) throw new Error('Approved slide specs are missing');
    const visuals = Object.fromEntries(
      state.slideSpecs.value.map(({ id }) => [
        id,
        structuredClone(this.currentVisual(state, id)),
      ]),
    );
    return { specs: structuredClone(state.slideSpecs.value), visuals };
  }

  recordExport(projectId: string, exportPath: string): void {
    const state = this.requireStage(projectId, 'conversion');
    state.exportPath = exportPath;
    this.transition(state, 'qa');
  }

  recordQaResult(projectId: string, status: 'passed' | 'failed'): void {
    const state = this.requireStage(projectId, 'qa');
    state.qaStatus = status;
    if (status === 'passed') this.transition(state, 'completed');
    else if (canTransition(state.project.workflowStatus, 'blocked')) {
      state.project.workflowStatus = 'blocked';
    }
  }

  private requireProject(projectId: string): ProjectState {
    const state = this.projects.get(projectId);
    if (!state) throw new Error(`Unknown PPT project: ${projectId}`);
    return state;
  }

  private requireStage(
    projectId: string,
    stage: PptWorkflowStage,
  ): ProjectState {
    const state = this.requireProject(projectId);
    if (state.project.workflowStatus !== stage) {
      throw new Error(
        `Operation requires stage ${stage}; current stage is ${state.project.workflowStatus}`,
      );
    }
    return state;
  }

  private transition(
    state: ProjectState,
    to: PptWorkflowStage,
    context: WorkflowTransitionContext = { approvals: state.approvals },
  ): void {
    if (!canTransition(state.project.workflowStatus, to, context)) {
      throw new Error(
        `Illegal workflow transition: ${state.project.workflowStatus} -> ${to}`,
      );
    }
    state.project.workflowStatus = to;
  }

  private newVersion(
    projectId: string,
    kind: string,
    sequence: number,
    createdAt?: string,
  ): Version {
    const state = this.requireProject(projectId);
    return {
      id: `${projectId}-${kind}-v${sequence}`,
      projectId,
      sequence,
      status: 'draft',
      createdAt: createdAt ?? state.project.updatedAt,
      frozenAt: null,
    };
  }

  private approval(
    projectId: string,
    versionId: string,
    stage: PptWorkflowStage,
    decidedAt: string,
  ): Approval {
    return {
      id: `${projectId}-${stage}-${this.requireProject(projectId).approvals.length + 1}`,
      projectId,
      versionId,
      stage,
      status: 'approved',
      decidedAt,
    };
  }

  private currentVisual(
    state: ProjectState,
    slideId: string,
  ): SlideVisualVersion {
    const versions = state.visuals[slideId];
    const current = versions?.at(-1);
    if (!current) throw new Error(`Slide ${slideId} has no visual version`);
    return current;
  }

  private async storeVisual(
    projectId: string,
    slideId: string,
    generated: GeneratedVisualAsset,
    reuseReopenedDraft: boolean,
  ): Promise<SlideVisualVersion> {
    const state = this.requireStage(projectId, 'visual_review');
    this.getApprovedSlideSpec(projectId, slideId);
    const versions = (state.visuals[slideId] ??= []);
    const current = versions.at(-1);
    if (current?.version.status === 'frozen') {
      throw new Error(
        `Approved slide ${slideId} must be reopened before regeneration`,
      );
    }
    const target =
      reuseReopenedDraft && current?.asset === null
        ? current
        : {
            slideId,
            version: this.newVersion(
              projectId,
              `visual-${slideId}`,
              (current?.version.sequence ?? 0) + 1,
            ),
            asset: null,
          };
    if (target !== current) versions.push(target);
    const artifactPath = await this.artifacts.write(
      projectId,
      `visuals/${slideId}-v${target.version.sequence}.png`,
      generated.image,
    );
    target.asset = {
      artifactPath,
      mediaType: generated.mediaType,
      usage: generated.usage,
      textFree: generated.textFree,
      altText: generated.altText,
    };
    return structuredClone(target);
  }
}
