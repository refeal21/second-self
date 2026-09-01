import type { SourceAnalysis } from './ppt-project.js';

export const COMMIT_VALIDATED_SOURCE_ANALYSIS: unique symbol = Symbol(
  'commit-validated-source-analysis',
);

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
