import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createNativePipeline, NativePptRpcRuntime } from '../native-pipeline.js';
import { validateLegacyCopySnapshot, handleLegacyCopyValidatorLine } from './legacy-copy.js';
import { sourceAnalysis, scenarioOutline, scenarioDetails } from './fixtures.test-support.js';

const pipeline = () => createNativePipeline({
  id: 'synthetic-legacy', name: 'Synthetic legacy copy', goal: 'Validate immutable copy',
  createdAt: '2026-09-11T00:00:00Z', preferenceSnapshot: [],
});

describe('offline legacy copy replay boundary', () => {
  it('binds successful validation to exact bytes, including insignificant whitespace', () => {
    const compact = JSON.stringify(pipeline());
    const spaced = JSON.stringify(pipeline(), null, 2);
    const result = validateLegacyCopySnapshot(compact);
    expect(result).toEqual({ schemaVersion: 1, validator: 'native-pipeline-checkpoint-v1',
      snapshotSha256: createHash('sha256').update(compact).digest('hex'),
      byteLength: Buffer.byteLength(compact), projectId: 'synthetic-legacy', revision: 1, pipelineSchemaVersion: 1 });
    expect(validateLegacyCopySnapshot(spaced).snapshotSha256).not.toBe(result.snapshotSha256);
  });

  it('rejects unsupported schema, malformed JSON, unbounded input and caller validity flags', () => {
    for (const snapshot of [{ schemaVersion: 3 }, JSON.stringify({ schemaVersion: 3 }), '{',
      ' '.repeat(4 * 1024 * 1024 + 1), { valid: true, snapshot: JSON.stringify(pipeline()) }]) {
      expect(() => validateLegacyCopySnapshot(snapshot)).toThrow();
    }
  });

  it('runs complete checkpoint validation and rejects an impossible approval replay', () => {
    const forged = pipeline();
    forged.approvals.push({ id: 'forged', projectId: forged.project.id, versionId: 'absent',
      stage: 'outline_review', status: 'approved', decidedAt: '2026-09-11T00:00:00Z' });
    expect(() => validateLegacyCopySnapshot(JSON.stringify(forged))).toThrow();
  });

  it('validates real v2 revision replay and rejects a forged historical approval', async () => {
    const runtime = new NativePptRpcRuntime({ imageGenAvailable: false });
    const intake = pipeline();
    intake.sources.push({ id: 'source-a', fileName: 'synthetic.txt', mediaType: 'text/plain',
      relativePath: 'sources/synthetic.txt', sha256: 'a'.repeat(64), byteLength: 1 });
    await runtime.restore(intake);
    const projectId = intake.project.id;
    const at = '2026-09-11T00:00:00Z';
    await runtime.execute(projectId, { kind: 'analysis.commit', at, requestId: 'analysis-one', output: sourceAnalysis() });
    await runtime.execute(projectId, { kind: 'outline.submit', at, outline: scenarioOutline().outline });
    await runtime.execute(projectId, { kind: 'outline.approve', at });
    await runtime.execute(projectId, { kind: 'details.submit', at, specs: scenarioDetails().specs });
    const before = runtime.snapshot(projectId);
    const revised = scenarioOutline().outline;
    revised.slides[0]!.purpose = 'An explicitly revised purpose';
    const pending = await runtime.execute(projectId, { kind: 'outline.revision.save', at,
      expectedRevision: before.revision, revisionId: 'revision-new', baseOutlineVersionId: before.outline!.version.id,
      outline: revised, specs: scenarioDetails().specs });
    const result = await runtime.execute(projectId, { kind: 'outline.revision.approve', at,
      expectedRevision: pending.pipeline.revision, revisionId: 'revision-new', baseOutlineVersionId: before.outline!.version.id });
    expect(validateLegacyCopySnapshot(JSON.stringify(result.pipeline)).pipelineSchemaVersion).toBe(2);
    const forged = structuredClone(result.pipeline);
    forged.approvals[0]!.id = 'forged-old-approval';
    expect(() => validateLegacyCopySnapshot(JSON.stringify(forged))).toThrow();
  });

  it('echoes private correlation while exposing only offline validation in its process mode', () => {
    const request = { jsonrpc: '2.0', id: 'copy-17', method: 'presales.legacy.validate',
      params: { generation: 7, snapshot: JSON.stringify(pipeline()) } };
    const response = JSON.parse(handleLegacyCopyValidatorLine(JSON.stringify(request)));
    expect(response.id).toBe('copy-17');
    expect(response.result.generation).toBe(7);
    expect(response.result.validation.projectId).toBe('synthetic-legacy');
    for (const method of ['ppt.project.execute', 'ppt.project.restore', 'test.crash']) {
      expect(JSON.parse(handleLegacyCopyValidatorLine(JSON.stringify({ ...request, method }))).error.code).toBe(-32601);
    }
    expect(JSON.parse(handleLegacyCopyValidatorLine(JSON.stringify({ ...request,
      params: { ...request.params, valid: true } }))).error.code).toBe(-32602);
  });
});
