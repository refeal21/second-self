import type { SourceAnalysis } from './ppt-project.js';

export interface SourceAnalysisGatewayRequest {
  projectId: string;
  sourceIds: readonly string[];
  webSearch?: { approved: true; query: string };
}

export interface SourceAnalysisGateway {
  analyze(request: SourceAnalysisGatewayRequest): Promise<SourceAnalysis>;
}

export interface RequestSourceAnalysis {
  id: string;
  projectId: string;
  sourceIds: readonly string[];
  webSearchQuery?: string;
}

export type SourceAnalysisRequestStatus =
  | 'ready'
  | 'awaiting_web_search_approval'
  | 'web_search_rejected'
  | 'completed';

export interface SourceAnalysisRequest {
  id: string;
  projectId: string;
  sourceIds: readonly string[];
  webSearchQuery?: string;
  status: SourceAnalysisRequestStatus;
  output?: SourceAnalysis;
}

export class SourceAnalysisService {
  private readonly requests = new Map<string, SourceAnalysisRequest>();

  constructor(private readonly gateway: SourceAnalysisGateway) {}

  request(input: RequestSourceAnalysis): SourceAnalysisRequest {
    if (this.requests.has(input.id))
      throw new Error(`Analysis request already exists: ${input.id}`);
    const request: SourceAnalysisRequest = {
      ...input,
      sourceIds: [...input.sourceIds],
      status: input.webSearchQuery ? 'awaiting_web_search_approval' : 'ready',
    };
    this.requests.set(request.id, request);
    return this.copy(request);
  }

  decideWebSearch(requestId: string, approved: boolean): SourceAnalysisRequest {
    const request = this.requireRequest(requestId);
    if (request.status !== 'awaiting_web_search_approval') {
      throw new Error('Analysis request is not awaiting web-search approval');
    }
    request.status = approved ? 'ready' : 'web_search_rejected';
    return this.copy(request);
  }

  async execute(requestId: string): Promise<SourceAnalysisRequest> {
    const request = this.requireRequest(requestId);
    if (request.status === 'awaiting_web_search_approval') {
      throw new Error('Web search requires explicit approval');
    }
    if (request.status === 'web_search_rejected') {
      throw new Error('Web search was rejected');
    }
    if (request.status !== 'ready')
      throw new Error('Analysis request is not executable');

    const output = await this.gateway.analyze({
      projectId: request.projectId,
      sourceIds: [...request.sourceIds],
      ...(request.webSearchQuery
        ? {
            webSearch: {
              approved: true as const,
              query: request.webSearchQuery,
            },
          }
        : {}),
    });
    validateSourceAnalysis(output);
    request.output = output;
    request.status = 'completed';
    return this.copy(request);
  }

  private requireRequest(requestId: string): SourceAnalysisRequest {
    const request = this.requests.get(requestId);
    if (!request) throw new Error(`Unknown analysis request: ${requestId}`);
    return request;
  }

  private copy(request: SourceAnalysisRequest): SourceAnalysisRequest {
    return {
      ...request,
      sourceIds: [...request.sourceIds],
      output: request.output ? structuredClone(request.output) : undefined,
    };
  }
}

function validateSourceAnalysis(output: SourceAnalysis): void {
  if (
    !Array.isArray(output.findings) ||
    !Array.isArray(output.dataPoints) ||
    !Array.isArray(output.sourceMap)
  ) {
    throw new Error(
      'Source analysis must include findings, data points, and source mapping',
    );
  }
}
