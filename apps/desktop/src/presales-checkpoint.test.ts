import { build } from 'esbuild';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import fixture from '../../../fixtures/presales/native-contract.json';
import timestampSpellings from '../../../fixtures/presales/rfc3339-spellings.json';
import {
  commitPresalesCheckpoint,
  loadPresalesCheckpoint,
  type PairedCheckpointCommitInput,
  type ProjectCheckpoint,
} from './presales-checkpoint.js';

const sha = (letter: string): string => letter.repeat(64);

function request(): PairedCheckpointCommitInput {
  const pair = structuredClone(fixture.pair) as unknown as PairedCheckpointCommitInput['presales'];
  pair.details = null;
  const projectId = 'project-client-paired';
  const pipeline = {
    schemaVersion: 1,
    revision: 3,
    project: {
      id: projectId, name: 'Synthetic proposal', goal: 'Test recovery',
      workflowStatus: 'outline_review', createdAt: '2026-09-10T00:00:00Z',
      updatedAt: '2026-09-10T00:02:00Z',
    },
    preferenceSnapshot: [],
    sources: [{
      id: 'source-a', fileName: 'synthetic.txt', mediaType: 'text/plain',
      relativePath: 'sources/source-a.bin', sha256: sha('a'), byteLength: 9,
    }],
    analysis: {
      requestId: 'analysis-1', output: structuredClone(fixture.analysis),
      artifactRelativePath: 'sources/analysis-1-analysis.json', sha256: sha('b'),
    },
    outline: {
      version: {
        id: `${projectId}-outline-v1`, projectId, sequence: 1, status: 'draft',
        createdAt: '2026-09-10T00:02:00Z', frozenAt: null,
      },
      value: structuredClone(pair.outline.outline),
    },
    slideSpecs: null,
    visuals: {}, currentSlideId: null, approvals: [], tasks: [],
    blockedCondition: null, exportReceipt: null, qaReport: null,
  };
  return {
    commit: {
      projectId, expectedRevision: 2, pipeline,
      writes: [{
        relativePath: 'outline/outline-r3.json', contentsBase64: 'e30=', sha256: sha('c'),
        byteLength: 2, kind: 'outline', versionId: `${projectId}-outline-v1`,
      }],
    },
    presales: pair,
  } as PairedCheckpointCommitInput;
}

function checkpoint(input = request()): ProjectCheckpoint {
  return {
    pipeline: structuredClone(input.commit.pipeline),
    presales: {
      schemaVersion: 1,
      hashAlgorithm: 'native-json-sha256-v1',
      skill: { id: 'presales-deck', version: '1.0.0', sha256: sha('d') },
      draft: structuredClone(input.presales),
      basis: {
        analysis: { requestId: 'analysis-1', artifactSha256: sha('b'), outputHash: sha('e') },
        outline: {
          versionId: 'project-client-paired-outline-v1', contentHash: sha('f'), planHash: sha('1'),
        },
        details: null,
        bindings: [],
      },
      approvalBindings: [],
    },
  } as ProjectCheckpoint;
}

function outlineApprovedCheckpoint(): ProjectCheckpoint {
  const value = checkpoint();
  const at = '2026-09-10T00:03:00Z';
  const versionId = value.presales!.basis.outline.versionId;
  value.pipeline.revision = 4;
  value.pipeline.project.workflowStatus = 'detail_review';
  value.pipeline.project.updatedAt = at;
  value.pipeline.outline!.version.status = 'frozen';
  value.pipeline.outline!.version.frozenAt = at;
  value.pipeline.approvals.push({
    id: 'outline-proof', projectId: value.pipeline.project.id, versionId,
    stage: 'outline_review', status: 'approved', decidedAt: at,
  });
  value.presales!.approvalBindings.push({
    approvalId: 'outline-proof', stage: 'outline_review', versionId,
    contentHash: value.presales!.basis.outline.contentHash,
    companionHash: value.presales!.basis.outline.planHash,
    skill: structuredClone(value.presales!.skill), decidedAt: at,
  });
  return value;
}

describe('presales checkpoint transport', () => {
  it('loads and preserves the complete native checkpoint without recalculating opaque hashes', async () => {
    const expected = checkpoint();
    const invoke = vi.fn(async () => structuredClone(expected));

    await expect(loadPresalesCheckpoint(invoke, 'project-client-paired')).resolves.toEqual(expected);
    expect(invoke).toHaveBeenCalledWith('ppt_load_checkpoint', { projectId: 'project-client-paired' });
  });

  it('loads a legacy checkpoint with an explicit null companion without inventing paired authority', async () => {
    const legacy = checkpoint();
    legacy.pipeline.analysis = null;
    legacy.pipeline.outline = null;
    legacy.pipeline.project.workflowStatus = 'intake';
    legacy.presales = null;

    await expect(loadPresalesCheckpoint(async () => legacy, 'project-client-paired')).resolves.toEqual(legacy);
  });

  it.each(['paired', 'legacy-null'])('rejects a %s checkpoint returned for another project without fallback', async (kind) => {
    const returned = checkpoint();
    returned.pipeline.project.id = 'project-response-b';
    if (kind === 'legacy-null') {
      returned.pipeline.analysis = null;
      returned.pipeline.outline = null;
      returned.pipeline.project.workflowStatus = 'intake';
      returned.presales = null;
    } else {
      returned.pipeline.outline!.version.id = 'project-response-b-outline-v1';
      returned.pipeline.outline!.version.projectId = 'project-response-b';
      returned.presales!.basis.outline.versionId = 'project-response-b-outline-v1';
    }
    const invoke = vi.fn(async () => structuredClone(returned));

    await expect(loadPresalesCheckpoint(invoke, 'project-request-a')).rejects.toThrow(/project identity/i);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('ppt_load_checkpoint', { projectId: 'project-request-a' });
  });

  it('snapshots the validated request before await and validates a direct success against it', async () => {
    const input = request();
    const expected = checkpoint(input);
    let resolveCommit!: (value: unknown) => void;
    const pending = new Promise<unknown>((resolve) => { resolveCommit = resolve; });
    const invoke = vi.fn(async () => pending);

    const committing = commitPresalesCheckpoint(invoke, input);
    input.presales.outline.outline.title = 'mutated after dispatch';
    input.commit.pipeline.revision = 99;
    resolveCommit(structuredClone(expected));

    await expect(committing).resolves.toEqual(expected);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]).toEqual(['ppt_commit_checkpoint', {
      input: expect.objectContaining({ presales: expected.presales!.draft }),
    }]);
  });

  it('uses one read after a lost response and never replays the commit', async () => {
    const input = request();
    const expected = checkpoint(input);
    const invoke = vi.fn(async (command: string) => {
      if (command === 'ppt_commit_checkpoint') throw new Error('response lost');
      if (command === 'ppt_load_checkpoint') return structuredClone(expected);
      throw new Error(`unexpected ${command}`);
    });

    await expect(commitPresalesCheckpoint(invoke, input)).resolves.toEqual(expected);
    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      'ppt_commit_checkpoint', 'ppt_load_checkpoint',
    ]);
  });

  it.each([
    ['pipeline', (value: ProjectCheckpoint) => { value.pipeline.revision = 4; }],
    ['pair', (value: ProjectCheckpoint) => { value.presales!.draft.outline.plan.pages[0]!.keyMessage = 'other'; }],
  ])('reports a conflict after one recovery read when the %s differs', async (_name, mutate) => {
    const input = request();
    const persisted = checkpoint(input);
    mutate(persisted);
    const invoke = vi.fn(async (command: string) => {
      if (command === 'ppt_commit_checkpoint') throw new Error('response lost');
      return persisted;
    });

    await expect(commitPresalesCheckpoint(invoke, input)).rejects.toThrow(/conflict/i);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('rejects inconsistent native identity after one recovery read', async () => {
    const persisted = checkpoint();
    persisted.presales!.basis.outline.versionId = 'other-version';
    const invoke = vi.fn(async (command: string) => {
      if (command === 'ppt_commit_checkpoint') throw new Error('response lost');
      return persisted;
    });

    await expect(commitPresalesCheckpoint(invoke, request())).rejects.toThrow(/identity/i);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('requires approval proof timestamps to remain RFC3339 identity values', async () => {
    const valid = outlineApprovedCheckpoint();
    await expect(loadPresalesCheckpoint(async () => valid, valid.pipeline.project.id)).resolves.toEqual(valid);

    const invalid = structuredClone(valid);
    invalid.pipeline.approvals[0]!.decidedAt = 'not-a-timestamp';
    invalid.pipeline.outline!.version.frozenAt = 'not-a-timestamp';
    invalid.presales!.approvalBindings[0]!.decidedAt = 'not-a-timestamp';
    await expect(loadPresalesCheckpoint(async () => invalid, invalid.pipeline.project.id)).rejects.toThrow(/RFC3339/i);
  });

  it.each(timestampSpellings.accepted)('preserves the native-accepted approval timestamp %s', async (timestamp) => {
    const valid = outlineApprovedCheckpoint();
    valid.pipeline.project.updatedAt = timestamp;
    valid.pipeline.outline!.version.frozenAt = timestamp;
    valid.pipeline.approvals[0]!.decidedAt = timestamp;
    valid.presales!.approvalBindings[0]!.decidedAt = timestamp;

    const loaded = await loadPresalesCheckpoint(async () => structuredClone(valid), valid.pipeline.project.id);
    expect(loaded.pipeline.project.updatedAt).toBe(timestamp);
    expect(loaded.pipeline.outline!.version.frozenAt).toBe(timestamp);
    expect(loaded.pipeline.approvals[0]!.decidedAt).toBe(timestamp);
    expect(loaded.presales!.approvalBindings[0]!.decidedAt).toBe(timestamp);
  });

  it.each(timestampSpellings.rejected)('rejects the native-rejected approval timestamp %s', async (timestamp) => {
    const invalid = outlineApprovedCheckpoint();
    invalid.pipeline.project.updatedAt = timestamp;
    invalid.pipeline.outline!.version.frozenAt = timestamp;
    invalid.pipeline.approvals[0]!.decidedAt = timestamp;
    invalid.presales!.approvalBindings[0]!.decidedAt = timestamp;

    await expect(loadPresalesCheckpoint(async () => invalid, invalid.pipeline.project.id)).rejects.toThrow(/RFC3339/i);
  });

  it('rejects an approval proof attributed to a different project', async () => {
    const invalid = outlineApprovedCheckpoint();
    invalid.pipeline.approvals[0]!.projectId = 'other-project';

    await expect(loadPresalesCheckpoint(async () => invalid, invalid.pipeline.project.id)).rejects.toThrow(/approval identity/i);
  });

  it('does not turn a malformed successful response into a recovery read', async () => {
    const invoke = vi.fn(async () => ({ pipeline: {}, presales: {} }));

    await expect(commitPresalesCheckpoint(invoke, request())).rejects.toThrow(/checkpoint/i);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('rejects a malformed recovery read after exactly two invocations', async () => {
    const invoke = vi.fn(async (command: string) => {
      if (command === 'ppt_commit_checkpoint') throw new Error('response lost');
      return { pipeline: {}, presales: {} };
    });

    await expect(commitPresalesCheckpoint(invoke, request())).rejects.toThrow(/checkpoint/i);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('bundles the otherwise-unused transport for a browser without Node runtime dependencies', async () => {
    const result = await build({
      entryPoints: [resolve(import.meta.dirname, 'presales-checkpoint.ts')],
      bundle: true,
      platform: 'browser',
      format: 'esm',
      write: false,
      logLevel: 'silent',
    });

    expect(result.outputFiles).toHaveLength(1);
  });
});
