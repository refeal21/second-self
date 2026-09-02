import { assertStrictIdentifier } from './identifiers.js';
import { writeArtifactOrAdoptExact } from './workspace-artifacts.js';
import {
  type ProjectMutationPort,
  type PptProjectService,
  type SourceAnalysis,
  type ValidatedSourceAnalysisEvidence,
} from './ppt-project.js';

export interface SourceAnalysisGatewayRequest {
  projectId: string;
  requestId: string;
  sourceIds: readonly string[];
  webSearch?: {
    approved: true;
    query: string;
    decidedAt: string;
  };
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
  | 'staging'
  | 'ready'
  | 'awaiting_web_search_approval'
  | 'web_search_rejected'
  | 'running'
  | 'completed';

export interface SourceAnalysisRequest {
  id: string;
  projectId: string;
  sourceIds: readonly string[];
  webSearchQuery?: string;
  webSearchDecision?: { approved: boolean; decidedAt: string };
  status: SourceAnalysisRequestStatus;
  output?: SourceAnalysis;
}

interface SharedAnalysisState {
  requests: Map<string, SourceAnalysisRequest>;
  activeProjects: Set<string>;
  reservedProjects: Map<string, string>;
}

const stateByProjects = new WeakMap<PptProjectService, SharedAnalysisState>();

export class SourceAnalysisService {
  readonly #projects: PptProjectService;
  readonly #gateway: SourceAnalysisGateway;
  readonly #mutations: ProjectMutationPort;
  readonly #state: SharedAnalysisState;

  constructor(
    projects: PptProjectService,
    gateway: SourceAnalysisGateway,
    mutations: ProjectMutationPort,
  ) {
    this.#projects = projects;
    this.#gateway = gateway;
    this.#mutations = mutations;
    const existing = stateByProjects.get(projects);
    this.#state = existing ?? {
      requests: new Map(),
      activeProjects: new Set<string>(),
      reservedProjects: new Map<string, string>(),
    };
    stateByProjects.set(projects, this.#state);
  }

  async request(input: RequestSourceAnalysis): Promise<SourceAnalysisRequest> {
    assertStrictIdentifier('request', input.id);
    assertStrictIdentifier('project', input.projectId);
    if (this.#state.requests.has(input.id)) {
      throw new Error(`Analysis request already exists: ${input.id}`);
    }
    const reservation = this.#state.reservedProjects.get(input.projectId);
    if (reservation) {
      throw new Error(
        `Source analysis project is already reserved by request: ${reservation}`,
      );
    }
    const sourceIds = input.sourceIds.map((id) =>
      assertStrictIdentifier('source', id),
    );
    if (
      sourceIds.length === 0 ||
      new Set(sourceIds).size !== sourceIds.length
    ) {
      throw new Error('Analysis requires a unique attached source set');
    }
    const snapshot = this.#projects.getProjectSnapshot(input.projectId);
    if (snapshot.project.workflowStatus !== 'intake') {
      throw new Error('Source analysis can only be requested during intake');
    }
    const attached = new Set(snapshot.sources.map(({ id }) => id));
    if (!sourceIds.every((id) => attached.has(id))) {
      throw new Error('Analysis request must use an attached source set');
    }
    const request: SourceAnalysisRequest = {
      ...input,
      sourceIds,
      status: 'staging',
    };
    this.#state.requests.set(request.id, request);
    this.#state.reservedProjects.set(request.projectId, request.id);
    let workflowReserved = false;
    try {
      this.#mutations.beginSourceAnalysis(input.projectId);
      workflowReserved = true;
      await writeArtifactOrAdoptExact(
        this.#mutations.artifacts,
        input.projectId,
        `sources/${input.id}-request.json`,
        JSON.stringify(request, null, 2),
      );
      request.status = input.webSearchQuery
        ? 'awaiting_web_search_approval'
        : 'ready';
      return this.#copy(request);
    } catch (error) {
      this.#state.requests.delete(request.id);
      if (this.#state.reservedProjects.get(request.projectId) === request.id) {
        this.#state.reservedProjects.delete(request.projectId);
      }
      if (workflowReserved) {
        this.#mutations.rollbackSourceAnalysis(request.projectId);
      }
      throw error;
    }
  }

  async decideWebSearch(
    requestId: string,
    approved: boolean,
    decidedAt: string,
  ): Promise<SourceAnalysisRequest> {
    const request = this.#requireRequest(requestId);
    if (request.status !== 'awaiting_web_search_approval') {
      throw new Error('Analysis request is not awaiting web-search approval');
    }
    const decision = { approved, decidedAt };
    await writeArtifactOrAdoptExact(
      this.#mutations.artifacts,
      request.projectId,
      `sources/${request.id}-web-search-approval.json`,
      JSON.stringify(
        {
          projectId: request.projectId,
          requestId: request.id,
          sourceIds: request.sourceIds,
          query: request.webSearchQuery,
          ...decision,
        },
        null,
        2,
      ),
    );
    request.webSearchDecision = decision;
    request.status = approved ? 'ready' : 'web_search_rejected';
    return this.#copy(request);
  }

  async execute(requestId: string): Promise<SourceAnalysisRequest> {
    const request = this.#requireRequest(requestId);
    if (
      request.status === 'running' ||
      this.#state.activeProjects.has(request.projectId)
    ) {
      throw new Error('Source analysis is already running for this project');
    }
    if (request.status === 'awaiting_web_search_approval') {
      throw new Error('Web search requires explicit approval');
    }
    if (request.status === 'web_search_rejected') {
      throw new Error('Web search was rejected');
    }
    if (request.status !== 'ready') {
      throw new Error('Analysis request is not executable');
    }

    request.status = 'running';
    this.#state.activeProjects.add(request.projectId);
    try {
      const output = await this.#gateway.analyze({
        projectId: request.projectId,
        requestId: request.id,
        sourceIds: [...request.sourceIds],
        ...(request.webSearchQuery && request.webSearchDecision?.approved
          ? {
              webSearch: {
                approved: true as const,
                query: request.webSearchQuery,
                decidedAt: request.webSearchDecision.decidedAt,
              },
            }
          : {}),
      });
      validateSourceAnalysis(output, request.sourceIds);
      const evidence: ValidatedSourceAnalysisEvidence = {
        projectId: request.projectId,
        requestId: request.id,
        sourceIds: request.sourceIds,
        output,
        ...(request.webSearchQuery && request.webSearchDecision
          ? {
              webSearchDecision: {
                ...request.webSearchDecision,
                query: request.webSearchQuery,
              },
            }
          : {}),
      };
      await this.#mutations.commitSourceAnalysis(evidence);
      request.output = structuredClone(output);
      request.status = 'completed';
      return this.#copy(request);
    } catch (error) {
      request.status = 'ready';
      throw error;
    } finally {
      this.#state.activeProjects.delete(request.projectId);
    }
  }

  get(requestId: string): SourceAnalysisRequest {
    return this.#copy(this.#requireRequest(requestId));
  }

  #requireRequest(requestId: string): SourceAnalysisRequest {
    assertStrictIdentifier('request', requestId);
    const request = this.#state.requests.get(requestId);
    if (!request) throw new Error(`Unknown analysis request: ${requestId}`);
    return request;
  }

  #copy(request: SourceAnalysisRequest): SourceAnalysisRequest {
    return structuredClone(request);
  }
}

function validateSourceAnalysis(
  output: SourceAnalysis,
  requestedSourceIds: readonly string[],
): void {
  if (
    !output ||
    !Array.isArray(output.findings) ||
    !Array.isArray(output.dataPoints) ||
    !Array.isArray(output.sourceMap)
  ) {
    throw new Error(
      'Source analysis must include findings, data points, and source mapping',
    );
  }
  const permitted = new Set(requestedSourceIds);
  const checkSource = (sourceId: string): void => {
    assertStrictIdentifier('source', sourceId);
    if (!permitted.has(sourceId)) {
      throw new Error(
        `Source analysis references source outside requested source set: ${sourceId}`,
      );
    }
  };
  const findingIds = new Set<string>();
  for (const finding of output.findings) {
    if (!finding || typeof finding.text !== 'string') {
      throw new Error('Source finding does not match the runtime schema');
    }
    assertStrictIdentifier('version', finding.id);
    if (findingIds.has(finding.id)) {
      throw new Error(`Duplicate source finding identifier: ${finding.id}`);
    }
    findingIds.add(finding.id);
    if (!Array.isArray(finding.sourceIds)) {
      throw new Error('Source finding must contain source ids');
    }
    finding.sourceIds.forEach(checkSource);
  }
  const dataPointIds = new Set<string>();
  for (const point of output.dataPoints) {
    if (
      !point ||
      typeof point.label !== 'string' ||
      (typeof point.value !== 'string' && typeof point.value !== 'number') ||
      (typeof point.value === 'number' && !Number.isFinite(point.value)) ||
      (point.unit !== undefined && typeof point.unit !== 'string') ||
      (point.sourceIds !== undefined &&
        (!Array.isArray(point.sourceIds) ||
          !point.sourceIds.every(
            (sourceId: unknown) => typeof sourceId === 'string',
          )))
    ) {
      throw new Error('Source data point does not match the runtime schema');
    }
    assertStrictIdentifier('version', point.id);
    if (dataPointIds.has(point.id)) {
      throw new Error(`Duplicate source data-point identifier: ${point.id}`);
    }
    dataPointIds.add(point.id);
    point.sourceIds?.forEach(checkSource);
  }
  output.sourceMap.forEach((citation) => {
    if (
      !citation ||
      typeof citation.sourceId !== 'string' ||
      typeof citation.title !== 'string' ||
      typeof citation.locator !== 'string' ||
      (citation.url !== undefined && typeof citation.url !== 'string')
    ) {
      throw new Error('Source citation does not match the runtime schema');
    }
    checkSource(citation.sourceId);
  });
}
