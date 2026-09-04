import {
  canTransition,
  pptWorkflowStages,
  type PptWorkflowStage,
  type WorkflowStatus,
} from '@digital-twin/core';
import { assertStrictIdentifier } from './identifiers.js';
import {
  NativePptRpcRuntime,
  parseNativePipelineAction,
  type NativePptPipeline,
  type NativePreferenceSnapshot,
} from './native-pipeline.js';

export const WORKER_RPC_PROTOCOL_VERSION = 1;
export const WORKER_NAME = 'digital-twin-workflow-worker';

type RpcId = string | number | null;

interface RpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: unknown;
}

interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

class InvalidParams extends Error {}

const nativePptRuntime = new NativePptRpcRuntime({
  imageGenAvailable: process.env.DIGITAL_TWIN_IMAGEGEN === 'available',
});

export async function handleWorkerRpcLine(
  line: string,
): Promise<string | null> {
  let request: RpcRequest;
  try {
    request = parseRequest(line);
  } catch (error) {
    return encodeError(null, {
      code: error instanceof SyntaxError ? -32700 : -32600,
      message:
        error instanceof SyntaxError ? 'Parse error' : 'Invalid Request',
    });
  }

  const isNotification = request.id === undefined;
  try {
    const result = await dispatch(request.method, request.params);
    return isNotification
      ? null
      : JSON.stringify({ jsonrpc: '2.0', id: request.id, result });
  } catch (error) {
    if (isNotification) return null;
    const rpcError: RpcError =
      error instanceof InvalidParams
        ? { code: -32602, message: error.message }
        : error instanceof MethodNotFound
          ? { code: -32601, message: 'Method not found' }
          : {
              code: -32603,
              message: 'Internal error',
              data: error instanceof Error ? error.message : String(error),
            };
    return encodeError(request.id ?? null, rpcError);
  }
}

function parseRequest(line: string): RpcRequest {
  const value = JSON.parse(line) as unknown;
  if (!isRecord(value) || value.jsonrpc !== '2.0') {
    throw new Error('Invalid JSON-RPC request');
  }
  if (typeof value.method !== 'string' || value.method.length === 0) {
    throw new Error('Invalid JSON-RPC method');
  }
  if (
    value.id !== undefined &&
    value.id !== null &&
    typeof value.id !== 'string' &&
    typeof value.id !== 'number'
  ) {
    throw new Error('Invalid JSON-RPC id');
  }
  return value as unknown as RpcRequest;
}

async function dispatch(method: string, params: unknown): Promise<unknown> {
  switch (method) {
    case 'system.health':
      requireNoParams(params);
      return {
        protocolVersion: WORKER_RPC_PROTOCOL_VERSION,
        worker: WORKER_NAME,
        status: 'ready',
      };
    case 'system.capabilities':
      requireNoParams(params);
      return {
        protocolVersion: WORKER_RPC_PROTOCOL_VERSION,
        imageGen: {
          id: 'image_gen.imagegen',
          status:
            process.env.DIGITAL_TWIN_IMAGEGEN === 'available'
              ? 'available'
              : 'unavailable',
          billedApiFallback: false,
        },
      };
    case 'workflow.transition':
      return transition(params);
    case 'checkpoint.recover':
      return recoverCheckpoint(params);
    case 'ppt.project.create': {
      const input = requireRecord(params);
      const pipeline = nativePptRuntime.create({
        id: requireString(input.id, 'id'),
        name: requireString(input.name, 'name'),
        goal: requireString(input.goal, 'goal'),
        createdAt: requireString(input.createdAt, 'createdAt'),
        preferenceSnapshot: requireArray(input.preferenceSnapshot, 'preferenceSnapshot') as NativePreferenceSnapshot[],
      });
      return { pipeline, writes: [], message: '项目已在工作流 Worker 中创建。' };
    }
    case 'ppt.project.restore': {
      const input = requireRecord(params);
      try {
        return await nativePptRuntime.restore(input.pipeline as NativePptPipeline);
      } catch (error) {
        throw new InvalidParams(
          error instanceof Error
            ? error.message
            : 'Native PPT pipeline snapshot is invalid',
        );
      }
    }
    case 'ppt.project.snapshot': {
      const input = requireRecord(params);
      return nativePptRuntime.snapshot(requireString(input.projectId, 'projectId'));
    }
    case 'ppt.project.execute': {
      const input = requireRecord(params);
      let action;
      try {
        action = parseNativePipelineAction(input.action);
      } catch (error) {
        throw new InvalidParams(
          error instanceof Error ? error.message : 'Native PPT action is invalid',
        );
      }
      return nativePptRuntime.execute(
        requireString(input.projectId, 'projectId'),
        action,
      );
    }
    case 'test.crash':
      if (process.env.DIGITAL_TWIN_SIDECAR_TEST_MODE !== '1') {
        throw new MethodNotFound();
      }
      return process.exit(86);
    default:
      throw new MethodNotFound();
  }
}

function transition(params: unknown): { stage: WorkflowStatus } {
  const input = requireRecord(params);
  const from = requireWorkflowStatus(input.from, 'from');
  const to = requireWorkflowStatus(input.to, 'to');
  const approvals = Array.isArray(input.approvals) ? input.approvals : [];
  const visualSlideIds = Array.isArray(input.visualSlideIds)
    ? input.visualSlideIds
    : undefined;
  if (
    !approvals.every(
      (item) =>
        isRecord(item) &&
        typeof item.stage === 'string' &&
        typeof item.status === 'string' &&
        (item.slideId === undefined || typeof item.slideId === 'string'),
    ) ||
    (visualSlideIds &&
      !visualSlideIds.every((slideId) => typeof slideId === 'string'))
  ) {
    throw new InvalidParams('Workflow approval context is invalid');
  }
  if (
    !canTransition(from, to, {
      approvals: approvals as never,
      visualSlideIds: visualSlideIds as string[] | undefined,
    })
  ) {
    throw new InvalidParams('Workflow transition is not permitted');
  }
  return { stage: to };
}

function recoverCheckpoint(params: unknown): {
  projectId: string;
  resumeStage: PptWorkflowStage;
  lastCompleteStage: PptWorkflowStage;
} {
  const input = requireRecord(params);
  if (typeof input.projectId !== 'string') {
    throw new InvalidParams('Checkpoint projectId is required');
  }
  try {
    assertStrictIdentifier('project', input.projectId);
  } catch (error) {
    throw new InvalidParams(
      error instanceof Error ? error.message : 'Checkpoint projectId is invalid',
    );
  }
  const resumeStage = requirePptStage(input.stage, 'stage');
  if (!Array.isArray(input.completedStages) || input.completedStages.length === 0) {
    throw new InvalidParams('Checkpoint completedStages is required');
  }
  const completed = input.completedStages.map((stage) =>
    requirePptStage(stage, 'completedStages'),
  );
  const expectedPrefix = pptWorkflowStages.slice(0, completed.length);
  if (
    completed.some((stage, index) => stage !== expectedPrefix[index]) ||
    pptWorkflowStages[completed.length] !== resumeStage
  ) {
    throw new InvalidParams('Checkpoint stages are not a complete legal prefix');
  }
  return {
    projectId: input.projectId,
    resumeStage,
    lastCompleteStage: completed.at(-1)!,
  };
}

function requireNoParams(params: unknown): void {
  if (
    params !== undefined &&
    (!isRecord(params) || Object.keys(params).length > 0)
  ) {
    throw new InvalidParams('This method does not accept params');
  }
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new InvalidParams('Params must be an object');
  return value;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new InvalidParams(`${field} is required`);
  }
  return value;
}

function requireArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new InvalidParams(`${field} must be an array`);
  return value;
}

function requirePptStage(value: unknown, field: string): PptWorkflowStage {
  if (
    typeof value !== 'string' ||
    !pptWorkflowStages.includes(value as PptWorkflowStage)
  ) {
    throw new InvalidParams(`${field} is not a known workflow stage`);
  }
  return value as PptWorkflowStage;
}

function requireWorkflowStatus(value: unknown, field: string): WorkflowStatus {
  return value === 'blocked' ? value : requirePptStage(value, field);
}

function encodeError(id: RpcId, error: RpcError): string {
  return JSON.stringify({ jsonrpc: '2.0', id, error });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class MethodNotFound extends Error {}
