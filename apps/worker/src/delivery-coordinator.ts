import { createHash } from 'node:crypto';
import { basename, isAbsolute } from 'node:path';
import type {
  PptRepairer,
  QaRunner,
  LibreOfficeQaReport,
} from './libreoffice-qa.js';
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
        const report = await this.#qa.run({
          projectId,
          pptxPath: receipt.relativePath,
          expectedPageCount: checkpoint.expectedPageCount,
          round: checkpoint.reports.length + 1,
          exportSha256: receipt.sha256,
          specVersionId: receipt.specVersionId,
          visualVersionIds: receipt.visualVersionIds,
        });
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

  async #validateRepairedReceipt(
    current: ExportReceipt,
    repaired: { pptxPath: string; exportSha256: string },
  ): Promise<ExportReceipt> {
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

function normalizePptxFileName(fileName: string): string {
  if (basename(fileName) !== fileName || !/\.pptx$/i.test(fileName)) {
    throw new Error('PPTX export file name must be a local .pptx name');
  }
  return `${fileName.slice(0, -5)}.pptx`;
}
