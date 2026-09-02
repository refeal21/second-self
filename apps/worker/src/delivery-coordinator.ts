import { createHash } from 'node:crypto';
import { basename, isAbsolute } from 'node:path';
import type {
  PptRepairer,
  QaRunner,
  LibreOfficeQaReport,
} from './libreoffice-qa.js';
import { formatQaReadableSummary } from './libreoffice-qa.js';
import {
  type ExportReceipt,
  type ProjectMutationPort,
  type PptProjectService,
} from './ppt-project.js';
import type { ApprovedPptDeck, PptxExporter } from './pptx-exporter.js';
import type { WorkspaceArtifactAccess } from './workspace-artifacts.js';

export interface DeliveryResult {
  exportReceipt: ExportReceipt;
  qaReport: LibreOfficeQaReport;
  qaReports: readonly LibreOfficeQaReport[];
  repairRounds: number;
}

export class PptDeliveryCoordinator {
  readonly #projects: PptProjectService;
  readonly #artifacts: WorkspaceArtifactAccess;
  readonly #exporter: PptxExporter;
  readonly #qa: QaRunner;
  readonly #repairer: PptRepairer;
  readonly #mutations: ProjectMutationPort;

  constructor(
    projects: PptProjectService,
    artifacts: WorkspaceArtifactAccess,
    exporter: PptxExporter,
    qa: QaRunner,
    repairer: PptRepairer,
    mutations: ProjectMutationPort,
  ) {
    this.#projects = projects;
    this.#artifacts = artifacts;
    this.#exporter = exporter;
    this.#qa = qa;
    this.#repairer = repairer;
    this.#mutations = mutations;
  }

  async deliver(
    projectId: string,
    requestedFileName: string,
  ): Promise<DeliveryResult> {
    const release = this.#mutations.acquireOperation(projectId, 'PPT delivery');
    try {
      const fileName = normalizePptxFileName(requestedFileName);
      const snapshot = this.#projects.getProjectSnapshot(projectId);
      if (snapshot.project.workflowStatus === 'conversion') {
        if (
          snapshot.slideSpecs?.version.status !== 'frozen' ||
          snapshot.outline?.version.status !== 'frozen'
        ) {
          throw new Error(
            'Delivery requires frozen specs and approved visuals',
          );
        }
        const receipt = await this.#exportInitial(
          projectId,
          fileName,
          snapshot.outline.value.title,
          snapshot.slideSpecs.version.id,
        );
        await this.#mutations.commitExportReceipt({
          receipt,
          expectedPageCount: snapshot.slideSpecs.value.length,
        });
      } else if (snapshot.project.workflowStatus !== 'qa') {
        throw new Error('Delivery requires frozen specs and approved visuals');
      }
      return await this.#runQaAndRepair(projectId);
    } finally {
      release();
    }
  }

  async #exportInitial(
    projectId: string,
    fileName: string,
    title: string,
    specVersionId: string,
  ): Promise<ExportReceipt> {
    const approved = this.#mutations.getApprovedDeck(projectId);
    const slides: ApprovedPptDeck['slides'][number][] = [];
    const visualVersionIds: Record<string, string> = {};
    for (const spec of approved.specs) {
      const visual = approved.visuals[spec.id];
      if (!visual?.asset || visual.version.status !== 'frozen') {
        throw new Error(`Approved visual evidence is missing for ${spec.id}`);
      }
      const relativeVisualPath = `visuals/${spec.id}-v${visual.version.sequence}.png`;
      const expectedPath = await this.#artifacts.resolvePath(
        projectId,
        relativeVisualPath,
      );
      if (visual.asset.artifactPath !== expectedPath) {
        throw new Error(
          `Visual artifact path is not boundary validated: ${spec.id}`,
        );
      }
      const image = await this.#artifacts.read(projectId, relativeVisualPath);
      visualVersionIds[spec.id] = visual.version.id;
      slides.push({ spec, visual: { asset: visual.asset, image } });
    }
    const bytes = await this.#exporter.export({ title, slides });
    const relativePath = `exports/${fileName}`;
    const artifactPath = await this.#artifacts.write(
      projectId,
      relativePath,
      bytes,
    );
    const persisted = await this.#artifacts.read(projectId, relativePath);
    const receipt: ExportReceipt = {
      projectId,
      relativePath,
      artifactPath,
      sha256: createHash('sha256').update(persisted).digest('hex'),
      byteLength: persisted.byteLength,
      specVersionId,
      visualVersionIds,
    };
    if (
      persisted.byteLength !== bytes.byteLength ||
      receipt.sha256 !== createHash('sha256').update(bytes).digest('hex')
    ) {
      throw new Error('Persisted PPTX bytes do not match exporter output');
    }
    return receipt;
  }

  async #runQaAndRepair(projectId: string): Promise<DeliveryResult> {
    while (true) {
      const checkpoint = this.#mutations.getQaCheckpoint(projectId);
      if (checkpoint.nextAction === 'qa') {
        const receipt = checkpoint.currentReceipt;
        const input = {
          projectId,
          pptxPath: receipt.relativePath,
          expectedPageCount: checkpoint.expectedPageCount,
          round: checkpoint.reports.length + 1,
          exportSha256: receipt.sha256,
          specVersionId: receipt.specVersionId,
          visualVersionIds: receipt.visualVersionIds,
        };
        const report =
          (await this.#recoverQaBundle(input, receipt)) ??
          (await this.#qa.run(input));
        this.#mutations.commitQaReport({
          receipt,
          report,
          finalFailure:
            report.status === 'failed' && checkpoint.repairRounds >= 2,
        });
      } else if (checkpoint.nextAction === 'repair') {
        const qaReport = checkpoint.reports.at(-1);
        if (!qaReport) throw new Error('Repair requires a failed QA report');
        const repaired = await this.#repairer.repair({
          projectId,
          pptxPath: checkpoint.currentReceipt.relativePath,
          round: checkpoint.repairRounds + 1,
          qaReport,
        });
        const receipt = await this.#validateRepairedReceipt(
          checkpoint.currentReceipt,
          repaired,
        );
        await this.#mutations.commitRepairedExportReceipt(receipt);
      } else {
        const qaReport = checkpoint.reports.at(-1);
        if (!qaReport) throw new Error('Finished QA checkpoint has no report');
        return {
          exportReceipt: checkpoint.currentReceipt,
          qaReport,
          qaReports: checkpoint.reports,
          repairRounds: checkpoint.repairRounds,
        };
      }
    }
  }

  async #recoverQaBundle(
    input: {
      projectId: string;
      pptxPath: string;
      expectedPageCount: number;
      round: number;
      exportSha256: string;
      specVersionId: string;
      visualVersionIds: Readonly<Record<string, string>>;
    },
    currentReceipt: ExportReceipt,
  ): Promise<LibreOfficeQaReport | undefined> {
    const relativePath = `qa/qa-round-${input.round}.json`;
    const contents = await this.#artifacts
      .read(input.projectId, relativePath)
      .catch((error: unknown) => {
        if (isMissingArtifact(error)) return undefined;
        throw error;
      });
    if (!contents) return undefined;
    await this.#revalidateCurrentReceipt(currentReceipt);
    let bundle: unknown;
    try {
      bundle = JSON.parse(new TextDecoder().decode(contents));
    } catch {
      throw new Error('Existing QA bundle is not valid JSON');
    }
    const expectedPath = await this.#artifacts.resolvePath(
      input.projectId,
      relativePath,
    );
    const report = validateQaBundle(bundle, input, expectedPath);
    const reissue = this.#qa.reissueValidatedReport;
    if (!reissue) {
      throw new Error(
        'Existing QA bundle cannot be reissued by this QA runner',
      );
    }
    return reissue(report);
  }

  async #revalidateCurrentReceipt(current: ExportReceipt): Promise<void> {
    if (
      isAbsolute(current.relativePath) ||
      current.relativePath.includes('\\') ||
      current.relativePath
        .split('/')
        .some((part) => part === '.' || part === '..') ||
      !current.relativePath.startsWith('exports/') ||
      !/\.pptx$/i.test(current.relativePath)
    ) {
      throw new Error('Current export receipt must be inside project exports');
    }
    const expectedPath = await this.#artifacts.resolvePath(
      current.projectId,
      current.relativePath,
    );
    const bytes = await this.#artifacts.read(
      current.projectId,
      current.relativePath,
    );
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (
      expectedPath !== current.artifactPath ||
      bytes.byteLength !== current.byteLength ||
      sha256 !== current.sha256
    ) {
      throw new Error(
        'current export receipt hash does not match validated artifact bytes',
      );
    }
  }

  async #validateRepairedReceipt(
    current: ExportReceipt,
    repaired: { pptxPath: string; exportSha256: string },
  ): Promise<ExportReceipt> {
    if (repaired.pptxPath === current.relativePath) {
      throw new Error('Repair must use a new relative path');
    }
    if (
      isAbsolute(repaired.pptxPath) ||
      repaired.pptxPath.includes('\\') ||
      repaired.pptxPath
        .split('/')
        .some((part) => part === '.' || part === '..') ||
      !repaired.pptxPath.startsWith('exports/') ||
      !/\.pptx$/i.test(repaired.pptxPath)
    ) {
      throw new Error('Repaired PPTX must be inside project exports');
    }
    await this.#revalidateCurrentReceipt(current);
    const artifactPath = await this.#artifacts.resolvePath(
      current.projectId,
      repaired.pptxPath,
    );
    const bytes = await this.#artifacts.read(
      current.projectId,
      repaired.pptxPath,
    );
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== repaired.exportSha256) {
      throw new Error('Repaired PPTX hash does not match artifact bytes');
    }
    if (sha256 === current.sha256) {
      throw new Error('Repair must produce a new artifact hash');
    }
    return {
      ...current,
      relativePath: repaired.pptxPath,
      artifactPath,
      sha256,
      byteLength: bytes.byteLength,
    };
  }
}

function validateQaBundle(
  bundle: unknown,
  input: {
    projectId: string;
    pptxPath: string;
    expectedPageCount: number;
    round: number;
    exportSha256: string;
    specVersionId: string;
    visualVersionIds: Readonly<Record<string, string>>;
  },
  expectedPath: string,
): LibreOfficeQaReport {
  if (!isRecord(bundle) || typeof bundle.readableSummary !== 'string') {
    throw new Error('Existing QA bundle does not match the runtime schema');
  }
  const { readableSummary, ...candidate } = bundle;
  if (
    !isRecord(candidate) ||
    !['passed', 'failed', 'blocked'].includes(candidate.status as string) ||
    candidate.round !== input.round ||
    candidate.projectId !== input.projectId ||
    candidate.exportPath !== input.pptxPath ||
    candidate.exportSha256 !== input.exportSha256 ||
    candidate.specVersionId !== input.specVersionId ||
    !sameStringRecord(candidate.visualVersionIds, input.visualVersionIds) ||
    candidate.expectedPageCount !== input.expectedPageCount ||
    candidate.jsonReportPath !== expectedPath ||
    candidate.textReportPath !== expectedPath ||
    !isNullableString(candidate.sofficePath) ||
    !isNullableString(candidate.rendererPath) ||
    !isNullableString(candidate.pdfPath) ||
    !isStringArray(candidate.renderedPages) ||
    !isNonNegativeSafeInteger(candidate.actualPageCount) ||
    !isPositiveSafeIntegerArray(candidate.blankPages) ||
    !isQaComparisons(candidate.comparisons) ||
    !isStringArray(candidate.issues)
  ) {
    throw new Error('Existing QA bundle does not match the runtime schema');
  }
  const report = candidate as unknown as LibreOfficeQaReport;
  if (!hasCoherentQaSemantics(report)) {
    throw new Error('Existing QA bundle violates semantic invariants');
  }
  if (readableSummary !== formatQaReadableSummary(report)) {
    throw new Error(
      'Existing QA bundle readable summary does not match report',
    );
  }
  return report;
}

function hasCoherentQaSemantics(report: LibreOfficeQaReport): boolean {
  const renderedPaths = new Set(report.renderedPages);
  const comparisonPaths = new Set(report.comparisons.map(({ path }) => path));
  const derivedBlankPages = report.comparisons.flatMap((comparison, index) =>
    comparison.blank ? [index + 1] : [],
  );
  const issuesAreCoherent =
    report.issues.length > 0 &&
    report.issues.every((issue) => issue.trim().length > 0);
  const arraysAreCoherent =
    report.actualPageCount === report.renderedPages.length &&
    report.comparisons.length === report.renderedPages.length &&
    renderedPaths.size === report.renderedPages.length &&
    comparisonPaths.size === report.comparisons.length &&
    [...comparisonPaths].every((path) => renderedPaths.has(path)) &&
    report.blankPages.length === new Set(report.blankPages).size &&
    report.blankPages.every((page) => page <= report.actualPageCount) &&
    JSON.stringify(report.blankPages) === JSON.stringify(derivedBlankPages);
  if (!arraysAreCoherent) return false;
  if (report.status !== 'passed') return issuesAreCoherent;
  return (
    report.actualPageCount === report.expectedPageCount &&
    report.issues.length === 0 &&
    report.blankPages.length === 0 &&
    report.renderedPages.length === report.expectedPageCount &&
    report.comparisons.length === report.expectedPageCount &&
    report.comparisons.every((comparison) => !comparison.blank) &&
    isNonEmptyString(report.sofficePath) &&
    isNonEmptyString(report.rendererPath) &&
    isNonEmptyString(report.pdfPath)
  );
}

function isNonEmptyString(value: string | null): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isStringArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  );
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeIntegerArray(
  value: unknown,
): value is readonly number[] {
  return (
    Array.isArray(value) &&
    value.every((item) => Number.isSafeInteger(item) && item > 0)
  );
}

function isQaComparisons(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (comparison) =>
        isRecord(comparison) &&
        typeof comparison.path === 'string' &&
        typeof comparison.blank === 'boolean' &&
        (comparison.differenceScore === undefined ||
          (typeof comparison.differenceScore === 'number' &&
            Number.isFinite(comparison.differenceScore))),
    )
  );
}

function sameStringRecord(
  candidate: unknown,
  expected: Readonly<Record<string, string>>,
): boolean {
  return (
    isRecord(candidate) &&
    Object.values(candidate).every((value) => typeof value === 'string') &&
    JSON.stringify(candidate) === JSON.stringify(expected)
  );
}

function isMissingArtifact(error: unknown): boolean {
  return (
    error instanceof Error &&
    (('code' in error && error.code === 'ENOENT') ||
      error.message.startsWith('missing '))
  );
}

function normalizePptxFileName(fileName: string): string {
  if (basename(fileName) !== fileName || !/\.pptx$/i.test(fileName)) {
    throw new Error('PPTX export file name must be a local .pptx name');
  }
  return `${fileName.slice(0, -5)}.pptx`;
}
