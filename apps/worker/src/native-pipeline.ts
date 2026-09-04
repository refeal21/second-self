import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import type { Approval, Version, WorkflowStatus } from '@digital-twin/core';
import { PNG } from 'pngjs';
import {
  createIsolatedPptWorkflow,
  type ApprovedVisualAsset,
  type PptOutline,
  type SlideSpec,
  type SourceAnalysis,
} from './ppt-project.js';
import { PptxGenJsExporter } from './pptx-exporter.js';
import {
  formatQaReadableSummary,
  inspectPptxOoxml,
  PngPixelPageComparator,
  type LibreOfficeQaReport,
} from './libreoffice-qa.js';
import type {
  WorkspaceArtifactAccess,
} from './workspace-artifacts.js';

export interface NativePreferenceSnapshot {
  proposalId: string;
  title: string;
  content: string;
  approvedAt: string;
}

export interface NativeSourceAsset {
  id: string;
  fileName: string;
  mediaType: string;
  relativePath: string;
  sha256: string;
  byteLength: number;
}

export interface NativeVersioned<T> {
  version: Version;
  value: T;
}

export interface NativeVisualVersion {
  slideId: string;
  version: Version;
  relativePath: string;
  sha256: string;
  byteLength: number;
  usage: 'full_slide_reference' | 'text_free_background' | 'complex_visual';
  textFree: boolean;
  altText: string;
}

export interface NativeTaskRecord {
  id: string;
  kind: 'source_analysis' | 'outline_generation' | 'detail_generation' | 'visual_generation' | 'conversion' | 'qa';
  status: 'queued' | 'running' | 'completed' | 'blocked' | 'failed';
  createdAt: string;
  updatedAt: string;
  error: string | null;
}

export interface NativeExportReceipt {
  relativePath: string;
  sha256: string;
  byteLength: number;
  specVersionId: string;
  visualVersionIds: Record<string, string>;
}

export interface NativePptPipeline {
  schemaVersion: 1;
  revision: number;
  project: {
    id: string;
    name: string;
    goal: string;
    workflowStatus: WorkflowStatus;
    createdAt: string;
    updatedAt: string;
  };
  preferenceSnapshot: NativePreferenceSnapshot[];
  sources: NativeSourceAsset[];
  analysis: {
    requestId: string;
    output: SourceAnalysis;
    artifactRelativePath: string;
    sha256: string;
  } | null;
  outline: NativeVersioned<PptOutline> | null;
  slideSpecs: NativeVersioned<readonly SlideSpec[]> | null;
  visuals: Record<string, NativeVisualVersion[]>;
  currentSlideId: string | null;
  approvals: Approval[];
  tasks: NativeTaskRecord[];
  blockedCondition: {
    kind: 'capability_unavailable';
    capability: 'image_gen.imagegen' | 'libreoffice' | 'pdf-renderer' | 'qa-rendering';
    recoverable: true;
    resumeStage: 'visual_review' | 'qa';
    slideId?: string;
    message: string;
  } | null;
  exportReceipt: NativeExportReceipt | null;
  qaReport: LibreOfficeQaReport | null;
}

export interface NativeArtifactWrite {
  relativePath: string;
  contentsBase64: string;
  sha256: string;
  byteLength: number;
  kind: string;
  versionId: string;
  slideId?: string;
  metadata?: Record<string, unknown>;
}

export interface NativePipelineResult {
  pipeline: NativePptPipeline;
  writes: NativeArtifactWrite[];
  message: string;
}

export type NativeQaPreparation =
  | {
      status: 'blocked' | 'failed';
      issue: string;
      capability?: 'libreoffice' | 'pdf-renderer' | 'qa-rendering';
    }
  | {
      status: 'ready';
      sofficePath: string;
      rendererPath: string;
      pptxBase64: string;
      pdfBase64: string;
      renderedPages: readonly { fileName: string; contentsBase64: string }[];
      approvedVisuals: readonly {
        slideId: string;
        relativePath: string;
        contentsBase64: string;
      }[];
      fontAvailability: Readonly<Record<string, boolean>>;
    };

export type NativePipelineAction =
  | { kind: 'analysis.commit'; at: string; requestId: string; output: SourceAnalysis }
  | { kind: 'outline.submit'; at: string; outline: PptOutline }
  | { kind: 'outline.approve'; at: string }
  | { kind: 'details.submit'; at: string; specs: readonly SlideSpec[] }
  | { kind: 'details.approve'; at: string }
  | { kind: 'visual.generate'; at: string; slideId: string }
  | { kind: 'visual.replace'; at: string; slideId: string; imageBase64: string; altText: string }
  | { kind: 'visual.approve'; at: string; slideId: string }
  | { kind: 'visual.reopen'; at: string; slideId: string }
  | { kind: 'deck.export'; at: string; fileName: string; visualBytes: Record<string, string> }
  | { kind: 'deck.qa'; at: string; preparation: NativeQaPreparation };

export function parseNativePipelineAction(value: unknown): NativePipelineAction {
  const action = requireRecordValue(value, 'action');
  const kind = requireStringValue(action.kind, 'action.kind');
  requireStringValue(action.at, 'action.at');
  switch (kind) {
    case 'analysis.commit':
      requireExactKeys(action, ['kind', 'at', 'requestId', 'output'], 'analysis.commit');
      requireIdentifier(requireStringValue(action.requestId, 'action.requestId'), 'request id');
      validateSourceAnalysisValue(action.output);
      break;
    case 'outline.submit':
      requireExactKeys(action, ['kind', 'at', 'outline'], 'outline.submit');
      validateOutlineValue(action.outline);
      break;
    case 'outline.approve':
    case 'details.approve':
      requireExactKeys(action, ['kind', 'at'], kind);
      break;
    case 'details.submit':
      requireExactKeys(action, ['kind', 'at', 'specs'], 'details.submit');
      validateSlideSpecsValue(action.specs);
      break;
    case 'visual.generate':
    case 'visual.approve':
    case 'visual.reopen':
      requireExactKeys(action, ['kind', 'at', 'slideId'], kind);
      requireIdentifier(requireStringValue(action.slideId, 'action.slideId'), 'slide id');
      break;
    case 'visual.replace':
      requireExactKeys(action, ['kind', 'at', 'slideId', 'imageBase64', 'altText'], kind);
      requireIdentifier(requireStringValue(action.slideId, 'action.slideId'), 'slide id');
      requireBase64Value(action.imageBase64, 'action.imageBase64');
      requireStringValue(action.altText, 'action.altText');
      break;
    case 'deck.export': {
      requireExactKeys(action, ['kind', 'at', 'fileName', 'visualBytes'], kind);
      requireStringValue(action.fileName, 'action.fileName');
      const bytes = requireRecordValue(action.visualBytes, 'action.visualBytes');
      for (const [slideId, encoded] of Object.entries(bytes)) {
        requireIdentifier(slideId, 'slide id');
        requireBase64Value(encoded, `action.visualBytes.${slideId}`);
      }
      break;
    }
    case 'deck.qa':
      requireExactKeys(action, ['kind', 'at', 'preparation'], kind);
      validateQaPreparationValue(action.preparation);
      break;
    default:
      throw new Error(`Unknown native pipeline action: ${kind}`);
  }
  return structuredClone(action) as unknown as NativePipelineAction;
}

export interface NativePptRpcRuntimeOptions {
  imageGenAvailable: boolean;
  generateVisual?: (slideId: string, spec: SlideSpec) => Promise<{
    image: Uint8Array;
    usage: NativeVisualVersion['usage'];
    textFree: boolean;
    altText: string;
  }>;
}

const IMAGEGEN_UNAVAILABLE_MESSAGE = 'Codex ImageGen 能力当前不可用；可上传替换 PNG 继续。';

export function createNativePipeline(input: {
  id: string;
  name: string;
  goal: string;
  createdAt: string;
  preferenceSnapshot?: NativePreferenceSnapshot[];
}): NativePptPipeline {
  requireIdentifier(input.id, 'project id');
  requireNonEmpty(input.name, 'project name');
  requireNonEmpty(input.goal, 'project goal');
  return {
    schemaVersion: 1,
    revision: 1,
    project: {
      id: input.id,
      name: input.name,
      goal: input.goal,
      workflowStatus: 'intake',
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    },
    preferenceSnapshot: structuredClone(input.preferenceSnapshot ?? []),
    sources: [],
    analysis: null,
    outline: null,
    slideSpecs: null,
    visuals: {},
    currentSlideId: null,
    approvals: [],
    tasks: [],
    blockedCondition: null,
    exportReceipt: null,
    qaReport: null,
  };
}

export class NativePptRpcRuntime {
  readonly #projects = new Map<string, NativePptPipeline>();

  constructor(private readonly options: NativePptRpcRuntimeOptions) {}

  create(input: Parameters<typeof createNativePipeline>[0]): NativePptPipeline {
    const pipeline = createNativePipeline(input);
    if (this.#projects.has(pipeline.project.id)) {
      throw new Error(`Native PPT project already exists: ${pipeline.project.id}`);
    }
    this.#projects.set(pipeline.project.id, structuredClone(pipeline));
    return structuredClone(pipeline);
  }

  async restore(input: NativePptPipeline): Promise<NativePptPipeline> {
    validatePipeline(input);
    await validateRestoredPipeline(input);
    const copy = structuredClone(input);
    this.#projects.set(copy.project.id, copy);
    return structuredClone(copy);
  }

  snapshot(projectId: string): NativePptPipeline {
    return structuredClone(this.#require(projectId));
  }

  async execute(
    projectId: string,
    action: NativePipelineAction,
  ): Promise<NativePipelineResult> {
    const current = this.#require(projectId);
    const state = structuredClone(current);
    const writes: NativeArtifactWrite[] = [];
    let message: string;
    switch (action.kind) {
      case 'analysis.commit': {
        const workflow = await replayPipeline(state, 'intake');
        const service = workflow.sourceAnalysis({
          analyze: async () => structuredClone(action.output),
        });
        await service.request({
          id: action.requestId,
          projectId,
          sourceIds: state.sources.map(({ id }) => id),
        });
        const completed = await service.execute(action.requestId);
        if (!completed.output) throw new Error('Source analysis produced no output');
        const contents = jsonBytes({
          projectId,
          requestId: action.requestId,
          sourceIds: state.sources.map(({ id }) => id),
          output: completed.output,
        });
        const relativePath = `sources/${action.requestId}-analysis.json`;
        const write = createWrite(relativePath, contents, 'source-analysis', action.requestId);
        writes.push(write);
        state.analysis = {
          requestId: action.requestId,
          output: structuredClone(completed.output),
          artifactRelativePath: relativePath,
          sha256: write.sha256,
        };
        state.project.workflowStatus = 'source_analysis';
        message = '材料分析已完成，来源映射已保存。';
        break;
      }
      case 'outline.submit': {
        const editingDraft = state.project.workflowStatus === 'outline_review'
          && state.outline?.version.status === 'draft';
        const replayState = editingDraft
          ? { ...structuredClone(state), outline: null,
              project: { ...state.project, workflowStatus: 'source_analysis' as const } }
          : state;
        const workflow = await replayPipeline(replayState, 'source_analysis');
        const service = new (await import('./structure-generation.js')).OutlineGenerationService(
          workflow.projects,
          { generate: async () => structuredClone(action.outline) },
        );
        const generatedVersion = await service.generate(projectId);
        const version = editingDraft ? structuredClone(state.outline!.version) : generatedVersion;
        state.outline = { version, value: structuredClone(action.outline) };
        state.project.workflowStatus = 'outline_review';
        writes.push(createWrite('outline/outline-v1.json', jsonBytes(action.outline), 'outline', version.id));
        message = '整份大纲已生成，等待审批。';
        break;
      }
      case 'outline.approve': {
        const workflow = await replayPipeline(state, 'outline_review');
        const frozen = workflow.projects.approveOutline(projectId, action.at);
        state.outline = { version: { ...frozen }, value: structuredClone(state.outline!.value) };
        state.approvals = workflow.projects.getProjectSnapshot(projectId).approvals.map((item) => ({ ...item }));
        state.project.workflowStatus = 'detail_review';
        message = '整份大纲已批准并冻结。';
        break;
      }
      case 'details.submit': {
        const workflow = await replayPipeline(state, 'detail_review');
        const service = new (await import('./structure-generation.js')).SlideSpecGenerationService(
          workflow.projects,
          { generate: async () => structuredClone(action.specs) },
        );
        const version = await service.generate(projectId);
        state.slideSpecs = { version, value: structuredClone(action.specs) };
        writes.push(createWrite(
          'slide-specs/slide-specs-v1.json',
          jsonBytes({ outlineVersionId: state.outline!.version.id, specs: action.specs }),
          'slide-specs',
          version.id,
        ));
        message = '全部页面细化已生成，等待整体审批。';
        break;
      }
      case 'details.approve': {
        const workflow = await replayPipeline(state, 'detail_review');
        const frozen = workflow.projects.approveSlideSpecs(projectId, action.at);
        state.slideSpecs = { version: { ...frozen }, value: structuredClone(state.slideSpecs!.value) };
        const snapshot = workflow.projects.getProjectSnapshot(projectId);
        state.approvals = snapshot.approvals.map((item) => ({ ...item }));
        state.project.workflowStatus = 'visual_review';
        state.currentSlideId = state.slideSpecs.value[0]?.id ?? null;
        message = '全部页面细化已批准，进入逐页视觉审批。';
        break;
      }
      case 'visual.generate': {
        requireCurrentSlide(state, action.slideId);
        if (!this.options.imageGenAvailable) {
          state.project.workflowStatus = 'blocked';
          state.blockedCondition = {
            kind: 'capability_unavailable',
            capability: 'image_gen.imagegen',
            recoverable: true,
            resumeStage: 'visual_review',
            slideId: action.slideId,
            message: IMAGEGEN_UNAVAILABLE_MESSAGE,
          };
          message = state.blockedCondition.message;
          break;
        }
        if (!this.options.generateVisual) {
          throw new Error('ImageGen capability is available but no turn runner is connected');
        }
        const spec = requireSpec(state, action.slideId);
        const generated = await this.options.generateVisual(action.slideId, spec);
        ({ message } = await replaceVisual(state, writes, {
          ...action,
          imageBase64: Buffer.from(generated.image).toString('base64'),
          altText: generated.altText,
          usage: generated.usage,
          textFree: generated.textFree,
        }));
        break;
      }
      case 'visual.replace': {
        ({ message } = await replaceVisual(state, writes, {
          ...action,
          usage: 'full_slide_reference',
          textFree: false,
        }));
        break;
      }
      case 'visual.approve': {
        const workflow = await replayPipeline(state, 'visual_review');
        requireCurrentSlide(state, action.slideId);
        const visual = currentVisual(state, action.slideId);
        if (!visual) throw new Error(`Slide ${action.slideId} has no visual candidate`);
        workflow.projects.approveSlideVisual(
          projectId,
          action.slideId,
          action.at,
        );
        visual.version = { ...visual.version, status: 'frozen', frozenAt: action.at };
        state.approvals.push({
          id: `${projectId}-approval-visual-${action.slideId}-v${visual.version.sequence}`,
          projectId, versionId: visual.version.id, stage: 'visual_review',
          slideId: action.slideId, status: 'approved', decidedAt: action.at,
        });
        const slideIds = state.slideSpecs!.value.map(({ id }) => id);
        const nextIndex = slideIds.findIndex((id) => currentVisual(state, id)?.version.status !== 'frozen');
        if (nextIndex < 0) {
          state.project.workflowStatus = 'conversion';
          state.currentSlideId = action.slideId;
          message = '最后一页已批准，进入可编辑转换。';
        } else {
          state.currentSlideId = slideIds[nextIndex]!;
          message = `当前页已批准，进入第 ${nextIndex + 1} 页。`;
        }
        break;
      }
      case 'visual.reopen': {
        if (!['visual_review', 'conversion'].includes(state.project.workflowStatus)) {
          throw new Error('Only a visual-review or conversion project can reopen a slide');
        }
        const visual = currentVisual(state, action.slideId);
        if (!visual || visual.version.status !== 'frozen') {
          throw new Error(`Only an approved slide ${action.slideId} can be reopened`);
        }
        await replayPipeline(state, 'visual_review');
        const version: Version = {
          id: `${projectId}-visual-${action.slideId}-v${visual.version.sequence + 1}`,
          projectId, sequence: visual.version.sequence + 1, status: 'draft',
          createdAt: action.at, frozenAt: null,
        };
        (state.visuals[action.slideId] ??= []).push({
          ...visual, version, relativePath: '', sha256: '', byteLength: 0,
        });
        state.project.workflowStatus = 'visual_review';
        state.currentSlideId = action.slideId;
        state.exportReceipt = null;
        message = `第 ${action.slideId} 页已重新打开，等待新候选。`;
        break;
      }
      case 'deck.export': {
        await replayPipeline(state, 'conversion');
        if (basename(action.fileName) !== action.fileName || !/\.pptx$/i.test(action.fileName)) {
          throw new Error('Export file name must be a local .pptx name');
        }
        const slides = state.slideSpecs!.value.map((spec) => {
          const visual = currentVisual(state, spec.id);
          if (!visual || visual.version.status !== 'frozen') {
            throw new Error(`Approved visual is missing for ${spec.id}`);
          }
          const encoded = action.visualBytes[spec.id];
          if (!encoded) throw new Error(`Visual bytes are missing for ${spec.id}`);
          const image = new Uint8Array(Buffer.from(encoded, 'base64'));
          if (hash(image) !== visual.sha256) {
            throw new Error(`Visual bytes do not match persisted hash for ${spec.id}`);
          }
          const asset: ApprovedVisualAsset = {
            artifactPath: visual.relativePath,
            mediaType: 'image/png',
            usage: visual.usage,
            textFree: visual.textFree,
            altText: visual.altText,
            embeddingAudit: {
              classification: visual.usage === 'full_slide_reference'
                ? 'reference_only'
                : visual.usage,
              approvedForEmbedding: visual.usage !== 'full_slide_reference' && visual.textFree,
              decidedAt: visual.version.frozenAt ?? action.at,
            },
          };
          return { spec, visual: { asset, image } };
        });
        const bytes = await new PptxGenJsExporter().export({
          title: state.outline!.value.title,
          slides,
        });
        const relativePath = `exports/${action.fileName}`;
        const write = createWrite(
          relativePath,
          bytes,
          'pptx',
          state.slideSpecs!.version.id,
        );
        writes.push(write);
        state.exportReceipt = {
          relativePath,
          sha256: write.sha256,
          byteLength: write.byteLength,
          specVersionId: state.slideSpecs!.version.id,
          visualVersionIds: Object.fromEntries(
            Object.entries(state.visuals).map(([slideId, items]) => [slideId, items.at(-1)!.version.id]),
          ),
        };
        state.project.workflowStatus = 'qa';
        message = '可编辑 PPTX 已生成并等待自动 QA。';
        break;
      }
      case 'deck.qa': {
        if (state.project.workflowStatus === 'blocked') {
          if (state.blockedCondition?.resumeStage !== 'qa') {
            throw new Error('Only a recoverable QA block can retry QA');
          }
          state.project.workflowStatus = 'qa';
          state.blockedCondition = null;
        }
        await replayPipeline(state, 'qa');
        const receipt = state.exportReceipt;
        if (!receipt || !state.slideSpecs) {
          throw new Error('QA requires a committed export receipt and approved slide specs');
        }
        const round = state.tasks.filter(({ kind }) => kind === 'qa').length + 1;
        if (action.preparation.status !== 'ready') {
          const report = createNativeQaReport(state, round, {
            status: action.preparation.status,
            issues: [action.preparation.issue],
          });
          writes.push(...qaReportWrites(report));
          state.qaReport = report;
          state.project.workflowStatus = 'blocked';
          state.blockedCondition = {
            kind: 'capability_unavailable',
            capability: action.preparation.capability ?? 'qa-rendering',
            recoverable: true,
            resumeStage: 'qa',
            message: action.preparation.issue,
          };
          message = `自动 QA 暂时无法完成：${action.preparation.issue}`;
          break;
        }
        const preparation = action.preparation;
        const pptxBytes = decodeBase64(preparation.pptxBase64, 'PPTX');
        if (hash(pptxBytes) !== receipt.sha256) {
          throw new Error('Prepared PPTX does not match the committed export receipt');
        }
        const inspection = await inspectPptxOoxml(pptxBytes);
        const specs = state.slideSpecs.value;
        if (preparation.renderedPages.length !== specs.length) {
          throw new Error('Prepared rendered pages do not match approved slide count');
        }
        if (preparation.approvedVisuals.length !== specs.length) {
          throw new Error('Prepared approved visuals do not map one-to-one to slides');
        }
        const approvedPaths = new Set<string>();
        const approvedVisuals = preparation.approvedVisuals.map((prepared, index) => {
          const spec = specs[index]!;
          const visual = currentVisual(state, spec.id);
          if (
            prepared.slideId !== spec.id ||
            !visual ||
            visual.version.status !== 'frozen' ||
            prepared.relativePath !== visual.relativePath
          ) {
            throw new Error(`Prepared approved visual does not match ${spec.id}`);
          }
          if (approvedPaths.has(prepared.relativePath)) {
            throw new Error('Every approved slide must use its own persisted visual path');
          }
          approvedPaths.add(prepared.relativePath);
          const contents = decodeBase64(prepared.contentsBase64, `approved visual ${spec.id}`);
          if (hash(contents) !== visual.sha256) {
            throw new Error(`Prepared approved visual hash does not match ${spec.id}`);
          }
          return { path: prepared.relativePath, contents };
        });
        const runDirectory = `qa/run-${round}`;
        const pages = preparation.renderedPages.map((page, index) => {
          if (basename(page.fileName) !== page.fileName || !/^rendered-\d+\.png$/.test(page.fileName)) {
            throw new Error(`Prepared rendered page ${index + 1} has an invalid file name`);
          }
          const contents = decodeBase64(page.contentsBase64, `rendered page ${index + 1}`);
          try {
            PNG.sync.read(Buffer.from(contents));
          } catch {
            throw new Error(`Prepared rendered page ${index + 1} is not a decodable PNG`);
          }
          const relativePath = `${runDirectory}/${page.fileName}`;
          writes.push(createWrite(relativePath, contents, 'qa-rendered-page', receipt.specVersionId));
          return { path: relativePath, contents };
        });
        const comparisons = await new PngPixelPageComparator().compare(pages, approvedVisuals);
        const blankPages = comparisons.flatMap((comparison, index) => comparison.blank ? [index + 1] : []);
        const fontChecks = inspection.fonts.map((font) => ({
          font,
          available: preparation.fontAvailability[font] === true,
        }));
        const issues = [
          ...(inspection.slideCount === specs.length ? [] : [
            `OOXML slide count mismatch: expected ${specs.length}, found ${inspection.slideCount}`,
          ]),
          ...inspection.missingResources.map((path) => `Missing OOXML resource: ${path}`),
          ...inspection.outOfBoundsObjects.map((id) => `Out-of-bounds slide object: ${id}`),
          ...inspection.cropIssues.map((id) => `Invalid image crop: ${id}`),
          ...fontChecks.filter(({ available }) => !available).map(({ font }) => `Unavailable font: ${font}`),
          ...(blankPages.length === 0 ? [] : [`Blank rendered pages: ${blankPages.join(', ')}`]),
          ...comparisons.flatMap((comparison, index) =>
            comparison.differenceScore !== undefined && comparison.differenceScore > 0.6
              ? [`Visual difference exceeds threshold on page ${index + 1}: ${comparison.differenceScore}`]
              : []),
        ];
        const pdfBytes = decodeBase64(preparation.pdfBase64, 'rendered PDF');
        const exportStem = basename(receipt.relativePath, '.pptx');
        const pdfRelativePath = `${runDirectory}/${exportStem}.pdf`;
        writes.unshift(createWrite(pdfRelativePath, pdfBytes, 'qa-pdf', receipt.specVersionId));
        const report = createNativeQaReport(state, round, {
          status: issues.length === 0 ? 'passed' : 'failed',
          sofficePath: preparation.sofficePath,
          rendererPath: preparation.rendererPath,
          pdfPath: pdfRelativePath,
          renderedPages: pages.map(({ path }) => path),
          actualPageCount: pages.length,
          blankPages,
          comparisons,
          fontChecks,
          outOfBoundsObjects: inspection.outOfBoundsObjects,
          cropIssues: inspection.cropIssues,
          missingResources: inspection.missingResources,
          issues,
        });
        writes.push(...qaReportWrites(report));
        state.qaReport = report;
        if (report.status === 'passed') {
          state.project.workflowStatus = 'completed';
          message = 'LibreOffice 自动 QA 已通过，交付物可用。';
        } else {
          state.project.workflowStatus = 'blocked';
          state.blockedCondition = {
            kind: 'capability_unavailable',
            capability: 'qa-rendering',
            recoverable: true,
            resumeStage: 'qa',
            message: `QA 未通过：${issues.join('；')}`,
          };
          message = state.blockedCondition.message;
        }
        break;
      }
      default:
        throw new Error(`Unknown native pipeline action: ${String((action as { kind?: unknown }).kind)}`);
    }
    const taskKind = taskKindFor(action.kind);
    if (taskKind) {
      state.tasks.push({
        id: `${projectId}-task-${state.revision + 1}-${taskKind}`,
        kind: taskKind,
        status: state.project.workflowStatus === 'blocked' ? 'blocked' : 'completed',
        createdAt: action.at,
        updatedAt: action.at,
        error: state.blockedCondition?.message ?? null,
      });
    }
    state.revision += 1;
    state.project.updatedAt = action.at;
    validatePipeline(state);
    this.#projects.set(projectId, structuredClone(state));
    return { pipeline: structuredClone(state), writes, message };
  }

  #require(projectId: string): NativePptPipeline {
    const state = this.#projects.get(projectId);
    if (!state) throw new Error(`Unknown native PPT project: ${projectId}`);
    return state;
  }
}

function taskKindFor(kind: NativePipelineAction['kind']): NativeTaskRecord['kind'] | null {
  switch (kind) {
    case 'analysis.commit': return 'source_analysis';
    case 'outline.submit': return 'outline_generation';
    case 'details.submit': return 'detail_generation';
    case 'visual.generate': return 'visual_generation';
    case 'deck.export': return 'conversion';
    case 'deck.qa': return 'qa';
    default: return null;
  }
}

function createNativeQaReport(
  state: NativePptPipeline,
  round: number,
  values: Partial<LibreOfficeQaReport>,
): LibreOfficeQaReport {
  const receipt = state.exportReceipt!;
  return {
    status: 'blocked',
    round,
    projectId: state.project.id,
    exportPath: receipt.relativePath,
    exportSha256: receipt.sha256,
    specVersionId: receipt.specVersionId,
    visualVersionIds: structuredClone(receipt.visualVersionIds),
    sofficePath: null,
    rendererPath: null,
    pdfPath: null,
    renderedPages: [],
    expectedPageCount: state.slideSpecs!.value.length,
    actualPageCount: 0,
    blankPages: [],
    comparisons: [],
    issues: [],
    jsonReportPath: `qa/qa-round-${round}.json`,
    textReportPath: `qa/qa-round-${round}.txt`,
    ...values,
  };
}

function qaReportWrites(report: LibreOfficeQaReport): NativeArtifactWrite[] {
  const readable = `${formatQaReadableSummary(report)}\n`;
  const serialized = `${JSON.stringify({ ...report, readableSummary: readable.trimEnd() }, null, 2)}\n`;
  return [
    createWrite(report.textReportPath, new TextEncoder().encode(readable), 'qa-report-text', report.specVersionId),
    createWrite(report.jsonReportPath, new TextEncoder().encode(serialized), 'qa-report-json', report.specVersionId),
  ];
}

function decodeBase64(value: string, label: string): Uint8Array {
  if (typeof value !== 'string' || value.length === 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error(`${label} is not valid base64`);
  }
  return new Uint8Array(Buffer.from(value, 'base64'));
}

async function replaceVisual(
  state: NativePptPipeline,
  writes: NativeArtifactWrite[],
  input: {
    slideId: string;
    at: string;
    imageBase64: string;
    altText: string;
    usage: NativeVisualVersion['usage'];
    textFree: boolean;
  },
): Promise<{ message: string }> {
  if (state.project.workflowStatus === 'blocked') {
    if (state.blockedCondition?.slideId !== input.slideId) {
      throw new Error('Replacement does not match the recoverable blocked slide');
    }
    state.project.workflowStatus = 'visual_review';
    state.blockedCondition = null;
  }
  requireCurrentSlide(state, input.slideId);
  const existing = currentVisual(state, input.slideId);
  if (existing?.version.status === 'frozen') {
    throw new Error('Approved visual must be reopened before replacement');
  }
  const image = new Uint8Array(Buffer.from(input.imageBase64, 'base64'));
  try {
    PNG.sync.read(Buffer.from(image));
  } catch {
    throw new Error('Replacement visual must be a decodable PNG');
  }
  const reuseReopenedDraft = existing?.relativePath === '' && existing.byteLength === 0;
  const sequence = reuseReopenedDraft
    ? existing.version.sequence
    : (existing?.version.sequence ?? 0) + 1;
  const version: Version = {
    id: `${state.project.id}-visual-${input.slideId}-v${sequence}`,
    projectId: state.project.id,
    sequence,
    status: 'draft',
    createdAt: reuseReopenedDraft ? existing!.version.createdAt : input.at,
    frozenAt: null,
  };
  const relativePath = `visuals/${input.slideId}-v${sequence}.png`;
  const write = createWrite(
    relativePath,
    image,
    'approved-visual-candidate',
    version.id,
    input.slideId,
    { usage: input.usage, textFree: input.textFree, altText: input.altText },
  );
  writes.push(write);
  const candidate = {
    slideId: input.slideId,
    version,
    relativePath,
    sha256: write.sha256,
    byteLength: write.byteLength,
    usage: input.usage,
    textFree: input.textFree,
    altText: input.altText,
  };
  const history = (state.visuals[input.slideId] ??= []);
  if (reuseReopenedDraft) {
    history[history.length - 1] = candidate;
  } else {
    history.push(candidate);
  }
  return { message: '视觉候选已保存，等待当前页审批。' };
}

async function replayPipeline(
  state: NativePptPipeline,
  expected: WorkflowStatus,
) {
  const artifacts = new MemoryArtifacts();
  const workflow = createIsolatedPptWorkflow(artifacts);
  await workflow.projects.createProject({
    id: state.project.id,
    name: state.project.name,
    createdAt: state.project.createdAt,
  });
  for (const source of state.sources) {
    await workflow.projects.attachSource(state.project.id, {
      id: source.id,
      fileName: source.fileName,
      mediaType: source.mediaType,
      contents: new Uint8Array([1]),
    });
  }
  if (state.analysis) {
    const service = workflow.sourceAnalysis({
      analyze: async () => structuredClone(state.analysis!.output),
    });
    await service.request({
      id: state.analysis.requestId,
      projectId: state.project.id,
      sourceIds: state.sources.map(({ id }) => id),
    });
    await service.execute(state.analysis.requestId);
  }
  if (state.outline) {
    await workflow.projects.submitOutline(state.project.id, state.outline.value);
    if (state.outline.version.status === 'frozen') {
      workflow.projects.approveOutline(
        state.project.id,
        state.outline.version.frozenAt ?? state.project.updatedAt,
      );
    }
  }
  if (state.slideSpecs) {
    await workflow.projects.submitSlideSpecs(state.project.id, state.slideSpecs.value);
    if (state.slideSpecs.version.status === 'frozen') {
      workflow.projects.approveSlideSpecs(
        state.project.id,
        state.slideSpecs.version.frozenAt ?? state.project.updatedAt,
      );
    }
  }
  if (state.slideSpecs?.version.status === 'frozen') {
    const visuals = workflow.visualGeneration({
      capability: async () => ({ id: 'image_gen.imagegen', status: 'available' }),
      generate: async (request) => ({
        status: 'generated',
        image: onePixelPng(),
        mediaType: 'image/png',
        usage: currentVisual(state, request.slideId)?.usage ?? 'full_slide_reference',
        textFree: currentVisual(state, request.slideId)?.textFree ?? false,
        altText: currentVisual(state, request.slideId)?.altText ?? 'restored visual',
      }),
    });
    for (const spec of state.slideSpecs.value) {
      const history = state.visuals[spec.id] ?? [];
      if (history.length === 0) break;
      for (const [index, visual] of history.entries()) {
        if (index > 0) {
          workflow.projects.reopenApprovedSlide(
            state.project.id, spec.id, visual.version.createdAt,
          );
        }
        await visuals.generate(state.project.id, spec.id);
        if (visual.version.status === 'frozen') {
          workflow.projects.approveSlideVisual(
            state.project.id,
            spec.id,
            visual.version.frozenAt ?? state.project.updatedAt,
          );
        }
      }
    }
    if (['conversion', 'qa', 'completed'].includes(expected)) {
      workflow.projects.completeVisualReview(state.project.id);
    }
  }
  const actual = workflow.projects.getProjectSnapshot(state.project.id).project.workflowStatus;
  if (
    ['qa', 'completed'].includes(expected) &&
    actual === 'conversion' &&
    state.exportReceipt
  ) {
    return workflow;
  }
  if (actual !== expected) {
    throw new Error(`Persisted pipeline cannot replay ${expected}; reached ${actual}`);
  }
  return workflow;
}

function currentVisual(state: NativePptPipeline, slideId: string): NativeVisualVersion | undefined {
  return state.visuals[slideId]?.at(-1);
}

class MemoryArtifacts implements WorkspaceArtifactAccess {
  readonly #files = new Map<string, Uint8Array>();
  async initializeProject(): Promise<void> {}
  async projectDirectory(projectId: string): Promise<string> { return `/memory/${projectId}`; }
  async ensureDirectory(projectId: string, relativePath: string): Promise<string> {
    return `/memory/${projectId}/${relativePath}`;
  }
  async write(projectId: string, relativePath: string, contents: string | Uint8Array): Promise<string> {
    const bytes = typeof contents === 'string' ? new TextEncoder().encode(contents) : new Uint8Array(contents);
    this.#files.set(`${projectId}/${relativePath}`, bytes);
    return `/memory/${projectId}/${relativePath}`;
  }
  async read(projectId: string, relativePath: string): Promise<Uint8Array> {
    const bytes = this.#files.get(`${projectId}/${relativePath}`);
    if (!bytes) throw new Error(`Missing memory artifact: ${relativePath}`);
    return new Uint8Array(bytes);
  }
  async resolvePath(projectId: string, relativePath: string): Promise<string> {
    return `/memory/${projectId}/${relativePath}`;
  }
  async list(projectId: string, relativeDirectory: string): Promise<readonly string[]> {
    const prefix = `${projectId}/${relativeDirectory}/`;
    return [...this.#files.keys()].filter((item) => item.startsWith(prefix));
  }
}

function requireRecordValue(value: unknown, field: string): Record<string, unknown> {
  if (!isRecordValue(value)) throw new Error(`${field} must be an object`);
  return value;
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireStringValue(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${field} must be a non-empty string`);
  return value;
}

function requireExactKeys(value: Record<string, unknown>, keys: readonly string[], field: string): void {
  const expected = new Set(keys);
  const actual = Object.keys(value);
  if (actual.length !== expected.size || actual.some((key) => !expected.has(key))) {
    throw new Error(`${field} contains missing or unknown fields`);
  }
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`${field} must be a string array`);
  }
  return value;
}

function requireBase64Value(value: unknown, field: string): string {
  const encoded = requireStringValue(value, field);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new Error(`${field} must be canonical base64`);
  }
  return encoded;
}

function validateSourceAnalysisValue(value: unknown): asserts value is SourceAnalysis {
  const analysis = requireRecordValue(value, 'source analysis');
  requireExactKeys(analysis, ['findings', 'dataPoints', 'sourceMap'], 'source analysis');
  if (!Array.isArray(analysis.findings) || !Array.isArray(analysis.dataPoints) || !Array.isArray(analysis.sourceMap)) {
    throw new Error('Source analysis collections are invalid');
  }
  const findingIds = new Set<string>();
  for (const itemValue of analysis.findings) {
    const item = requireRecordValue(itemValue, 'source finding');
    requireExactKeys(item, ['id', 'text', 'sourceIds'], 'source finding');
    const id = requireStringValue(item.id, 'source finding id');
    requireIdentifier(id, 'finding id');
    if (findingIds.has(id)) throw new Error('Source finding identifiers must be unique');
    findingIds.add(id);
    requireStringValue(item.text, 'source finding text');
    requireStringArray(item.sourceIds, 'source finding sourceIds');
  }
  const dataPointIds = new Set<string>();
  for (const itemValue of analysis.dataPoints) {
    const item = requireRecordValue(itemValue, 'source data point');
    const allowed = ['id', 'label', 'value', ...(itemValue.unit === undefined ? [] : ['unit']),
      ...(itemValue.sourceIds === undefined ? [] : ['sourceIds'])];
    requireExactKeys(item, allowed, 'source data point');
    const id = requireStringValue(item.id, 'source data point id');
    requireIdentifier(id, 'data point id');
    if (dataPointIds.has(id)) throw new Error('Source data point identifiers must be unique');
    dataPointIds.add(id);
    requireStringValue(item.label, 'source data point label');
    if (typeof item.value !== 'string' && (typeof item.value !== 'number' || !Number.isFinite(item.value))) {
      throw new Error('Source data point value is invalid');
    }
    if (item.unit !== undefined) requireStringValue(item.unit, 'source data point unit');
    if (item.sourceIds !== undefined) requireStringArray(item.sourceIds, 'source data point sourceIds');
  }
  const citationIds = new Set<string>();
  for (const citationValue of analysis.sourceMap) {
    const citation = requireRecordValue(citationValue, 'source citation');
    requireExactKeys(citation, ['sourceId', 'title', 'locator', ...(citation.url === undefined ? [] : ['url'])], 'source citation');
    const sourceId = requireStringValue(citation.sourceId, 'source citation sourceId');
    requireIdentifier(sourceId, 'source id');
    if (citationIds.has(sourceId)) throw new Error('Source analysis citations must be unique');
    citationIds.add(sourceId);
    requireStringValue(citation.title, 'source citation title');
    requireStringValue(citation.locator, 'source citation locator');
    if (citation.url !== undefined) requireStringValue(citation.url, 'source citation url');
  }
}

function validateOutlineValue(value: unknown): asserts value is PptOutline {
  const outline = requireRecordValue(value, 'outline');
  requireExactKeys(outline, ['title', 'slides'], 'outline');
  requireStringValue(outline.title, 'outline title');
  if (!Array.isArray(outline.slides) || outline.slides.length === 0) throw new Error('Outline slides are required');
  const ids = new Set<string>();
  for (const slideValue of outline.slides) {
    const slide = requireRecordValue(slideValue, 'outline slide');
    requireExactKeys(slide, ['id', 'title', 'purpose',
      ...(slide.sourceIds === undefined ? [] : ['sourceIds']),
      ...(slide.findingIds === undefined ? [] : ['findingIds']),
      ...(slide.dataPointIds === undefined ? [] : ['dataPointIds'])], 'outline slide');
    const id = requireStringValue(slide.id, 'outline slide id');
    requireIdentifier(id, 'slide id');
    if (ids.has(id)) throw new Error('Outline slide identifiers must be unique');
    ids.add(id);
    requireStringValue(slide.title, 'outline slide title');
    requireStringValue(slide.purpose, 'outline slide purpose');
    if (slide.sourceIds !== undefined) requireStringArray(slide.sourceIds, 'outline slide sourceIds');
    if (slide.findingIds !== undefined) requireStringArray(slide.findingIds, 'outline slide findingIds');
    if (slide.dataPointIds !== undefined) requireStringArray(slide.dataPointIds, 'outline slide dataPointIds');
  }
}

function validateSlideSpecsValue(value: unknown): asserts value is readonly SlideSpec[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('Slide specs must be a non-empty array');
  const ids = new Set<string>();
  for (const specValue of value) {
    const spec = requireRecordValue(specValue, 'slide spec');
    requireExactKeys(spec, ['id', 'title', 'body', 'tables', 'charts', 'shapes', 'sourceMap', 'imageGenerationBrief',
      ...(spec.findingIds === undefined ? [] : ['findingIds']),
      ...(spec.dataPointIds === undefined ? [] : ['dataPointIds'])], 'slide spec');
    const id = requireStringValue(spec.id, 'slide spec id');
    requireIdentifier(id, 'slide id');
    if (ids.has(id)) throw new Error('Slide spec identifiers must be unique');
    ids.add(id);
    requireStringValue(spec.title, 'slide spec title');
    requireStringArray(spec.body, 'slide spec body');
    if (spec.findingIds !== undefined) requireStringArray(spec.findingIds, 'slide spec findingIds');
    if (spec.dataPointIds !== undefined) requireStringArray(spec.dataPointIds, 'slide spec dataPointIds');
    if (!Array.isArray(spec.tables) || !Array.isArray(spec.charts) || !Array.isArray(spec.shapes)
      || !Array.isArray(spec.sourceMap)) throw new Error('Slide spec nested collections are invalid');
    requireStringValue(spec.imageGenerationBrief, 'slide spec imageGenerationBrief');
    const nestedIds = new Set<string>();
    for (const tableValue of spec.tables) {
      const table = requireRecordValue(tableValue, 'slide table');
      requireExactKeys(table, ['id', 'headers', 'rows'], 'slide table');
      const nestedId = requireStringValue(table.id, 'slide table id');
      requireIdentifier(nestedId, 'slide object id');
      if (nestedIds.has(nestedId)) throw new Error('Slide nested identifiers must be unique');
      nestedIds.add(nestedId);
      const headers = requireStringArray(table.headers, 'slide table headers');
      if (!Array.isArray(table.rows) || !table.rows.every((row) => Array.isArray(row)
        && row.length === headers.length && row.every((cell) => typeof cell === 'string'))) {
        throw new Error('Slide table rows are invalid');
      }
    }
    for (const chartValue of spec.charts) {
      const chart = requireRecordValue(chartValue, 'slide chart');
      requireExactKeys(chart, ['id', 'type', 'categories', 'series'], 'slide chart');
      const nestedId = requireStringValue(chart.id, 'slide chart id');
      requireIdentifier(nestedId, 'slide object id');
      if (nestedIds.has(nestedId)) throw new Error('Slide nested identifiers must be unique');
      nestedIds.add(nestedId);
      if (!['bar', 'line', 'pie'].includes(String(chart.type))) throw new Error('Slide chart type is invalid');
      const categories = requireStringArray(chart.categories, 'slide chart categories');
      if (!Array.isArray(chart.series) || !chart.series.every((seriesValue) => {
        if (!isRecordValue(seriesValue)) return false;
        try { requireExactKeys(seriesValue, ['name', 'values'], 'chart series'); } catch { return false; }
        return typeof seriesValue.name === 'string' && Array.isArray(seriesValue.values)
          && seriesValue.values.length === categories.length && seriesValue.values.every(Number.isFinite);
      })) throw new Error('Slide chart series are invalid');
    }
    for (const shapeValue of spec.shapes) {
      const shape = requireRecordValue(shapeValue, 'slide shape');
      requireExactKeys(shape, ['id', 'type', 'x', 'y', 'w', 'h',
        ...(shape.fill === undefined ? [] : ['fill']), ...(shape.line === undefined ? [] : ['line']),
        ...(shape.text === undefined ? [] : ['text'])], 'slide shape');
      const nestedId = requireStringValue(shape.id, 'slide shape id');
      requireIdentifier(nestedId, 'slide object id');
      if (nestedIds.has(nestedId)) throw new Error('Slide nested identifiers must be unique');
      nestedIds.add(nestedId);
      if (!['rect', 'ellipse', 'line'].includes(String(shape.type))
        || ![shape.x, shape.y, shape.w, shape.h].every((number) => typeof number === 'number' && Number.isFinite(number) && number >= 0)) {
        throw new Error('Slide shape geometry is invalid');
      }
      for (const optional of [shape.fill, shape.line, shape.text]) {
        if (optional !== undefined && typeof optional !== 'string') throw new Error('Slide shape style is invalid');
      }
    }
    for (const citation of spec.sourceMap) validateCitationValue(citation);
  }
}

function validateCitationValue(value: unknown): void {
  const citation = requireRecordValue(value, 'slide citation');
  requireExactKeys(citation, ['sourceId', 'title', 'locator', ...(citation.url === undefined ? [] : ['url'])], 'slide citation');
  requireIdentifier(requireStringValue(citation.sourceId, 'slide citation sourceId'), 'source id');
  requireStringValue(citation.title, 'slide citation title');
  requireStringValue(citation.locator, 'slide citation locator');
  if (citation.url !== undefined) requireStringValue(citation.url, 'slide citation url');
}

function validateQaPreparationValue(value: unknown): asserts value is NativeQaPreparation {
  const preparation = requireRecordValue(value, 'QA preparation');
  if (preparation.status === 'blocked' || preparation.status === 'failed') {
    requireExactKeys(preparation, ['status', 'issue', ...(preparation.capability === undefined ? [] : ['capability'])], 'QA preparation');
    requireStringValue(preparation.issue, 'QA issue');
    if (preparation.capability !== undefined && !['libreoffice', 'pdf-renderer', 'qa-rendering'].includes(String(preparation.capability))) {
      throw new Error('QA capability is invalid');
    }
    return;
  }
  if (preparation.status !== 'ready') throw new Error('QA preparation status is invalid');
  requireExactKeys(preparation, ['status', 'sofficePath', 'rendererPath', 'pptxBase64', 'pdfBase64',
    'renderedPages', 'approvedVisuals', 'fontAvailability'], 'QA preparation');
  requireStringValue(preparation.sofficePath, 'QA sofficePath');
  requireStringValue(preparation.rendererPath, 'QA rendererPath');
  requireBase64Value(preparation.pptxBase64, 'QA pptxBase64');
  requireBase64Value(preparation.pdfBase64, 'QA pdfBase64');
  if (!Array.isArray(preparation.renderedPages) || !Array.isArray(preparation.approvedVisuals)) {
    throw new Error('QA page collections are invalid');
  }
  for (const pageValue of preparation.renderedPages) {
    const page = requireRecordValue(pageValue, 'QA rendered page');
    requireExactKeys(page, ['fileName', 'contentsBase64'], 'QA rendered page');
    requireStringValue(page.fileName, 'QA rendered page fileName');
    requireBase64Value(page.contentsBase64, 'QA rendered page contents');
  }
  for (const visualValue of preparation.approvedVisuals) {
    const visual = requireRecordValue(visualValue, 'QA approved visual');
    requireExactKeys(visual, ['slideId', 'relativePath', 'contentsBase64'], 'QA approved visual');
    requireIdentifier(requireStringValue(visual.slideId, 'QA visual slideId'), 'slide id');
    requireStringValue(visual.relativePath, 'QA visual relativePath');
    requireBase64Value(visual.contentsBase64, 'QA visual contents');
  }
  const fonts = requireRecordValue(preparation.fontAvailability, 'QA fontAvailability');
  if (Object.values(fonts).some((available) => typeof available !== 'boolean')) throw new Error('QA font availability is invalid');
}

function validateVersionValue(value: unknown, projectId: string, expectedId: string, sequence: number): void {
  const version = requireRecordValue(value, 'version');
  requireExactKeys(version, ['id', 'projectId', 'sequence', 'status', 'createdAt', 'frozenAt'], 'version');
  if (version.id !== expectedId || version.projectId !== projectId || version.sequence !== sequence
    || !['draft', 'frozen'].includes(String(version.status)) || typeof version.createdAt !== 'string'
    || (version.status === 'draft' && version.frozenAt !== null)
    || (version.status === 'frozen' && typeof version.frozenAt !== 'string')) {
    throw new Error('Version provenance is invalid');
  }
}

function validateSourceAnalysisReferences(analysis: SourceAnalysis, sourceIds: ReadonlySet<string>): void {
  const cited = new Set(analysis.sourceMap.map(({ sourceId }) => sourceId));
  for (const sourceId of cited) if (!sourceIds.has(sourceId)) throw new Error('Analysis cites an unattached source');
  for (const item of [...analysis.findings, ...analysis.dataPoints]) {
    for (const sourceId of item.sourceIds ?? []) {
      if (!sourceIds.has(sourceId) || !cited.has(sourceId)) throw new Error('Analysis evidence references an unattached source');
    }
  }
}

function validateOutlineReferences(outline: PptOutline, analysis: SourceAnalysis): void {
  const sources = new Set(analysis.sourceMap.map(({ sourceId }) => sourceId));
  const findings = new Set(analysis.findings.map(({ id }) => id));
  const dataPoints = new Set(analysis.dataPoints.map(({ id }) => id));
  for (const slide of outline.slides) {
    if ((slide.sourceIds ?? []).some((id) => !sources.has(id))
      || (slide.findingIds ?? []).some((id) => !findings.has(id))
      || (slide.dataPointIds ?? []).some((id) => !dataPoints.has(id))) {
      throw new Error('Outline provenance references unknown analysis evidence');
    }
  }
}

function validateSlideSpecReferences(specs: readonly SlideSpec[], analysis: SourceAnalysis): void {
  const sources = new Set(analysis.sourceMap.map(({ sourceId }) => sourceId));
  const findings = new Set(analysis.findings.map(({ id }) => id));
  const dataPoints = new Set(analysis.dataPoints.map(({ id }) => id));
  for (const spec of specs) {
    if (spec.sourceMap.some(({ sourceId }) => !sources.has(sourceId))
      || (spec.findingIds ?? []).some((id) => !findings.has(id))
      || (spec.dataPointIds ?? []).some((id) => !dataPoints.has(id))) {
      throw new Error('Slide-spec provenance references unknown analysis evidence');
    }
  }
}

function validateCheckpointShape(value: NativePptPipeline, specIds: ReadonlySet<string>): void {
  let effective = value.project.workflowStatus;
  if (value.project.workflowStatus === 'blocked') {
    const blocked = requireRecordValue(value.blockedCondition, 'blocked condition');
    requireExactKeys(blocked, ['kind', 'capability', 'recoverable', 'resumeStage', 'message',
      ...(blocked.slideId === undefined ? [] : ['slideId'])], 'blocked condition');
    if (blocked.kind !== 'capability_unavailable' || blocked.recoverable !== true
      || !['visual_review', 'qa'].includes(String(blocked.resumeStage))
      || !['image_gen.imagegen', 'libreoffice', 'pdf-renderer', 'qa-rendering'].includes(String(blocked.capability))
      || typeof blocked.message !== 'string') throw new Error('Blocked checkpoint is invalid');
    effective = blocked.resumeStage as WorkflowStatus;
    if (effective === 'visual_review' && (blocked.capability !== 'image_gen.imagegen'
      || typeof blocked.slideId !== 'string' || blocked.slideId !== value.currentSlideId)) {
      throw new Error('Visual blocked checkpoint provenance is invalid');
    }
    if (effective === 'qa' && blocked.slideId !== undefined) throw new Error('QA blocked checkpoint cannot bind a slide');
  } else if (value.blockedCondition !== null) {
    throw new Error('Non-blocked project cannot retain a blocked condition');
  }
  const rank = ['intake', 'source_analysis', 'outline_review', 'detail_review', 'visual_review', 'conversion', 'qa', 'completed'].indexOf(effective);
  if (rank < 0) throw new Error('Checkpoint stage is invalid');
  if ((rank >= 1) !== Boolean(value.analysis)) throw new Error('Checkpoint analysis milestone is inconsistent');
  if ((rank >= 2) !== Boolean(value.outline)) throw new Error('Checkpoint outline milestone is inconsistent');
  if (effective === 'outline_review' && value.outline?.version.status !== 'draft') throw new Error('Outline review requires a draft outline');
  if (rank >= 3 && value.outline?.version.status !== 'frozen') throw new Error('Later checkpoints require a frozen outline');
  if (rank < 3 && value.slideSpecs !== null) throw new Error('Slide specs exist before detail review');
  if (effective === 'detail_review' && value.slideSpecs?.version.status === 'frozen') throw new Error('Detail review cannot contain frozen specs');
  if (rank >= 4 && value.slideSpecs?.version.status !== 'frozen') throw new Error('Later checkpoints require frozen slide specs');
  if (rank < 4 && (Object.keys(value.visuals).length > 0 || value.currentSlideId !== null)) {
    throw new Error('Visual state exists before visual review');
  }
  if (rank >= 4 && (typeof value.currentSlideId !== 'string' || !specIds.has(value.currentSlideId))) {
    throw new Error('Visual checkpoint current slide is invalid');
  }
  const allVisualsFrozen = [...specIds].every((slideId) => currentVisual(value, slideId)?.version.status === 'frozen');
  if (rank >= 5 && !allVisualsFrozen) throw new Error('Conversion and later checkpoints require every visual approval');
  if (rank < 6 && value.exportReceipt !== null) throw new Error('Export receipt exists before QA');
  if (rank >= 6) validateExportReceiptValue(value);
  if (rank < 7 && effective !== 'qa' && value.qaReport !== null) throw new Error('QA report exists before QA');
  if (effective === 'qa' && value.project.workflowStatus !== 'blocked' && value.qaReport !== null) {
    throw new Error('Active QA checkpoint cannot contain a prior report');
  }
  if (value.project.workflowStatus === 'blocked' && effective === 'qa') {
    validateQaReportValue(value, false);
  } else if (effective === 'completed') {
    validateQaReportValue(value, true);
  } else if (value.qaReport !== null) {
    throw new Error('Checkpoint contains an unexpected QA report');
  }
}

function validateExportReceiptValue(value: NativePptPipeline): void {
  const receipt = requireRecordValue(value.exportReceipt, 'export receipt') as unknown as NativeExportReceipt;
  requireExactKeys(receipt as unknown as Record<string, unknown>, [
    'relativePath', 'sha256', 'byteLength', 'specVersionId', 'visualVersionIds',
  ], 'export receipt');
  if (!value.slideSpecs || receipt.relativePath !== `exports/${basename(receipt.relativePath)}`
    || !/\.pptx$/i.test(receipt.relativePath) || !/^[a-f0-9]{64}$/.test(receipt.sha256)
    || !Number.isSafeInteger(receipt.byteLength) || receipt.byteLength <= 0
    || receipt.specVersionId !== value.slideSpecs.version.id) throw new Error('Export receipt provenance is invalid');
  const visualIds = requireRecordValue(receipt.visualVersionIds, 'export visual versions');
  const specs = value.slideSpecs.value;
  if (Object.keys(visualIds).length !== specs.length || specs.some(({ id }) => visualIds[id] !== currentVisual(value, id)?.version.id)) {
    throw new Error('Export receipt visual provenance is invalid');
  }
}

function validateQaReportValue(value: NativePptPipeline, mustPass: boolean): void {
  const report = requireRecordValue(value.qaReport, 'QA report') as unknown as LibreOfficeQaReport;
  const receipt = value.exportReceipt!;
  if (report.projectId !== value.project.id || report.exportPath !== receipt.relativePath
    || report.exportSha256 !== receipt.sha256 || report.specVersionId !== receipt.specVersionId
    || JSON.stringify(report.visualVersionIds) !== JSON.stringify(receipt.visualVersionIds)
    || !Number.isSafeInteger(report.round) || report.round < 1
    || report.expectedPageCount !== value.slideSpecs!.value.length
    || !Array.isArray(report.renderedPages) || !Array.isArray(report.blankPages)
    || !Array.isArray(report.comparisons) || !Array.isArray(report.issues)
    || report.jsonReportPath !== `qa/qa-round-${report.round}.json`
    || report.textReportPath !== `qa/qa-round-${report.round}.txt`) {
    throw new Error('QA report provenance is invalid');
  }
  if (mustPass) {
    const approvedPaths = value.slideSpecs!.value.map(({ id }) => currentVisual(value, id)!.relativePath);
    if (report.status !== 'passed' || report.actualPageCount !== report.expectedPageCount
      || report.renderedPages.length !== report.expectedPageCount
      || report.comparisons.length !== report.expectedPageCount || report.blankPages.length !== 0
      || report.issues.length !== 0 || !report.sofficePath || !report.rendererPath || !report.pdfPath
      || report.comparisons.some((comparison, index) => comparison.blank
        || comparison.approvedVisualPath !== approvedPaths[index]
        || typeof comparison.differenceScore !== 'number' || comparison.differenceScore > 0.6)) {
      throw new Error('Completed checkpoint lacks a passing QA proof');
    }
  } else if (!['blocked', 'failed'].includes(report.status)) {
    throw new Error('Blocked QA checkpoint has an invalid report status');
  }
}

async function validateRestoredPipeline(value: NativePptPipeline): Promise<void> {
  const expected = value.project.workflowStatus === 'blocked'
    ? value.blockedCondition!.resumeStage
    : value.project.workflowStatus;
  await replayPipeline(value, expected);
}

function validatePipeline(value: NativePptPipeline): void {
  if (!isRecordValue(value) || value.schemaVersion !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 1) {
    throw new Error('Native PPT pipeline schema is invalid');
  }
  requireExactKeys(value, [
    'schemaVersion', 'revision', 'project', 'preferenceSnapshot', 'sources', 'analysis',
    'outline', 'slideSpecs', 'visuals', 'currentSlideId', 'approvals', 'tasks',
    'blockedCondition', 'exportReceipt', 'qaReport',
  ], 'pipeline');
  const project = requireRecordValue(value.project, 'project');
  requireExactKeys(project, ['id', 'name', 'goal', 'workflowStatus', 'createdAt', 'updatedAt'], 'project');
  requireIdentifier(value.project.id, 'project id');
  requireNonEmpty(value.project.name, 'project name');
  requireNonEmpty(value.project.goal, 'project goal');
  requireStringValue(value.project.createdAt, 'project.createdAt');
  requireStringValue(value.project.updatedAt, 'project.updatedAt');
  const stages = ['intake', 'source_analysis', 'outline_review', 'detail_review', 'visual_review', 'conversion', 'qa', 'completed', 'blocked'];
  if (!stages.includes(value.project.workflowStatus)) throw new Error('Native PPT workflow status is invalid');
  if (!Array.isArray(value.preferenceSnapshot) || !Array.isArray(value.sources)
    || !Array.isArray(value.approvals) || !Array.isArray(value.tasks)) {
    throw new Error('Native PPT pipeline collections are invalid');
  }
  const preferenceIds = new Set<string>();
  for (const preference of value.preferenceSnapshot) {
    const item = requireRecordValue(preference, 'preference snapshot');
    requireExactKeys(item, ['proposalId', 'title', 'content', 'approvedAt'], 'preference snapshot');
    const proposalId = requireStringValue(item.proposalId, 'preference proposalId');
    if (preferenceIds.has(proposalId)) throw new Error('Preference snapshot identifiers must be unique');
    preferenceIds.add(proposalId);
    requireStringValue(item.title, 'preference title');
    requireStringValue(item.content, 'preference content');
    requireStringValue(item.approvedAt, 'preference approvedAt');
  }
  const ids = new Set<string>();
  for (const source of value.sources) {
    const item = requireRecordValue(source, 'source');
    requireExactKeys(item, ['id', 'fileName', 'mediaType', 'relativePath', 'sha256', 'byteLength'], 'source');
    requireIdentifier(source.id, 'source id');
    if (ids.has(source.id) || basename(source.fileName) !== source.fileName
      || !source.relativePath.startsWith('sources/') || basename(source.relativePath) === source.relativePath
      || !/^[a-f0-9]{64}$/.test(source.sha256)
      || !Number.isSafeInteger(source.byteLength) || source.byteLength < 0
      || typeof source.mediaType !== 'string' || source.mediaType.length === 0) {
      throw new Error('Native source metadata is invalid');
    }
    ids.add(source.id);
  }

  if (value.analysis) {
    const analysis = requireRecordValue(value.analysis, 'analysis');
    requireExactKeys(analysis, ['requestId', 'output', 'artifactRelativePath', 'sha256'], 'analysis');
    requireIdentifier(value.analysis.requestId, 'request id');
    validateSourceAnalysisValue(value.analysis.output);
    validateSourceAnalysisReferences(value.analysis.output, ids);
    const expectedPath = `sources/${value.analysis.requestId}-analysis.json`;
    if (value.analysis.artifactRelativePath !== expectedPath) throw new Error('Analysis artifact path is invalid');
    const expectedHash = hash(jsonBytes({
      projectId: value.project.id,
      requestId: value.analysis.requestId,
      sourceIds: value.sources.map(({ id }) => id),
      output: value.analysis.output,
    }));
    if (value.analysis.sha256 !== expectedHash) throw new Error('Analysis evidence hash is invalid');
  }

  if (value.outline) {
    const outline = requireRecordValue(value.outline, 'outline version');
    requireExactKeys(outline, ['version', 'value'], 'outline version');
    validateVersionValue(value.outline.version, value.project.id, `${value.project.id}-outline-v1`, 1);
    validateOutlineValue(value.outline.value);
    if (!value.analysis) throw new Error('Outline requires validated source analysis');
    validateOutlineReferences(value.outline.value, value.analysis.output);
  }

  if (value.slideSpecs) {
    const details = requireRecordValue(value.slideSpecs, 'slide-spec version');
    requireExactKeys(details, ['version', 'value'], 'slide-spec version');
    validateVersionValue(value.slideSpecs.version, value.project.id, `${value.project.id}-slide-specs-v1`, 1);
    validateSlideSpecsValue(value.slideSpecs.value);
    if (!value.outline || value.outline.version.status !== 'frozen' || !value.analysis) {
      throw new Error('Slide specs require a frozen outline and source analysis');
    }
    const outlineIds = value.outline.value.slides.map(({ id }) => id);
    const specIds = value.slideSpecs.value.map(({ id }) => id);
    if (outlineIds.length !== specIds.length || outlineIds.some((id, index) => id !== specIds[index])) {
      throw new Error('Slide specs must preserve the approved outline order and identifiers');
    }
    validateSlideSpecReferences(value.slideSpecs.value, value.analysis.output);
  }

  const visualRecord = requireRecordValue(value.visuals, 'visuals');
  const specIds = new Set(value.slideSpecs?.value.map(({ id }) => id) ?? []);
  const frozenVisualApprovals = new Map<string, { id: string; decidedAt: string }>();
  let draftVisualCount = 0;
  for (const [slideId, historyValue] of Object.entries(visualRecord)) {
    if (!specIds.has(slideId) || !Array.isArray(historyValue) || historyValue.length === 0) {
      throw new Error('Visual history references an unknown slide');
    }
    historyValue.forEach((entry, index) => {
      const visual = requireRecordValue(entry, 'visual version') as unknown as NativeVisualVersion;
      requireExactKeys(visual as unknown as Record<string, unknown>, [
        'slideId', 'version', 'relativePath', 'sha256', 'byteLength', 'usage', 'textFree', 'altText',
      ], 'visual version');
      if (visual.slideId !== slideId) throw new Error('Visual slide identifier is inconsistent');
      const sequence = index + 1;
      validateVersionValue(visual.version, value.project.id, `${value.project.id}-visual-${slideId}-v${sequence}`, sequence);
      if (!['full_slide_reference', 'text_free_background', 'complex_visual'].includes(visual.usage)
        || typeof visual.textFree !== 'boolean' || typeof visual.altText !== 'string') {
        throw new Error('Visual metadata is invalid');
      }
      if (visual.version.status === 'frozen') {
        if (visual.relativePath !== `visuals/${slideId}-v${sequence}.png`
          || !/^[a-f0-9]{64}$/.test(visual.sha256)
          || !Number.isSafeInteger(visual.byteLength) || visual.byteLength <= 0) {
          throw new Error('Frozen visual artifact provenance is invalid');
        }
        frozenVisualApprovals.set(
          `visual_review|${visual.version.id}|${slideId}`,
          {
            id: `${value.project.id}-approval-visual-${slideId}-v${sequence}`,
            decidedAt: visual.version.frozenAt!,
          },
        );
      } else {
        draftVisualCount += 1;
        if (index !== historyValue.length - 1) throw new Error('Only the current visual version may remain draft');
        const placeholder = visual.relativePath === '' && visual.sha256 === '' && visual.byteLength === 0;
        const candidate = visual.relativePath === `visuals/${slideId}-v${sequence}.png`
          && /^[a-f0-9]{64}$/.test(visual.sha256)
          && Number.isSafeInteger(visual.byteLength) && visual.byteLength > 0;
        if (!placeholder && !candidate) throw new Error('Draft visual artifact provenance is invalid');
      }
    });
  }
  if (draftVisualCount > 1) throw new Error('Only one visual draft may be active');

  const expectedApprovals = new Map<string, { id: string; decidedAt: string }>();
  if (value.outline?.version.status === 'frozen') {
    expectedApprovals.set(`outline_review|${value.outline.version.id}|`, {
      id: `${value.project.id}-outline_review-1`,
      decidedAt: value.outline.version.frozenAt!,
    });
  }
  if (value.slideSpecs?.version.status === 'frozen') {
    expectedApprovals.set(`detail_review|${value.slideSpecs.version.id}|`, {
      id: `${value.project.id}-detail_review-2`,
      decidedAt: value.slideSpecs.version.frozenAt!,
    });
  }
  for (const [key, proof] of frozenVisualApprovals) expectedApprovals.set(key, proof);
  const approvalIds = new Set<string>();
  const actualApprovalKeys = new Set<string>();
  for (const approvalValue of value.approvals) {
    const approval = requireRecordValue(approvalValue, 'approval') as unknown as Approval;
    requireExactKeys(approval as unknown as Record<string, unknown>, [
      'id', 'projectId', 'versionId', 'stage', 'status', 'decidedAt', ...(approval.slideId === undefined ? [] : ['slideId']),
    ], 'approval');
    const key = `${approval.stage}|${approval.versionId}|${approval.slideId ?? ''}`;
    const expected = expectedApprovals.get(key);
    if (!expected || approval.id !== expected.id || approval.decidedAt !== expected.decidedAt
      || approvalIds.has(approval.id)
      || approval.projectId !== value.project.id || approval.status !== 'approved'
      || !['outline_review', 'detail_review', 'visual_review'].includes(approval.stage)
      || typeof approval.versionId !== 'string' || typeof approval.decidedAt !== 'string') {
      throw new Error('Approval provenance is invalid');
    }
    approvalIds.add(approval.id);
    actualApprovalKeys.add(key);
  }
  if (actualApprovalKeys.size !== expectedApprovals.size
    || [...expectedApprovals.keys()].some((key) => !actualApprovalKeys.has(key))) {
    throw new Error('Approvals do not exactly match frozen versions');
  }

  validateCheckpointShape(value, specIds);
  validateTaskAndRevisionProvenance(value);
}

function validateTaskAndRevisionProvenance(value: NativePptPipeline): void {
  const taskIds = new Set<string>();
  const tasksByRevision = new Map<number, NativeTaskRecord>();
  let previousRevision = 1;
  const tasks = value.tasks.map((taskValue) => {
    const task = requireRecordValue(taskValue, 'task') as unknown as NativeTaskRecord;
    requireExactKeys(task as unknown as Record<string, unknown>, [
      'id', 'kind', 'status', 'createdAt', 'updatedAt', 'error',
    ], 'task');
    const legalKinds: NativeTaskRecord['kind'][] = [
      'source_analysis', 'outline_generation', 'detail_generation',
      'visual_generation', 'conversion', 'qa',
    ];
    if (typeof task.id !== 'string' || taskIds.has(task.id)
      || !legalKinds.includes(task.kind)
      || !['completed', 'blocked'].includes(task.status)
      || typeof task.createdAt !== 'string' || task.createdAt.length === 0
      || task.updatedAt !== task.createdAt
      || (task.status === 'completed' && task.error !== null)
      || (task.status === 'blocked' && (typeof task.error !== 'string' || task.error.length === 0))
      || (task.status === 'blocked' && !['visual_generation', 'qa'].includes(task.kind))) {
      throw new Error('Task record is invalid');
    }
    const prefix = `${value.project.id}-task-`;
    const suffix = `-${task.kind}`;
    if (!task.id.startsWith(prefix) || !task.id.endsWith(suffix)) {
      throw new Error('Task provenance identifier is invalid');
    }
    const encodedRevision = task.id.slice(prefix.length, -suffix.length);
    if (!/^[1-9]\d*$/.test(encodedRevision)) {
      throw new Error('Task revision provenance is invalid');
    }
    const revision = Number(encodedRevision);
    if (!Number.isSafeInteger(revision) || revision <= previousRevision
      || revision > value.revision || tasksByRevision.has(revision)) {
      throw new Error('Task transition order is invalid');
    }
    taskIds.add(task.id);
    tasksByRevision.set(revision, task);
    previousRevision = revision;
    return { task, revision };
  });

  const byKind = (kind: NativeTaskRecord['kind']) =>
    tasks.filter(({ task }) => task.kind === kind);
  const sourceTasks = byKind('source_analysis');
  const outlineTasks = byKind('outline_generation');
  const detailTasks = byKind('detail_generation');
  const visualTasks = byKind('visual_generation');
  const conversionTasks = byKind('conversion');
  const qaTasks = byKind('qa');

  if (!value.analysis) {
    if (tasks.length !== 0 || ![1, 1 + value.sources.length].includes(value.revision)) {
      throw new Error('Intake revision provenance is invalid');
    }
    return;
  }
  if (sourceTasks.length !== 1) {
    throw new Error('Source analysis task provenance is incomplete');
  }
  const sourceRevision = sourceTasks[0]!.revision;
  const rustSourceRevision = value.sources.length + 2;
  if ((sourceRevision !== 2 && sourceRevision !== rustSourceRevision)
    || sourceTasks[0]!.task.status !== 'completed') {
    throw new Error('Source attachment revision provenance is invalid');
  }
  let cursor = sourceRevision;

  if ((value.outline === null && outlineTasks.length !== 0)
    || (value.outline !== null && outlineTasks.length === 0)) {
    throw new Error('Outline task provenance is incomplete');
  }
  for (const task of outlineTasks) {
    cursor += 1;
    if (task.revision !== cursor || task.task.status !== 'completed') {
      throw new Error('Outline task transition provenance is invalid');
    }
  }
  if (value.outline?.version.status === 'frozen') cursor += 1;

  if ((value.slideSpecs === null && detailTasks.length !== 0)
    || (value.slideSpecs !== null && detailTasks.length === 0)) {
    throw new Error('Detail task provenance is incomplete');
  }
  for (const task of detailTasks) {
    cursor += 1;
    if (task.revision !== cursor || task.task.status !== 'completed') {
      throw new Error('Detail task transition provenance is invalid');
    }
  }
  if (value.slideSpecs?.version.status === 'frozen') cursor += 1;

  if (visualTasks.length > 0 && value.slideSpecs?.version.status !== 'frozen') {
    throw new Error('Visual tasks exist before detail approval');
  }

  if ((value.exportReceipt === null && conversionTasks.length !== 0)
    || (value.exportReceipt !== null && conversionTasks.length !== 1)) {
    throw new Error('Conversion task provenance is incomplete');
  }
  const visualEndRevision = conversionTasks.length === 1
    ? conversionTasks[0]!.revision - 1
    : value.revision;
  if (value.slideSpecs?.version.status === 'frozen') {
    replayVisualActionTimeline(value, tasksByRevision, cursor + 1, visualEndRevision);
    cursor = visualEndRevision;
  } else if (visualEndRevision !== cursor) {
    throw new Error('Visual actions exist before detail approval');
  }

  if (conversionTasks.length === 1) {
    cursor += 1;
    if (conversionTasks[0]!.revision !== cursor
      || conversionTasks[0]!.task.status !== 'completed') {
      throw new Error('Conversion task transition provenance is invalid');
    }
  }

  if ((value.qaReport === null && qaTasks.length !== 0)
    || (value.qaReport !== null && qaTasks.length === 0)) {
    throw new Error('QA task provenance is incomplete');
  }
  for (const task of qaTasks) {
    cursor += 1;
    if (task.revision !== cursor) {
      throw new Error('QA task transition provenance is invalid');
    }
  }
  if (value.qaReport !== null && value.qaReport.round !== qaTasks.length) {
    throw new Error('QA report round does not match its task timeline');
  }
  if (qaTasks.slice(0, -1).some(({ task }) => task.status !== 'blocked')) {
    throw new Error('QA cannot continue after a completed task');
  }
  if (value.project.workflowStatus === 'completed'
    && qaTasks.at(-1)?.task.status !== 'completed') {
    throw new Error('Completed checkpoint lacks a completed QA task');
  }
  if (value.project.workflowStatus === 'blocked'
    && value.blockedCondition?.resumeStage === 'qa'
    && qaTasks.at(-1)?.task.status !== 'blocked') {
    throw new Error('Blocked QA checkpoint lacks a blocked QA task');
  }
  if (value.project.workflowStatus === 'blocked'
    && value.blockedCondition?.resumeStage === 'qa'
    && qaTasks.at(-1)?.task.error !== value.blockedCondition.message) {
    throw new Error('Blocked QA task does not match its recoverable condition');
  }

  if (cursor !== value.revision) {
    throw new Error('Pipeline revision does not match its legal transition provenance');
  }
  const finalTask = tasks.at(-1);
  if (finalTask?.revision === value.revision
    && finalTask.task.updatedAt !== value.project.updatedAt) {
    throw new Error('Project update timestamp does not match its final task');
  }
}

type VisualReplayEvent =
  | { kind: 'candidate'; slideIndex: number; versionIndex: number }
  | { kind: 'approve'; slideIndex: number; versionIndex: number }
  | { kind: 'reopen'; slideIndex: number; versionIndex: number };

type VisualReplayStage = 'visual_review' | 'blocked' | 'conversion';
type VisualReplayVersionState = 'none' | 'placeholder' | 'candidate' | 'frozen';

interface VisualReplayState {
  revision: number;
  stage: VisualReplayStage;
  currentSlideIndex: number;
  eventIndexes: number[];
  versionIndexes: number[];
  versionStates: VisualReplayVersionState[];
}

/**
 * Replays the only observable legacy visual actions, revision by revision.
 * Schema v1 did not journal replacement/approval/reopen actions, so those
 * actions are reconstructed from version histories while task-bearing
 * generation attempts remain fixed to their encoded revisions.  A snapshot
 * is accepted only when at least one legal state-machine execution produces
 * every persisted version and approval and reaches the persisted checkpoint.
 */
function replayVisualActionTimeline(
  value: NativePptPipeline,
  tasksByRevision: ReadonlyMap<number, NativeTaskRecord>,
  startRevision: number,
  endRevision: number,
): void {
  if (!value.slideSpecs || endRevision < startRevision - 1) {
    throw new Error('Visual action timeline boundaries are invalid');
  }
  const slideIds = value.slideSpecs.value.map(({ id }) => id);
  if (slideIds.length === 0) throw new Error('Visual action timeline has no slides');
  const events = slideIds.map((slideId, slideIndex) => {
    const history = value.visuals[slideId] ?? [];
    return history.flatMap((visual, versionIndex): VisualReplayEvent[] => {
      const result: VisualReplayEvent[] = [];
      if (versionIndex > 0) result.push({ kind: 'reopen', slideIndex, versionIndex });
      if (visual.relativePath !== '') result.push({ kind: 'candidate', slideIndex, versionIndex });
      if (visual.version.status === 'frozen') result.push({ kind: 'approve', slideIndex, versionIndex });
      return result;
    });
  });
  const initial: VisualReplayState = {
    revision: startRevision,
    stage: 'visual_review',
    currentSlideIndex: 0,
    eventIndexes: slideIds.map(() => 0),
    versionIndexes: slideIds.map(() => -1),
    versionStates: slideIds.map(() => 'none'),
  };
  const memo = new Set<string>();
  const pending: VisualReplayState[] = [initial];
  while (pending.length > 0) {
    const state = pending.pop()!;
    const key = JSON.stringify(state);
    if (memo.has(key)) continue;
    memo.add(key);
    if (state.revision > endRevision) {
      if (visualReplayMatchesCheckpoint(value, events, state)) return;
      continue;
    }

    const task = tasksByRevision.get(state.revision);
    if (task) {
      if (task.kind !== 'visual_generation' || state.stage === 'conversion') continue;
      if (task.status === 'blocked') {
        if (task.error === IMAGEGEN_UNAVAILABLE_MESSAGE) {
          pending.push({
            ...cloneVisualReplayState(state),
            revision: state.revision + 1,
            stage: 'blocked',
          });
        }
        continue;
      }
      if (task.status !== 'completed') continue;
      const event = nextVisualReplayEvent(events, state, state.currentSlideIndex);
      if (event?.kind !== 'candidate') continue;
      const visual = value.visuals[slideIds[event.slideIndex]!]![event.versionIndex]!;
      if (event.versionIndex === 0 && task.createdAt !== visual.version.createdAt) continue;
      const next = applyVisualReplayEvent(events, state, event);
      if (next !== null) pending.push({ ...next, revision: state.revision + 1 });
      continue;
    }

    for (const event of availableVisualReplayEvents(events, state)) {
      const next = applyVisualReplayEvent(events, state, event);
      if (next !== null) pending.push({ ...next, revision: state.revision + 1 });
    }
  }
  throw new Error('Visual task revisions cannot replay a legal action timeline');
}

function cloneVisualReplayState(state: VisualReplayState): VisualReplayState {
  return {
    ...state,
    eventIndexes: [...state.eventIndexes],
    versionIndexes: [...state.versionIndexes],
    versionStates: [...state.versionStates],
  };
}

function nextVisualReplayEvent(
  events: readonly VisualReplayEvent[][],
  state: VisualReplayState,
  slideIndex: number,
): VisualReplayEvent | undefined {
  return events[slideIndex]?.[state.eventIndexes[slideIndex] ?? 0];
}

function availableVisualReplayEvents(
  events: readonly VisualReplayEvent[][],
  state: VisualReplayState,
): VisualReplayEvent[] {
  const available: VisualReplayEvent[] = [];
  const current = nextVisualReplayEvent(events, state, state.currentSlideIndex);
  if (current?.kind === 'candidate' || current?.kind === 'approve') available.push(current);
  if (state.stage !== 'blocked') {
    for (let slideIndex = 0; slideIndex < events.length; slideIndex += 1) {
      const event = nextVisualReplayEvent(events, state, slideIndex);
      if (event?.kind === 'reopen') available.push(event);
    }
  }
  return available;
}

function applyVisualReplayEvent(
  events: readonly VisualReplayEvent[][],
  state: VisualReplayState,
  event: VisualReplayEvent,
): VisualReplayState | null {
  const next = cloneVisualReplayState(state);
  const currentState = next.versionStates[event.slideIndex]!;
  if (event.kind === 'reopen') {
    if (next.stage === 'blocked' || currentState !== 'frozen'
      || event.versionIndex !== next.versionIndexes[event.slideIndex]! + 1) return null;
    next.stage = 'visual_review';
    next.currentSlideIndex = event.slideIndex;
    next.versionIndexes[event.slideIndex] = event.versionIndex;
    next.versionStates[event.slideIndex] = 'placeholder';
  } else if (event.kind === 'candidate') {
    if (event.slideIndex !== next.currentSlideIndex || next.stage === 'conversion'
      || !['none', 'placeholder'].includes(currentState)) return null;
    if (currentState === 'none') {
      if (event.versionIndex !== 0) return null;
      next.versionIndexes[event.slideIndex] = 0;
    } else if (event.versionIndex !== next.versionIndexes[event.slideIndex]) return null;
    next.stage = 'visual_review';
    next.versionStates[event.slideIndex] = 'candidate';
  } else {
    if (event.slideIndex !== next.currentSlideIndex || next.stage !== 'visual_review'
      || currentState !== 'candidate' || event.versionIndex !== next.versionIndexes[event.slideIndex]) return null;
    next.versionStates[event.slideIndex] = 'frozen';
    const pending = next.versionStates.findIndex((status) => status !== 'frozen');
    if (pending < 0) {
      next.stage = 'conversion';
    } else {
      next.currentSlideIndex = pending;
    }
  }
  next.eventIndexes[event.slideIndex] = next.eventIndexes[event.slideIndex]! + 1;
  return next;
}

function visualReplayMatchesCheckpoint(
  value: NativePptPipeline,
  events: readonly VisualReplayEvent[][],
  state: VisualReplayState,
): boolean {
  if (events.some((slideEvents, index) => state.eventIndexes[index] !== slideEvents.length)) return false;
  const slideIds = value.slideSpecs!.value.map(({ id }) => id);
  if (slideIds[state.currentSlideIndex] !== value.currentSlideId) return false;
  const expected = value.project.workflowStatus === 'blocked'
    ? value.blockedCondition!.resumeStage === 'visual_review' ? 'blocked' : 'conversion'
    : ['conversion', 'qa', 'completed'].includes(value.project.workflowStatus)
      ? 'conversion'
      : 'visual_review';
  return state.stage === expected;
}

function requireCurrentSlide(state: NativePptPipeline, slideId: string): void {
  if (!['visual_review', 'blocked'].includes(state.project.workflowStatus) || state.currentSlideId !== slideId) {
    throw new Error(`Slide ${slideId} is not the current visual-review page`);
  }
}

function requireSpec(state: NativePptPipeline, slideId: string): SlideSpec {
  const spec = state.slideSpecs?.value.find((item) => item.id === slideId);
  if (!spec) throw new Error(`Unknown approved slide spec: ${slideId}`);
  return spec;
}

function createWrite(
  relativePath: string,
  contents: Uint8Array,
  kind: string,
  versionId: string,
  slideId?: string,
  metadata?: Record<string, unknown>,
): NativeArtifactWrite {
  return {
    relativePath,
    contentsBase64: Buffer.from(contents).toString('base64'),
    sha256: hash(contents),
    byteLength: contents.byteLength,
    kind,
    versionId,
    ...(slideId ? { slideId } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

function hash(contents: Uint8Array): string {
  return createHash('sha256').update(contents).digest('hex');
}

function jsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(canonicalJson(value), null, 2)}\n`);
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (isRecordValue(value)) {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]),
    );
  }
  return value;
}

function requireIdentifier(value: string, field: string): void {
  if (!/^[a-z][a-z0-9-]{1,127}$/.test(value)) throw new Error(`${field} is invalid`);
}

function requireNonEmpty(value: string, field: string): void {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required`);
}

let cachedOnePixel: Uint8Array | undefined;
function onePixelPng(): Uint8Array {
  if (!cachedOnePixel) {
    const png = new PNG({ width: 1, height: 1 });
    png.data.set([255, 255, 255, 255]);
    cachedOnePixel = new Uint8Array(PNG.sync.write(png));
  }
  return new Uint8Array(cachedOnePixel);
}
