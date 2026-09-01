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
  VisualAssetUsage,
} from './visual-generation.js';
import { assertStrictIdentifier } from './identifiers.js';
import { createHash } from 'node:crypto';
import {
  COMMIT_VALIDATED_SOURCE_ANALYSIS,
  type ValidatedSourceAnalysisEvidence,
} from './analysis-evidence.js';
import {
  COMMIT_EXPORT_RECEIPT,
  COMMIT_QA_REPORT,
  type ExportReceipt,
  type QaEvidence,
} from './delivery-evidence.js';
import {
  STORE_GENERATED_VISUAL,
  type GeneratedVisualEvidence,
} from './visual-evidence.js';
import { isAuthenticQaReport } from './libreoffice-qa.js';

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
  slides: readonly {
    id: string;
    title: string;
    purpose: string;
    sourceIds?: readonly string[];
    findingIds?: readonly string[];
    dataPointIds?: readonly string[];
  }[];
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
  findingIds?: readonly string[];
  dataPointIds?: readonly string[];
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
  sourceAnalysisEvidence: SourceAnalysisEvidence | null;
  outline: Versioned<PptOutline> | null;
  slideSpecs: Versioned<readonly SlideSpec[]> | null;
  visuals: Record<string, SlideVisualVersion[]>;
  exportPath: string | null;
  exportReceipt: ExportReceipt | null;
  qaStatus: 'passed' | 'failed' | null;
  approvals: Approval[];
  blockedCondition: RecoverableBlockedCondition | null;
}

export interface RecoverableBlockedCondition {
  kind: 'capability_unavailable';
  capability: 'image_gen.imagegen';
  recoverable: true;
  resumeStage: 'visual_review';
  slideId: string;
  message: string;
}

export interface SourceAnalysisEvidence {
  projectId: string;
  requestId: string;
  sourceIds: readonly string[];
  artifactPath: string;
  sha256: string;
  webSearchDecision?: {
    approved: boolean;
    query: string;
    decidedAt: string;
  };
}

export interface PptProjectSnapshot {
  project: Project;
  sources: readonly AttachedSource[];
  sourceAnalysis: SourceAnalysis | null;
  sourceAnalysisEvidence: SourceAnalysisEvidence | null;
  outline: Versioned<PptOutline> | null;
  slideSpecs: Versioned<readonly SlideSpec[]> | null;
  visuals: Readonly<Record<string, readonly SlideVisualVersion[]>>;
  exportPath: string | null;
  exportReceipt: ExportReceipt | null;
  qaStatus: 'passed' | 'failed' | null;
  approvals: readonly Approval[];
  blockedCondition: RecoverableBlockedCondition | null;
}

export class PptProjectService {
  private readonly projects = new Map<string, ProjectState>();
  private readonly activeOperations = new Map<string, Set<string>>();

  constructor(private readonly artifacts: WorkspaceArtifacts) {}

  /** Read-only boundary access for focused workflow coordinators. */
  artifactStore(): WorkspaceArtifacts {
    return this.artifacts;
  }

  async createProject(input: {
    id: string;
    name: string;
    createdAt: string;
  }): Promise<Project> {
    assertStrictIdentifier('project', input.id);
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
      sourceAnalysisEvidence: null,
      outline: null,
      slideSpecs: null,
      visuals: {},
      exportPath: null,
      exportReceipt: null,
      qaStatus: null,
      approvals: [],
      blockedCondition: null,
    });
    return { ...project };
  }

  async attachSource(
    projectId: string,
    input: SourceAttachment,
  ): Promise<AttachedSource> {
    const state = this.requireStage(projectId, 'intake');
    assertStrictIdentifier('source', input.id);
    if (state.sources.some(({ id }) => id === input.id)) {
      throw new Error(`Source already exists: ${input.id}`);
    }
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

  async [COMMIT_VALIDATED_SOURCE_ANALYSIS](
    evidence: ValidatedSourceAnalysisEvidence,
  ): Promise<SourceAnalysisEvidence> {
    const state = this.requireStage(evidence.projectId, 'source_analysis');
    assertStrictIdentifier('request', evidence.requestId);
    validateSourceAnalysisReferences(
      evidence.output,
      state.sources,
      evidence.sourceIds,
    );
    const bytes = new TextEncoder().encode(
      JSON.stringify(
        {
          projectId: evidence.projectId,
          requestId: evidence.requestId,
          sourceIds: evidence.sourceIds,
          webSearchDecision: evidence.webSearchDecision,
          output: evidence.output,
        },
        null,
        2,
      ),
    );
    const artifactPath = await this.artifacts.write(
      evidence.projectId,
      `sources/${evidence.requestId}-analysis.json`,
      bytes,
    );
    const receipt: SourceAnalysisEvidence = {
      projectId: evidence.projectId,
      requestId: evidence.requestId,
      sourceIds: [...evidence.sourceIds],
      artifactPath,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      ...(evidence.webSearchDecision
        ? { webSearchDecision: { ...evidence.webSearchDecision } }
        : {}),
    };
    state.sourceAnalysis = structuredClone(evidence.output);
    state.sourceAnalysisEvidence = receipt;
    return structuredClone(receipt);
  }

  async submitOutline(
    projectId: string,
    outline: PptOutline,
  ): Promise<Version> {
    const state = this.requireStage(projectId, 'source_analysis');
    if (!state.sourceAnalysis || !state.sourceAnalysisEvidence)
      throw new Error('Source analysis must be recorded before outline review');
    validateOutlineSchema(outline);
    if (outline.slides.length === 0)
      throw new Error('Outline must contain at least one slide');
    const slideIds = outline.slides.map(({ id }) =>
      assertStrictIdentifier('slide', id),
    );
    if (new Set(slideIds).size !== slideIds.length) {
      throw new Error('Outline slide identifiers must be unique');
    }
    validateAnalysisReferencesInOutline(outline, state);
    const version = this.newVersion(projectId, 'outline', 1);
    await this.artifacts.write(
      projectId,
      'outline/outline-v1.json',
      JSON.stringify(outline, null, 2),
    );
    state.outline = { version, value: structuredClone(outline) };
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
    validateSlideSpecsSchema(specs);
    const expectedSlideIds = state.outline.value.slides.map(({ id }) => id);
    const actualSlideIds = specs.map(({ id }) =>
      assertStrictIdentifier('slide', id),
    );
    if (
      new Set(actualSlideIds).size !== actualSlideIds.length ||
      actualSlideIds.length !== expectedSlideIds.length ||
      !expectedSlideIds.every((slideId) => actualSlideIds.includes(slideId))
    ) {
      throw new Error(
        'Slide specs must form an exact unique bijection with approved outline pages',
      );
    }
    for (const spec of specs) {
      validateSourceCitations(spec.sourceMap, state.sources);
      validateAnalysisEntityReferences(
        spec.findingIds,
        spec.dataPointIds,
        state.sourceAnalysis,
      );
      for (const table of spec.tables)
        assertStrictIdentifier('slide', table.id);
      for (const chart of spec.charts)
        assertStrictIdentifier('slide', chart.id);
      for (const shape of spec.shapes)
        assertStrictIdentifier('slide', shape.id);
    }
    const version = this.newVersion(projectId, 'slide-specs', 1);
    await this.artifacts.write(
      projectId,
      'slide-specs/slide-specs-v1.json',
      JSON.stringify(
        {
          outlineVersionId: state.outline.version.id,
          specs,
        },
        null,
        2,
      ),
    );
    state.slideSpecs = { version, value: structuredClone(specs) };
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
    return structuredClone(this.requireProject(projectId));
  }

  async projectDirectory(projectId: string): Promise<string> {
    this.requireProject(projectId);
    if (!this.artifacts.projectDirectory) {
      throw new Error(
        'Workspace boundary cannot provide a validated project directory',
      );
    }
    return this.artifacts.projectDirectory(projectId);
  }

  acquireProjectOperation(projectId: string, operation: string): () => void {
    this.requireProject(projectId);
    const active = this.activeOperations.get(projectId) ?? new Set<string>();
    this.activeOperations.set(projectId, active);
    if (active.has(operation)) {
      throw new Error(`A ${operation} is already running for this project`);
    }
    active.add(operation);
    return () => active.delete(operation);
  }

  blockVisualGeneration(
    projectId: string,
    slideId: string,
    message: string,
  ): void {
    const state = this.requireStage(projectId, 'visual_review');
    assertStrictIdentifier('slide', slideId);
    if (!canTransition(state.project.workflowStatus, 'blocked')) {
      throw new Error('Visual generation cannot be blocked from this stage');
    }
    state.blockedCondition = {
      kind: 'capability_unavailable',
      capability: 'image_gen.imagegen',
      recoverable: true,
      resumeStage: 'visual_review',
      slideId,
      message,
    };
    state.project.workflowStatus = 'blocked';
  }

  resumeVisualReview(projectId: string): void {
    const state = this.requireProject(projectId);
    if (
      state.project.workflowStatus !== 'blocked' ||
      state.blockedCondition?.resumeStage !== 'visual_review'
    ) {
      throw new Error('Project has no recoverable visual-review block');
    }
    state.project.workflowStatus = 'visual_review';
    state.blockedCondition = null;
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

  async [STORE_GENERATED_VISUAL](
    evidence: GeneratedVisualEvidence,
  ): Promise<SlideVisualVersion> {
    return this.storeVisual(
      evidence.projectId,
      evidence.slideId,
      evidence.generated,
      true,
    );
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

  async [COMMIT_EXPORT_RECEIPT](receipt: ExportReceipt): Promise<void> {
    const state = this.requireStage(receipt.projectId, 'conversion');
    if (
      !state.slideSpecs ||
      state.slideSpecs.version.id !== receipt.specVersionId
    ) {
      throw new Error('Export receipt is not bound to the frozen slide specs');
    }
    const expectedVisualIds = Object.fromEntries(
      state.slideSpecs.value.map(({ id }) => [
        id,
        this.currentVisual(state, id).version.id,
      ]),
    );
    if (
      JSON.stringify(expectedVisualIds) !==
      JSON.stringify(receipt.visualVersionIds)
    ) {
      throw new Error(
        'Export receipt is not bound to current approved visuals',
      );
    }
    if (!receipt.relativePath.startsWith('exports/')) {
      throw new Error('Export receipt path is outside project exports');
    }
    const access = this.artifacts as WorkspaceArtifacts & {
      read?: (projectId: string, path: string) => Promise<Uint8Array>;
      resolvePath?: (projectId: string, path: string) => Promise<string>;
    };
    if (!access.read || !access.resolvePath) {
      throw new Error('Export receipt requires readable workspace artifacts');
    }
    const expectedPath = await access.resolvePath(
      receipt.projectId,
      receipt.relativePath,
    );
    const bytes = await access.read(receipt.projectId, receipt.relativePath);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (
      receipt.artifactPath !== expectedPath ||
      receipt.byteLength !== bytes.byteLength ||
      receipt.sha256 !== sha256
    ) {
      throw new Error('Export receipt does not match validated artifact bytes');
    }
    state.exportPath = expectedPath;
    state.exportReceipt = structuredClone(receipt);
    this.transition(state, 'qa');
  }

  [COMMIT_QA_REPORT]({ receipt, report }: QaEvidence): void {
    const state = this.requireStage(receipt.projectId, 'qa');
    if (!isAuthenticQaReport(report)) {
      throw new Error('QA result lacks authentic QA execution proof');
    }
    if (
      !state.exportReceipt ||
      state.exportReceipt.sha256 !== receipt.sha256 ||
      report.projectId !== receipt.projectId ||
      report.exportPath !== receipt.relativePath ||
      report.exportSha256 !== receipt.sha256 ||
      report.specVersionId !== receipt.specVersionId ||
      JSON.stringify(report.visualVersionIds) !==
        JSON.stringify(receipt.visualVersionIds)
    ) {
      throw new Error('QA report is not bound to the validated export receipt');
    }
    state.qaStatus = report.status === 'passed' ? 'passed' : 'failed';
    if (report.status === 'passed') this.transition(state, 'completed');
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
    const versions = state.visuals[slideId] ?? [];
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
    if (target !== current) {
      (state.visuals[slideId] ??= []).push(target);
    }
    return structuredClone(target);
  }
}

function validateSourceAnalysisReferences(
  analysis: SourceAnalysis,
  sources: readonly AttachedSource[],
  permittedSourceIds: readonly string[] = sources.map(({ id }) => id),
): void {
  const attachedIds = new Set(sources.map(({ id }) => id));
  const permittedIds = new Set(permittedSourceIds);
  const assertAttached = (sourceId: string): void => {
    assertStrictIdentifier('source', sourceId);
    if (!attachedIds.has(sourceId)) {
      throw new Error(
        `Source analysis references unattached source: ${sourceId}`,
      );
    }
    if (!permittedIds.has(sourceId)) {
      throw new Error(
        `Source analysis references source outside requested source set: ${sourceId}`,
      );
    }
  };
  for (const finding of analysis.findings) {
    assertStrictIdentifier('version', finding.id);
    finding.sourceIds.forEach(assertAttached);
  }
  for (const dataPoint of analysis.dataPoints) {
    assertStrictIdentifier('version', dataPoint.id);
    dataPoint.sourceIds?.forEach(assertAttached);
  }
  analysis.sourceMap.forEach(({ sourceId }) => assertAttached(sourceId));
}

function validateSourceCitations(
  citations: readonly SourceCitation[],
  sources: readonly AttachedSource[],
): void {
  const attachedIds = new Set(sources.map(({ id }) => id));
  for (const { sourceId } of citations) {
    assertStrictIdentifier('source', sourceId);
    if (!attachedIds.has(sourceId)) {
      throw new Error(`Slide spec references unattached source: ${sourceId}`);
    }
  }
}

function validateOutlineSchema(outline: PptOutline): void {
  if (
    !outline ||
    typeof outline.title !== 'string' ||
    !Array.isArray(outline.slides) ||
    outline.slides.some(
      (slide) =>
        !slide ||
        typeof slide.id !== 'string' ||
        typeof slide.title !== 'string' ||
        typeof slide.purpose !== 'string' ||
        (slide.sourceIds !== undefined && !Array.isArray(slide.sourceIds)) ||
        (slide.findingIds !== undefined && !Array.isArray(slide.findingIds)) ||
        (slide.dataPointIds !== undefined &&
          !Array.isArray(slide.dataPointIds)),
    )
  ) {
    throw new Error('Generated outline does not match the runtime schema');
  }
}

function validateSlideSpecsSchema(specs: readonly SlideSpec[]): void {
  if (!Array.isArray(specs)) {
    throw new Error('Generated slide specs must be an array');
  }
  for (const spec of specs) {
    if (
      !spec ||
      typeof spec.id !== 'string' ||
      typeof spec.title !== 'string' ||
      !Array.isArray(spec.body) ||
      !spec.body.every((item: unknown) => typeof item === 'string') ||
      !Array.isArray(spec.tables) ||
      !Array.isArray(spec.charts) ||
      !Array.isArray(spec.shapes) ||
      !Array.isArray(spec.sourceMap) ||
      typeof spec.imageGenerationBrief !== 'string'
    ) {
      throw new Error(`Generated slide spec does not match the runtime schema`);
    }
    for (const table of spec.tables) {
      if (
        !Array.isArray(table.headers) ||
        !table.headers.every((item: unknown) => typeof item === 'string') ||
        !Array.isArray(table.rows) ||
        !table.rows.every(
          (row: unknown) =>
            Array.isArray(row) &&
            row.length === table.headers.length &&
            row.every((item: unknown) => typeof item === 'string'),
        )
      ) {
        throw new Error(
          `Slide table ${table.id} does not match the runtime schema`,
        );
      }
    }
    for (const chart of spec.charts) {
      if (
        !['bar', 'line', 'pie'].includes(chart.type) ||
        !Array.isArray(chart.categories) ||
        !Array.isArray(chart.series) ||
        !chart.series.every(
          (series: SlideChart['series'][number]) =>
            typeof series.name === 'string' &&
            Array.isArray(series.values) &&
            series.values.length === chart.categories.length &&
            series.values.every(Number.isFinite),
        )
      ) {
        throw new Error(
          `Slide chart ${chart.id} does not match the runtime schema`,
        );
      }
    }
    for (const shape of spec.shapes) {
      if (
        !['rect', 'ellipse', 'line'].includes(shape.type) ||
        ![shape.x, shape.y, shape.w, shape.h].every(Number.isFinite)
      ) {
        throw new Error(
          `Slide shape ${shape.id} does not match the runtime schema`,
        );
      }
    }
  }
}

function validateAnalysisReferencesInOutline(
  outline: PptOutline,
  state: ProjectState,
): void {
  const attachedIds = new Set(state.sources.map(({ id }) => id));
  for (const slide of outline.slides) {
    for (const sourceId of slide.sourceIds ?? []) {
      assertStrictIdentifier('source', sourceId);
      if (!attachedIds.has(sourceId)) {
        throw new Error(`Outline references unknown source: ${sourceId}`);
      }
    }
    validateAnalysisEntityReferences(
      slide.findingIds,
      slide.dataPointIds,
      state.sourceAnalysis,
    );
  }
}

function validateAnalysisEntityReferences(
  findingIds: readonly string[] | undefined,
  dataPointIds: readonly string[] | undefined,
  analysis: SourceAnalysis | null,
): void {
  if (!analysis) throw new Error('Validated source analysis is missing');
  const findings = new Set(analysis.findings.map(({ id }) => id));
  const dataPoints = new Set(analysis.dataPoints.map(({ id }) => id));
  for (const findingId of findingIds ?? []) {
    assertStrictIdentifier('version', findingId);
    if (!findings.has(findingId)) {
      throw new Error(
        `Generated structure references unknown finding: ${findingId}`,
      );
    }
  }
  for (const dataPointId of dataPointIds ?? []) {
    assertStrictIdentifier('version', dataPointId);
    if (!dataPoints.has(dataPointId)) {
      throw new Error(
        `Generated structure references unknown data point: ${dataPointId}`,
      );
    }
  }
}
