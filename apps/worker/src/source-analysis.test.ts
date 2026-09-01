import { describe, expect, it } from 'vitest';
import {
  SourceAnalysisService,
  type SourceAnalysisGateway,
  type SourceAnalysisGatewayRequest,
} from './source-analysis.js';

class FakeSourceAnalysisGateway implements SourceAnalysisGateway {
  readonly requests: SourceAnalysisGatewayRequest[] = [];

  async analyze(request: SourceAnalysisGatewayRequest) {
    this.requests.push(request);
    return {
      findings: [
        {
          id: 'finding-1',
          text: 'A sourced finding.',
          sourceIds: ['source-1'],
        },
      ],
      dataPoints: [{ id: 'point-1', label: 'Growth', value: 12, unit: '%' }],
      sourceMap: [{ sourceId: 'source-1', title: 'Report', locator: 'page 8' }],
    };
  }
}

describe('source analysis approval', () => {
  it('blocks requested web search until the user explicitly approves it', async () => {
    const gateway = new FakeSourceAnalysisGateway();
    const service = new SourceAnalysisService(gateway);
    const pending = service.request({
      id: 'analysis-1',
      projectId: 'project-1',
      sourceIds: ['source-1'],
      webSearchQuery: 'latest market growth',
    });

    expect(pending).toMatchObject({ status: 'awaiting_web_search_approval' });
    await expect(service.execute('analysis-1')).rejects.toThrow(
      'Web search requires explicit approval',
    );
    expect(gateway.requests).toHaveLength(0);

    service.decideWebSearch('analysis-1', true);
    const completed = await service.execute('analysis-1');

    expect(completed).toMatchObject({
      status: 'completed',
      output: {
        findings: [{ text: 'A sourced finding.' }],
        dataPoints: [{ label: 'Growth', value: 12 }],
        sourceMap: [{ sourceId: 'source-1', locator: 'page 8' }],
      },
    });
    expect(gateway.requests).toEqual([
      {
        projectId: 'project-1',
        sourceIds: ['source-1'],
        webSearch: { approved: true, query: 'latest market growth' },
      },
    ]);
  });

  it('executes local-only analysis without manufacturing a web-search approval', async () => {
    const gateway = new FakeSourceAnalysisGateway();
    const service = new SourceAnalysisService(gateway);
    service.request({
      id: 'analysis-1',
      projectId: 'project-1',
      sourceIds: ['source-1'],
    });

    const completed = await service.execute('analysis-1');

    expect(completed.status).toBe('completed');
    expect(gateway.requests[0]?.webSearch).toBeUndefined();
  });
});
