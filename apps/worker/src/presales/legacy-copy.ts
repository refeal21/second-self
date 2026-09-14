import { createHash } from 'node:crypto';
import { validateNativePipelineCheckpoint, type NativePptPipeline } from '../native-pipeline.js';

export interface LegacyCopyValidation {
  schemaVersion: 1;
  validator: 'native-pipeline-checkpoint-v1';
  snapshotSha256: string;
  byteLength: number;
  projectId: string;
  revision: number;
  pipelineSchemaVersion: 1 | 2;
}

/** Pure offline validation of the exact UTF-8 snapshot supplied by native code.
 * The result is evidence only when received by the private native child host.
 */
export function validateLegacyCopySnapshot(snapshot: unknown): LegacyCopyValidation {
  if (typeof snapshot !== 'string' || snapshot.length === 0
    || Buffer.byteLength(snapshot, 'utf8') > 4 * 1024 * 1024) {
    throw new Error('Legacy snapshot must be bounded exact UTF-8 JSON');
  }
  const pipeline = JSON.parse(snapshot) as NativePptPipeline;
  validateNativePipelineCheckpoint(pipeline);
  return {
    schemaVersion: 1,
    validator: 'native-pipeline-checkpoint-v1',
    snapshotSha256: createHash('sha256').update(snapshot, 'utf8').digest('hex'),
    byteLength: Buffer.byteLength(snapshot, 'utf8'),
    projectId: pipeline.project.id,
    revision: pipeline.revision,
    pipelineSchemaVersion: pipeline.schemaVersion,
  };
}

/** This allowlist belongs to the isolated --presales-validate process mode.
 * It does not instantiate/restore a runtime or expose provider actions.
 */
export function handleLegacyCopyValidatorLine(line: string): string {
  let id: string | null = null;
  try {
    if (Buffer.byteLength(line) > 9 * 1024 * 1024) throw new Error('Request exceeds limit');
    const request: unknown = JSON.parse(line);
    if (!record(request) || request.jsonrpc !== '2.0' || typeof request.id !== 'string'
      || request.id.length === 0 || request.id.length > 128
      || Object.keys(request).sort().join(',') !== 'id,jsonrpc,method,params') {
      throw new Error('Invalid validation request');
    }
    id = request.id;
    if (request.method !== 'presales.legacy.validate') {
      return JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
    }
    const params = request.params;
    if (!record(params) || Object.keys(params).sort().join(',') !== 'generation,snapshot'
      || !Number.isSafeInteger(params.generation) || (params.generation as number) < 1) {
      throw new Error('Invalid validation parameters');
    }
    return JSON.stringify({ jsonrpc: '2.0', id, result: {
      generation: params.generation, validation: validateLegacyCopySnapshot(params.snapshot),
    } });
  } catch (error) {
    return JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32602,
      message: error instanceof Error ? error.message : 'Invalid snapshot' } });
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
