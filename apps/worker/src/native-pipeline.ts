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

export interface NativePptRpcRuntimeOptions {
  imageGenAvailable: boolean;
  generateVisual?: (slideId: string, spec: SlideSpec) => Promise<{
    image: Uint8Array;
    usage: NativeVisualVersion['usage'];
    textFree: boolean;
    altText: string;
  }>;
}

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

  restore(input: NativePptPipeline): NativePptPipeline {
    validatePipeline(input);
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
        const workflow = await replayPipeline(state, 'source_analysis');
        const service = new (await import('./structure-generation.js')).OutlineGenerationService(
          workflow.projects,
          { generate: async () => structuredClone(action.outline) },
        );
        const version = await service.generate(projectId);
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
            message: 'Codex ImageGen 能力当前不可用；可上传替换 PNG 继续。',
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

function validatePipeline(value: NativePptPipeline): void {
  if (!value || value.schemaVersion !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 1) {
    throw new Error('Native PPT pipeline schema is invalid');
  }
  requireIdentifier(value.project.id, 'project id');
  requireNonEmpty(value.project.name, 'project name');
  requireNonEmpty(value.project.goal, 'project goal');
  if (!Array.isArray(value.sources) || !Array.isArray(value.approvals) || !Array.isArray(value.tasks)) {
    throw new Error('Native PPT pipeline collections are invalid');
  }
  const ids = new Set<string>();
  for (const source of value.sources) {
    requireIdentifier(source.id, 'source id');
    if (ids.has(source.id) || basename(source.fileName) !== source.fileName || !/^[a-f0-9]{64}$/.test(source.sha256)) {
      throw new Error('Native source metadata is invalid');
    }
    ids.add(source.id);
  }
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
  return new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
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
