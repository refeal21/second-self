import type { LibreOfficeQaReport } from './libreoffice-qa.js';

export interface ExportReceipt {
  projectId: string;
  relativePath: string;
  artifactPath: string;
  sha256: string;
  byteLength: number;
  specVersionId: string;
  visualVersionIds: Readonly<Record<string, string>>;
}

export const COMMIT_EXPORT_RECEIPT: unique symbol = Symbol(
  'commit-export-receipt',
);
export const COMMIT_QA_REPORT: unique symbol = Symbol('commit-qa-report');

export interface QaEvidence {
  receipt: ExportReceipt;
  report: LibreOfficeQaReport;
}
