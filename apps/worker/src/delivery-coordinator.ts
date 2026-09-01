import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import {
  COMMIT_EXPORT_RECEIPT,
  COMMIT_QA_REPORT,
  type ExportReceipt,
} from './delivery-evidence.js';
import type { QaRunner, LibreOfficeQaReport } from './libreoffice-qa.js';
import { PptProjectService } from './ppt-project.js';
import type { ApprovedPptDeck, PptxExporter } from './pptx-exporter.js';
import type { WorkspaceArtifactAccess } from './workspace-artifacts.js';

export interface DeliveryResult {
  exportReceipt: ExportReceipt;
  qaReport: LibreOfficeQaReport;
}

export class PptDeliveryCoordinator {
  constructor(
    private readonly projects: PptProjectService,
    private readonly artifacts: WorkspaceArtifactAccess,
    private readonly exporter: PptxExporter,
    private readonly qa: QaRunner,
  ) {}

  async deliver(
    projectId: string,
    requestedFileName: string,
  ): Promise<DeliveryResult> {
    const release = this.projects.acquireProjectOperation(
      projectId,
      'PPT delivery',
    );
    try {
      const fileName = normalizePptxFileName(requestedFileName);
      const snapshot = this.projects.getProjectSnapshot(projectId);
      if (
        snapshot.project.workflowStatus !== 'conversion' ||
        snapshot.slideSpecs?.version.status !== 'frozen' ||
        snapshot.outline?.version.status !== 'frozen'
      ) {
        throw new Error('Delivery requires frozen specs and approved visuals');
      }
      const approved = this.projects.getApprovedDeck(projectId);
      const slides: ApprovedPptDeck['slides'][number][] = [];
      const visualVersionIds: Record<string, string> = {};
      for (const spec of approved.specs) {
        const visual = approved.visuals[spec.id];
        if (!visual?.asset || visual.version.status !== 'frozen') {
          throw new Error(`Approved visual evidence is missing for ${spec.id}`);
        }
        const relativeVisualPath = `visuals/${spec.id}-v${visual.version.sequence}.png`;
        const expectedPath = await this.artifacts.resolvePath(
          projectId,
          relativeVisualPath,
        );
        if (visual.asset.artifactPath !== expectedPath) {
          throw new Error(
            `Visual artifact path is not boundary validated: ${spec.id}`,
          );
        }
        const image = await this.artifacts.read(projectId, relativeVisualPath);
        visualVersionIds[spec.id] = visual.version.id;
        slides.push({ spec, visual: { asset: visual.asset, image } });
      }
      const deck: ApprovedPptDeck = {
        title: snapshot.outline.value.title,
        slides,
      };
      const bytes = await this.exporter.export(deck);
      const relativePath = `exports/${fileName}`;
      const artifactPath = await this.artifacts.write(
        projectId,
        relativePath,
        bytes,
      );
      const persisted = await this.artifacts.read(projectId, relativePath);
      const receipt: ExportReceipt = {
        projectId,
        relativePath,
        artifactPath,
        sha256: createHash('sha256').update(persisted).digest('hex'),
        byteLength: persisted.byteLength,
        specVersionId: snapshot.slideSpecs.version.id,
        visualVersionIds,
      };
      if (
        persisted.byteLength !== bytes.byteLength ||
        receipt.sha256 !== createHash('sha256').update(bytes).digest('hex')
      ) {
        throw new Error('Persisted PPTX bytes do not match exporter output');
      }
      await this.projects[COMMIT_EXPORT_RECEIPT](receipt);
      const qaReport = await this.qa.run({
        projectId,
        pptxPath: relativePath,
        expectedPageCount: slides.length,
        round: 1,
        exportSha256: receipt.sha256,
        specVersionId: receipt.specVersionId,
        visualVersionIds: receipt.visualVersionIds,
      });
      this.projects[COMMIT_QA_REPORT]({ receipt, report: qaReport });
      return { exportReceipt: receipt, qaReport };
    } finally {
      release();
    }
  }
}

function normalizePptxFileName(fileName: string): string {
  if (basename(fileName) !== fileName || !/\.pptx$/i.test(fileName)) {
    throw new Error('PPTX export file name must be a local .pptx name');
  }
  return `${fileName.slice(0, -5)}.pptx`;
}
