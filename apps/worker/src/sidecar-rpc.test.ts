import { describe, expect, it } from 'vitest';
import { handleWorkerRpcLine } from './sidecar-rpc.js';

describe('worker sidecar JSON-RPC boundary', () => {
  it('reports a versioned health response without requiring a model turn', async () => {
    const response = await handleWorkerRpcLine(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'system.health' }),
    );

    expect(JSON.parse(response!)).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: 1,
        worker: 'digital-twin-workflow-worker',
        status: 'ready',
      },
    });
  });

  it('returns parse and method errors without terminating the protocol loop', async () => {
    expect(JSON.parse((await handleWorkerRpcLine('{broken'))!)).toMatchObject({
      error: { code: -32700 },
      id: null,
    });
    expect(
      JSON.parse(
        (await handleWorkerRpcLine(
          JSON.stringify({ jsonrpc: '2.0', id: 'x', method: 'unknown' }),
        ))!,
      ),
    ).toMatchObject({ error: { code: -32601 }, id: 'x' });
  });

  it('refuses to skip approval-gated workflow stages', async () => {
    const response = await handleWorkerRpcLine(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'workflow.transition',
        params: {
          from: 'outline_review',
          to: 'detail_review',
          approvals: [],
        },
      }),
    );

    expect(JSON.parse(response!)).toMatchObject({
      error: { code: -32602, message: 'Workflow transition is not permitted' },
    });
  });

  it('recovers only a validated complete checkpoint', async () => {
    const response = await handleWorkerRpcLine(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'checkpoint.recover',
        params: {
          projectId: 'project-1',
          stage: 'visual_review',
          completedStages: [
            'intake',
            'source_analysis',
            'outline_review',
            'detail_review',
          ],
        },
      }),
    );

    expect(JSON.parse(response!)).toMatchObject({
      result: {
        projectId: 'project-1',
        resumeStage: 'visual_review',
        lastCompleteStage: 'detail_review',
      },
    });
  });

  it('reports ImageGen unavailable explicitly when no capability is injected', async () => {
    const response = await handleWorkerRpcLine(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'system.capabilities',
      }),
    );

    expect(JSON.parse(response!)).toMatchObject({
      result: {
        imageGen: {
          id: 'image_gen.imagegen',
          status: 'unavailable',
          billedApiFallback: false,
        },
      },
    });
  });
});
