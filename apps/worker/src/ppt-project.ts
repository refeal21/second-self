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
import {
  type WorkspaceArtifacts,
  writeArtifactOrAdoptExact,
} from './workspace-artifacts.js';
import type {
  GeneratedVisualAsset,
  VisualAssetUsage,
} from './visual-generation.js';
import { assertStrictIdentifier } from './identifiers.js';
import { createHash } from 'node:crypto';
import {
  LibreOfficeQa,
  LocalCommandRunner,
  PngPixelPageComparator,
  isAuthenticQaReport,
  type LibreOfficeQaOptions,
  type LibreOfficeQaReport,
  type PptRepairer,
  type QaRunInput,
} from './libreoffice-qa.js';
import { LocalWorkspaceArtifacts } from './workspace-artifacts.js';
import {
  SourceAnalysisService,
  type SourceAnalysisGateway,
} from './source-analysis.js';
import {
  CodexVisualGenerationGateway,
  VisualGenerationService,
  type CodexImageGenTurnRunner,
  type VisualGenerationGateway,
} from './visual-generation.js';
import { PptDeliveryCoordinator } from './delivery-coordinator.js';
import type { QaRunner } from './libreoffice-qa.js';
import { PptxGenJsExporter, type PptxExporter } from './pptx-exporter.js';
import type { WorkspaceArtifactAccess } from './workspace-artifacts.js';
import { PNG } from 'pngjs';
import { validateNativePipelineCheckpoint, type NativePptPipeline } from './native-pipeline.js';
import {
  OutlineGenerationService,
  SlideSpecGenerationService,
  type OutlineGenerationGateway,
  type SlideSpecGenerationGateway,
} from './structure-generation.js';

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
  embeddingAudit?: {
    classification:
      | 'reference_only'
      | 'text_free_background'
      | 'complex_visual';
    approvedForEmbedding: boolean;
    decidedAt: string;
  };
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
  qaCheckpoint: QaCheckpoint | null;
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

export interface ValidatedSourceAnalysisEvidence {
  projectId: string;
  requestId: string;
  sourceIds: readonly string[];
  output: SourceAnalysis;
  webSearchDecision?: {
    approved: boolean;
    query: string;
    decidedAt: string;
  };
}

export interface ExportReceipt {
  projectId: string;
  relativePath: string;
  artifactPath: string;
  sha256: string;
  byteLength: number;
  specVersionId: string;
  visualVersionIds: Readonly<Record<string, string>>;
}

export interface QaCheckpoint {
  currentReceipt: ExportReceipt;
  expectedPageCount: number;
  repairRounds: number;
  reports: readonly LibreOfficeQaReport[];
  nextAction: 'qa' | 'repair' | 'finished';
}

export interface ProjectMutationPort {
  artifacts: WorkspaceArtifacts;
  beginSourceAnalysis(projectId: string): void;
  rollbackSourceAnalysis(projectId: string): void;
  commitSourceAnalysis(
    evidence: ValidatedSourceAnalysisEvidence,
  ): Promise<SourceAnalysisEvidence>;
  storeGeneratedVisual(input: {
    projectId: string;
    slideId: string;
    generated: GeneratedVisualAsset;
  }): Promise<SlideVisualVersion>;
  acquireOperation(projectId: string, operation: string): () => void;
  getApprovedDeck(projectId: string): {
    specs: readonly SlideSpec[];
    visuals: Readonly<Record<string, SlideVisualVersion>>;
  };
  commitExportReceipt(input: {
    receipt: ExportReceipt;
    expectedPageCount: number;
  }): Promise<void>;
  getQaCheckpoint(projectId: string): QaCheckpoint;
  commitRepairedExportReceipt(receipt: ExportReceipt): Promise<void>;
  commitQaReport(input: {
    receipt: ExportReceipt;
    report: LibreOfficeQaReport;
    finalFailure: boolean;
  }): void;
  blockVisualGeneration(
    projectId: string,
    slideId: string,
    message: string,
  ): void;
  resumeVisualReview(projectId: string): void;
}

const productionCompositionAuthority = Object.freeze({});

interface InternalComposition {
  authority: unknown;
  capture(port: ProjectMutationPort): void;
  authenticateQaReport?: (report: LibreOfficeQaReport) => boolean;
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
  qaCheckpoint: QaCheckpoint | null;
  approvals: readonly Approval[];
  blockedCondition: RecoverableBlockedCondition | null;
}

export class PptProjectService {
  readonly #projects = new Map<string, ProjectState>();
  readonly #activeOperations = new Map<string, Set<string>>();
  readonly #artifacts: WorkspaceArtifacts;
  readonly #authenticateQaReport: (report: LibreOfficeQaReport) => boolean;

  constructor(
    artifacts: WorkspaceArtifacts,
    composition?: InternalComposition,
  ) {
    this.#artifacts = artifacts;
    this.#authenticateQaReport =
      composition?.authority === productionCompositionAuthority &&
      composition.authenticateQaReport
        ? composition.authenticateQaReport
        : isAuthenticQaReport;
    const port = this.#createMutationPort();
    if (composition?.authority === productionCompositionAuthority) {
      composition.capture(port);
    }
  }

  async createProject(input: {
    id: string;
    name: string;
    createdAt: string;
  }): Promise<Project> {
    assertStrictIdentifier('project', input.id);
    if (this.#projects.has(input.id))
      throw new Error(`Project already exists: ${input.id}`);
    await this.#artifacts.initializeProject(input.id);
    const project: Project = {
      id: input.id,
      name: input.name,
      workflowStatus: 'intake',
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    };
    this.#projects.set(project.id, {
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
      qaCheckpoint: null,
      approvals: [],
      blockedCondition: null,
    });
    return { ...project };
  }

  async attachSource(
    projectId: string,
    input: SourceAttachment,
  ): Promise<AttachedSource> {
    const state = this.#requireStage(projectId, 'intake');
    assertStrictIdentifier('source', input.id);
    if (state.sources.some(({ id }) => id === input.id)) {
      throw new Error(`Source already exists: ${input.id}`);
    }
    if (basename(input.fileName) !== input.fileName)
      throw new Error('Source file name must not contain a path');
    const relativePath = `sources/${input.id}-${input.fileName}`;
    const artifactPath = await this.#artifacts.write(
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

  #beginSourceAnalysis(projectId: string): void {
    const state = this.#requireStage(projectId, 'intake');
    this.#transition(state, 'source_analysis');
  }

  #rollbackSourceAnalysis(projectId: string): void {
    const state = this.#requireStage(projectId, 'source_analysis');
    if (state.sourceAnalysis || state.sourceAnalysisEvidence) {
      throw new Error('Completed source analysis cannot be rolled back');
    }
    state.project.workflowStatus = 'intake';
  }

  async #commitValidatedSourceAnalysis(
    evidence: ValidatedSourceAnalysisEvidence,
  ): Promise<SourceAnalysisEvidence> {
    const state = this.#requireStage(evidence.projectId, 'source_analysis');
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
    const artifactPath = await writeArtifactOrAdoptExact(
      this.#artifacts,
      evidence.projectId,
      `sources/${evidence.requestId}-analysis.json`,
      bytes,
    );
    if (!artifactPath) {
      throw new Error('Analysis evidence requires a resolved artifact path');
    }
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
    const state = this.#requireStage(projectId, 'source_analysis');
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
    const version = this.#newVersion(projectId, 'outline', 1);
    await this.#artifacts.write(
      projectId,
      'outline/outline-v1.json',
      JSON.stringify(outline, null, 2),
    );
    state.outline = { version, value: structuredClone(outline) };
    this.#transition(state, 'outline_review');
    return { ...version };
  }

  approveOutline(projectId: string, decidedAt: string): Readonly<Version> {
    const state = this.#requireStage(projectId, 'outline_review');
    if (!state.outline) throw new Error('No outline is awaiting approval');
    const frozen = freezeVersion(state.outline.version, decidedAt);
    state.outline.version = frozen;
    state.approvals.push(
      this.#approval(projectId, frozen.id, 'outline_review', decidedAt),
    );
    this.#transition(state, 'detail_review');
    return frozen;
  }

  /** Native replay accepts only a complete checkpoint whose provenance passes native validation. */
  async restoreVersionedStructure(projectId: string, checkpoint: NativePptPipeline): Promise<void> {
    validateNativePipelineCheckpoint(checkpoint);
    const state = this.#requireStage(projectId, 'source_analysis');
    if (checkpoint.schemaVersion !== 2 || checkpoint.project.id !== projectId
      || !checkpoint.outline || !checkpoint.slideSpecs
      || JSON.stringify(checkpoint.analysis?.output) !== JSON.stringify(state.sourceAnalysis)
      || checkpoint.sources.map(({ id }) => id).join('|') !== state.sources.map(({ id }) => id).join('|')) {
      throw new Error('Versioned replay checkpoint does not match project analysis');
    }
    await this.#artifacts.write(projectId, `outline/outline-v${checkpoint.outline.version.sequence}.json`, JSON.stringify(checkpoint.outline.value, null, 2));
    await this.#artifacts.write(projectId, `slide-specs/slide-specs-v${checkpoint.slideSpecs.version.sequence}.json`, JSON.stringify({
      outlineVersionId: checkpoint.outline.version.id, specs: checkpoint.slideSpecs.value,
    }, null, 2));
    state.outline = structuredClone(checkpoint.outline);
    state.slideSpecs = structuredClone(checkpoint.slideSpecs);
    state.approvals = structuredClone(checkpoint.approvals.filter(({ stage }) => stage !== 'visual_review'));
    this.#transition(state, 'outline_review');
    this.#transition(state, 'detail_review');
    if (state.slideSpecs.version.status === 'frozen') this.#transition(state, 'visual_review');
  }

  async submitSlideSpecs(
    projectId: string,
    specs: readonly SlideSpec[],
  ): Promise<Version> {
    const state = this.#requireStage(projectId, 'detail_review');
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
      const nestedIds: string[] = [];
      validateSourceCitations(spec.sourceMap, state);
      validateAnalysisEntityReferences(
        spec.findingIds,
        spec.dataPointIds,
        state.sourceAnalysis,
      );
      for (const table of spec.tables)
        nestedIds.push(assertStrictIdentifier('slide', table.id));
      for (const chart of spec.charts)
        nestedIds.push(assertStrictIdentifier('slide', chart.id));
      for (const shape of spec.shapes)
        nestedIds.push(assertStrictIdentifier('slide', shape.id));
      if (new Set(nestedIds).size !== nestedIds.length) {
        throw new Error('Slide specs require unique nested identifiers');
      }
    }
    const version = this.#newVersion(projectId, 'slide-specs', 1);
    await this.#artifacts.write(
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
    const state = this.#requireStage(projectId, 'detail_review');
    if (!state.slideSpecs)
      throw new Error('No slide specs are awaiting approval');
    const frozen = freezeVersion(state.slideSpecs.version, decidedAt);
    state.slideSpecs.version = frozen;
    state.approvals.push(
      this.#approval(projectId, frozen.id, 'detail_review', decidedAt),
    );
    this.#transition(state, 'visual_review');
    return frozen;
  }

  getProjectSnapshot(projectId: string): PptProjectSnapshot {
    return structuredClone(this.#requireProject(projectId));
  }

  async projectDirectory(projectId: string): Promise<string> {
    this.#requireProject(projectId);
    if (!this.#artifacts.projectDirectory) {
      throw new Error(
        'Workspace boundary cannot provide a validated project directory',
      );
    }
    return this.#artifacts.projectDirectory(projectId);
  }

  #acquireProjectOperation(projectId: string, operation: string): () => void {
    this.#requireProject(projectId);
    const active = this.#activeOperations.get(projectId) ?? new Set<string>();
    this.#activeOperations.set(projectId, active);
    if (active.has(operation)) {
      throw new Error(`A ${operation} is already running for this project`);
    }
    active.add(operation);
    return () => active.delete(operation);
  }

  #blockVisualGeneration(
    projectId: string,
    slideId: string,
    message: string,
  ): void {
    const state = this.#requireStage(projectId, 'visual_review');
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

  #resumeVisualReview(projectId: string): void {
    const state = this.#requireProject(projectId);
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
    const state = this.#requireStage(projectId, 'visual_review');
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

  async #storeGeneratedVisual(evidence: {
    projectId: string;
    slideId: string;
    generated: GeneratedVisualAsset;
  }): Promise<SlideVisualVersion> {
    return this.#storeVisual(
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
    audit?: {
      classification:
        | 'reference_only'
        | 'text_free_background'
        | 'complex_visual';
      approvedForEmbedding: boolean;
    },
  ): Readonly<Version> {
    const state = this.#requireStage(projectId, 'visual_review');
    const current = this.#currentVisual(state, slideId);
    if (!current.asset)
      throw new Error(`Slide ${slideId} has no generated visual to approve`);
    const classification = audit?.classification ?? 'reference_only';
    const approvedForEmbedding = audit?.approvedForEmbedding ?? false;
    if (
      approvedForEmbedding &&
      (classification === 'reference_only' ||
        classification !== current.asset.usage ||
        !current.asset.textFree)
    ) {
      throw new Error(
        'Visual embedding audit must approve the matching text-free asset classification',
      );
    }
    current.asset.embeddingAudit = {
      classification,
      approvedForEmbedding,
      decidedAt,
    };
    const frozen = freezeVersion(current.version, decidedAt);
    current.version = frozen;
    state.approvals.push({
      ...this.#approval(projectId, frozen.id, 'visual_review', decidedAt),
      slideId,
    });
    return frozen;
  }

  reopenApprovedSlide(
    projectId: string,
    slideId: string,
    reopenedAt: string,
  ): SlideVisualVersion {
    const state = this.#requireStage(projectId, 'visual_review');
    const current = this.#currentVisual(state, slideId);
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
      version: this.#newVersion(
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
    const state = this.#requireStage(projectId, 'visual_review');
    const slideIds = state.slideSpecs?.value.map(({ id }) => id) ?? [];
    const currentApprovals = slideIds.map((slideId) => {
      const current = this.#currentVisual(state, slideId);
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
    this.#transition(state, 'conversion', {
      approvals: currentApprovals,
      visualSlideIds: slideIds,
    });
  }

  #getApprovedDeck(projectId: string): {
    specs: readonly SlideSpec[];
    visuals: Readonly<Record<string, SlideVisualVersion>>;
  } {
    const state = this.#requireStage(projectId, 'conversion');
    if (!state.slideSpecs) throw new Error('Approved slide specs are missing');
    const visuals = Object.fromEntries(
      state.slideSpecs.value.map(({ id }) => [
        id,
        structuredClone(this.#currentVisual(state, id)),
      ]),
    );
    return { specs: structuredClone(state.slideSpecs.value), visuals };
  }

  async #commitExportReceipt({
    receipt,
    expectedPageCount,
  }: {
    receipt: ExportReceipt;
    expectedPageCount: number;
  }): Promise<void> {
    const state = this.#requireStage(receipt.projectId, 'conversion');
    if (
      !Number.isSafeInteger(expectedPageCount) ||
      expectedPageCount <= 0 ||
      expectedPageCount !== state.slideSpecs?.value.length
    ) {
      throw new Error('Export receipt page count is not bound to slide specs');
    }
    await this.#validateExportReceipt(state, receipt);
    state.exportPath = receipt.artifactPath;
    state.exportReceipt = structuredClone(receipt);
    state.qaCheckpoint = {
      currentReceipt: structuredClone(receipt),
      expectedPageCount,
      repairRounds: 0,
      reports: [],
      nextAction: 'qa',
    };
    this.#transition(state, 'qa');
  }

  #getQaCheckpoint(projectId: string): QaCheckpoint {
    const checkpoint = this.#requireProject(projectId).qaCheckpoint;
    if (!checkpoint) throw new Error('Project has no QA checkpoint');
    return structuredClone(checkpoint);
  }

  async #commitRepairedExportReceipt(receipt: ExportReceipt): Promise<void> {
    const state = this.#requireStage(receipt.projectId, 'qa');
    const checkpoint = state.qaCheckpoint;
    if (!checkpoint || checkpoint.nextAction !== 'repair') {
      throw new Error('QA checkpoint is not awaiting a repair');
    }
    if (checkpoint.repairRounds >= 2) {
      throw new Error('QA repair limit has been reached');
    }
    if (receipt.sha256 === checkpoint.currentReceipt.sha256) {
      throw new Error('Repair must produce a new artifact hash');
    }
    await this.#validateExportReceipt(state, receipt);
    state.exportPath = receipt.artifactPath;
    state.exportReceipt = structuredClone(receipt);
    checkpoint.currentReceipt = structuredClone(receipt);
    checkpoint.repairRounds += 1;
    checkpoint.nextAction = 'qa';
  }

  #commitQaReport({
    receipt,
    report,
    finalFailure,
  }: {
    receipt: ExportReceipt;
    report: LibreOfficeQaReport;
    finalFailure: boolean;
  }): void {
    const state = this.#requireStage(receipt.projectId, 'qa');
    const checkpoint = state.qaCheckpoint;
    if (!checkpoint || checkpoint.nextAction !== 'qa') {
      throw new Error('QA checkpoint is not awaiting a report');
    }
    if (!this.#authenticateQaReport(report)) {
      throw new Error('QA result lacks authentic QA execution proof');
    }
    if (
      !state.exportReceipt ||
      !sameExportReceipt(state.exportReceipt, receipt) ||
      !sameExportReceipt(checkpoint.currentReceipt, receipt) ||
      !['passed', 'failed', 'blocked'].includes(report.status) ||
      report.round !== checkpoint.reports.length + 1 ||
      report.projectId !== receipt.projectId ||
      report.exportPath !== receipt.relativePath ||
      report.exportSha256 !== receipt.sha256 ||
      report.specVersionId !== receipt.specVersionId ||
      report.expectedPageCount !== checkpoint.expectedPageCount ||
      JSON.stringify(report.visualVersionIds) !==
        JSON.stringify(receipt.visualVersionIds)
    ) {
      throw new Error('QA report is not bound to the validated export receipt');
    }
    if (
      report.status === 'failed' &&
      finalFailure !== checkpoint.repairRounds >= 2
    ) {
      throw new Error('QA final-failure decision violates the repair limit');
    }
    checkpoint.reports = [...checkpoint.reports, structuredClone(report)];
    state.qaStatus = report.status === 'passed' ? 'passed' : 'failed';
    if (report.status === 'passed') {
      checkpoint.nextAction = 'finished';
      this.#transition(state, 'completed');
    } else if (report.status === 'blocked' || finalFailure) {
      checkpoint.nextAction = 'finished';
      if (!canTransition(state.project.workflowStatus, 'blocked')) {
        throw new Error('QA cannot block the project from this stage');
      }
      state.project.workflowStatus = 'blocked';
    } else {
      checkpoint.nextAction = 'repair';
    }
  }

  async #validateExportReceipt(
    state: ProjectState,
    receipt: ExportReceipt,
  ): Promise<void> {
    if (
      !state.slideSpecs ||
      state.slideSpecs.version.id !== receipt.specVersionId
    ) {
      throw new Error('Export receipt is not bound to the frozen slide specs');
    }
    const expectedVisualIds = Object.fromEntries(
      state.slideSpecs.value.map(({ id }) => [
        id,
        this.#currentVisual(state, id).version.id,
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
      throw new Error('Repaired PPTX must be inside project exports');
    }
    const access = this.#artifacts as WorkspaceArtifacts & {
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
      throw new Error(
        'Export receipt hash does not match validated artifact bytes',
      );
    }
  }

  #requireProject(projectId: string): ProjectState {
    const state = this.#projects.get(projectId);
    if (!state) throw new Error(`Unknown PPT project: ${projectId}`);
    return state;
  }

  #createMutationPort(): ProjectMutationPort {
    return Object.freeze({
      artifacts: this.#artifacts,
      beginSourceAnalysis: (projectId: string) =>
        this.#beginSourceAnalysis(projectId),
      rollbackSourceAnalysis: (projectId: string) =>
        this.#rollbackSourceAnalysis(projectId),
      commitSourceAnalysis: (evidence: ValidatedSourceAnalysisEvidence) =>
        this.#commitValidatedSourceAnalysis(evidence),
      storeGeneratedVisual: (input: {
        projectId: string;
        slideId: string;
        generated: GeneratedVisualAsset;
      }) => this.#storeGeneratedVisual(input),
      acquireOperation: (projectId: string, operation: string) =>
        this.#acquireProjectOperation(projectId, operation),
      getApprovedDeck: (projectId: string) => this.#getApprovedDeck(projectId),
      commitExportReceipt: (input: {
        receipt: ExportReceipt;
        expectedPageCount: number;
      }) => this.#commitExportReceipt(input),
      getQaCheckpoint: (projectId: string) => this.#getQaCheckpoint(projectId),
      commitRepairedExportReceipt: (receipt: ExportReceipt) =>
        this.#commitRepairedExportReceipt(receipt),
      commitQaReport: (input: {
        receipt: ExportReceipt;
        report: LibreOfficeQaReport;
        finalFailure: boolean;
      }) => this.#commitQaReport(input),
      blockVisualGeneration: (
        projectId: string,
        slideId: string,
        message: string,
      ) => this.#blockVisualGeneration(projectId, slideId, message),
      resumeVisualReview: (projectId: string) =>
        this.#resumeVisualReview(projectId),
    });
  }

  #requireStage(projectId: string, stage: PptWorkflowStage): ProjectState {
    const state = this.#requireProject(projectId);
    if (state.project.workflowStatus !== stage) {
      throw new Error(
        `Operation requires stage ${stage}; current stage is ${state.project.workflowStatus}`,
      );
    }
    return state;
  }

  #transition(
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

  #newVersion(
    projectId: string,
    kind: string,
    sequence: number,
    createdAt?: string,
  ): Version {
    const state = this.#requireProject(projectId);
    return {
      id: `${projectId}-${kind}-v${sequence}`,
      projectId,
      sequence,
      status: 'draft',
      createdAt: createdAt ?? state.project.updatedAt,
      frozenAt: null,
    };
  }

  #approval(
    projectId: string,
    versionId: string,
    stage: PptWorkflowStage,
    decidedAt: string,
  ): Approval {
    return {
      id: `${projectId}-${stage}-${this.#requireProject(projectId).approvals.length + 1}`,
      projectId,
      versionId,
      stage,
      status: 'approved',
      decidedAt,
    };
  }

  #currentVisual(state: ProjectState, slideId: string): SlideVisualVersion {
    const versions = state.visuals[slideId];
    const current = versions?.at(-1);
    if (!current) throw new Error(`Slide ${slideId} has no visual version`);
    return current;
  }

  async #storeVisual(
    projectId: string,
    slideId: string,
    generated: GeneratedVisualAsset,
    reuseReopenedDraft: boolean,
  ): Promise<SlideVisualVersion> {
    const state = this.#requireStage(projectId, 'visual_review');
    this.getApprovedSlideSpec(projectId, slideId);
    const versions = state.visuals[slideId] ?? [];
    const current = versions.at(-1);
    if (current?.version.status === 'frozen') {
      throw new Error(
        `Approved slide ${slideId} must be reopened before regeneration`,
      );
    }
    if (
      generated.status !== 'generated' ||
      generated.mediaType !== 'image/png' ||
      !(generated.image instanceof Uint8Array) ||
      ![
        'full_slide_reference',
        'text_free_background',
        'complex_visual',
      ].includes(generated.usage) ||
      typeof generated.textFree !== 'boolean' ||
      typeof generated.altText !== 'string'
    ) {
      throw new Error('Generated visual does not match the runtime schema');
    }
    try {
      PNG.sync.read(Buffer.from(generated.image));
    } catch {
      throw new Error('Generated visual must be a decodable PNG');
    }
    const target =
      reuseReopenedDraft && current?.asset === null
        ? current
        : {
            slideId,
            version: this.#newVersion(
              projectId,
              `visual-${slideId}`,
              (current?.version.sequence ?? 0) + 1,
            ),
            asset: null,
          };
    const artifactPath = await this.#artifacts.write(
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

export interface IsolatedPptWorkflow {
  projects: PptProjectService;
  sourceAnalysis(gateway: SourceAnalysisGateway): SourceAnalysisService;
  visualGeneration(gateway: VisualGenerationGateway): VisualGenerationService;
  delivery(input: {
    artifacts: WorkspaceArtifactAccess;
    exporter: PptxExporter;
    qa: QaRunner;
    repairer: PptRepairer;
  }): PptDeliveryCoordinator;
}

/**
 * Logic-test composition. Its callbacks are permanently bound to the new,
 * isolated project instance and can never target a production-composed one.
 */
export function createIsolatedPptWorkflow(
  artifacts: WorkspaceArtifacts,
): IsolatedPptWorkflow {
  let mutations: ProjectMutationPort | undefined;
  const projects = new PptProjectService(artifacts, {
    authority: productionCompositionAuthority,
    capture: (port) => {
      mutations = port;
    },
  });
  if (!mutations) throw new Error('Isolated workflow composition failed');
  const port = mutations;
  return Object.freeze({
    projects,
    sourceAnalysis: (gateway: SourceAnalysisGateway) =>
      new SourceAnalysisService(projects, gateway, port),
    visualGeneration: (gateway: VisualGenerationGateway) =>
      new VisualGenerationService(projects, gateway, port),
    delivery: (input: {
      artifacts: WorkspaceArtifactAccess;
      exporter: PptxExporter;
      qa: QaRunner;
      repairer: PptRepairer;
    }) =>
      new PptDeliveryCoordinator(
        projects,
        input.artifacts,
        input.exporter,
        input.qa,
        input.repairer,
        port,
      ),
  });
}

export interface ProductionPptWorkflow {
  projects: PptProjectService;
  sourceAnalysis: SourceAnalysisService;
  outlineGeneration: OutlineGenerationService;
  slideSpecGeneration: SlideSpecGenerationService;
  visualGeneration: VisualGenerationService;
  delivery: PptDeliveryCoordinator;
}

export interface ProductionPptWorkflowInput {
  workspaceRoot: string;
  sourceAnalysisGateway: SourceAnalysisGateway;
  outlineGenerationGateway: OutlineGenerationGateway;
  slideSpecGenerationGateway: SlideSpecGenerationGateway;
  imageGenTurnRunner: CodexImageGenTurnRunner;
  repairer: PptRepairer;
  qaOptions?: LibreOfficeQaOptions;
}

export function createProductionPptWorkflow(
  input: ProductionPptWorkflowInput,
): ProductionPptWorkflow {
  const artifacts = new LocalWorkspaceArtifacts(input.workspaceRoot);
  const productionQaReports = new WeakSet<LibreOfficeQaReport>();
  let mutations: ProjectMutationPort | undefined;
  const projects = new PptProjectService(artifacts, {
    authority: productionCompositionAuthority,
    authenticateQaReport: (report) => productionQaReports.has(report),
    capture: (port) => {
      mutations = port;
    },
  });
  if (!mutations) throw new Error('Production workflow composition failed');
  const port = mutations;
  const sourceAnalysis = new SourceAnalysisService(
    projects,
    input.sourceAnalysisGateway,
    port,
  );
  const outlineGeneration = new OutlineGenerationService(
    projects,
    input.outlineGenerationGateway,
  );
  const slideSpecGeneration = new SlideSpecGenerationService(
    projects,
    input.slideSpecGenerationGateway,
  );
  const visualGeneration = new VisualGenerationService(
    projects,
    new CodexVisualGenerationGateway(input.imageGenTurnRunner),
    port,
  );
  const localQa = new LibreOfficeQa(
    new LocalCommandRunner(),
    artifacts,
    new PngPixelPageComparator(),
    input.qaOptions,
  );
  const qa: QaRunner = Object.freeze({
    run: async (runInput: QaRunInput) => {
      const report = await localQa.run(runInput);
      productionQaReports.add(report);
      return report;
    },
    reissueValidatedReport: (report: LibreOfficeQaReport) => {
      const reissued = localQa.reissueValidatedReport(report);
      productionQaReports.add(reissued);
      return reissued;
    },
  });
  const delivery = new PptDeliveryCoordinator(
    projects,
    artifacts,
    new PptxGenJsExporter(),
    qa,
    input.repairer,
    port,
  );
  return Object.freeze({
    projects,
    sourceAnalysis,
    outlineGeneration,
    slideSpecGeneration,
    visualGeneration,
    delivery,
  });
}

function sameExportReceipt(left: ExportReceipt, right: ExportReceipt): boolean {
  return (
    left.projectId === right.projectId &&
    left.relativePath === right.relativePath &&
    left.artifactPath === right.artifactPath &&
    left.sha256 === right.sha256 &&
    left.byteLength === right.byteLength &&
    left.specVersionId === right.specVersionId &&
    JSON.stringify(left.visualVersionIds) ===
      JSON.stringify(right.visualVersionIds)
  );
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
  state: ProjectState,
): void {
  const analyzedCitationIds = new Set(
    state.sourceAnalysis?.sourceMap.map(({ sourceId }) => sourceId) ?? [],
  );
  for (const { sourceId } of citations) {
    assertStrictIdentifier('source', sourceId);
    if (!analyzedCitationIds.has(sourceId)) {
      throw new Error(
        `Slide spec references source outside completed analysis citation set: ${sourceId}`,
      );
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
      (spec.findingIds !== undefined &&
        (!Array.isArray(spec.findingIds) ||
          !spec.findingIds.every(
            (value: unknown) => typeof value === 'string',
          ))) ||
      (spec.dataPointIds !== undefined &&
        (!Array.isArray(spec.dataPointIds) ||
          !spec.dataPointIds.every(
            (value: unknown) => typeof value === 'string',
          ))) ||
      typeof spec.imageGenerationBrief !== 'string'
    ) {
      throw new Error(`Generated slide spec does not match the runtime schema`);
    }
    for (const table of spec.tables) {
      if (
        !table ||
        typeof table.id !== 'string' ||
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
        !chart ||
        typeof chart.id !== 'string' ||
        !['bar', 'line', 'pie'].includes(chart.type) ||
        !Array.isArray(chart.categories) ||
        !chart.categories.every(
          (category: unknown) => typeof category === 'string',
        ) ||
        !Array.isArray(chart.series) ||
        !chart.series.every(
          (series: SlideChart['series'][number]) =>
            Boolean(series) &&
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
        !shape ||
        typeof shape.id !== 'string' ||
        !['rect', 'ellipse', 'line'].includes(shape.type) ||
        ![shape.x, shape.y, shape.w, shape.h].every(
          (value) => Number.isFinite(value) && value >= 0,
        ) ||
        (shape.fill !== undefined && typeof shape.fill !== 'string') ||
        (shape.line !== undefined && typeof shape.line !== 'string') ||
        (shape.text !== undefined && typeof shape.text !== 'string')
      ) {
        throw new Error(
          `Slide shape ${shape.id} does not match the runtime schema`,
        );
      }
    }
    for (const citation of spec.sourceMap) {
      if (
        !citation ||
        typeof citation.sourceId !== 'string' ||
        typeof citation.title !== 'string' ||
        typeof citation.locator !== 'string' ||
        (citation.url !== undefined && typeof citation.url !== 'string')
      ) {
        throw new Error(
          'Slide source citation does not match the runtime schema',
        );
      }
    }
  }
}

function validateAnalysisReferencesInOutline(
  outline: PptOutline,
  state: ProjectState,
): void {
  const analyzedCitationIds = new Set(
    state.sourceAnalysis?.sourceMap.map(({ sourceId }) => sourceId) ?? [],
  );
  for (const slide of outline.slides) {
    for (const sourceId of slide.sourceIds ?? []) {
      assertStrictIdentifier('source', sourceId);
      if (!analyzedCitationIds.has(sourceId)) {
        throw new Error(
          `Outline references source outside completed analysis source set: ${sourceId}`,
        );
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
