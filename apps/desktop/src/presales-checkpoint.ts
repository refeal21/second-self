import type {
  NativeArtifactWrite,
  NativePptPipeline,
} from '../../worker/src/native-pipeline.js';
import type { DetailsEnvelope, OutlineEnvelope } from '../../worker/src/presales/contracts.js';
import {
  parseDetailsEnvelope,
  parseOutlineEnvelope,
} from '../../worker/src/presales/validation.js';

export type NativeCheckpointInvoker = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

export interface PresalesDraftPair {
  schemaVersion: 1;
  outline: OutlineEnvelope;
  details: DetailsEnvelope | null;
}

export interface PairedPipelineCommit {
  projectId: string;
  expectedRevision: number;
  pipeline: NativePptPipeline;
  writes: NativeArtifactWrite[];
  visualRequestId?: string | null;
  visualProvider?: { threadId?: string; turnId?: string; itemId?: string } | null;
  expectedStyleRevision?: number | null;
}

export interface PairedCheckpointCommitInput {
  commit: PairedPipelineCommit;
  presales: PresalesDraftPair;
}

export interface SkillIdentity {
  id: string;
  version: string;
  sha256: string;
}

export interface PresalesCheckpoint {
  schemaVersion: 1;
  hashAlgorithm: 'native-json-sha256-v1';
  skill: SkillIdentity;
  draft: PresalesDraftPair;
  basis: {
    analysis: { requestId: string; artifactSha256: string; outputHash: string };
    outline: { versionId: string; contentHash: string; planHash: string };
    details: null | { versionId: string; contentHash: string; designHash: string };
    bindings: Array<{ slideId: string; id: string; path: string; visibleValueHash: string }>;
  };
  approvalBindings: Array<{
    approvalId: string;
    stage: string;
    versionId: string;
    contentHash: string;
    companionHash: string;
    skill: SkillIdentity;
    decidedAt: string;
  }>;
}

export interface ProjectCheckpoint {
  pipeline: NativePptPipeline;
  presales: PresalesCheckpoint | null;
}

export async function loadPresalesCheckpoint(
  invoke: NativeCheckpointInvoker,
  projectId: string,
): Promise<ProjectCheckpoint> {
  if (!projectId.trim()) throw new Error('Presales checkpoint projectId is required');
  return parseProjectCheckpoint(await invoke('ppt_load_checkpoint', { projectId }));
}

export async function commitPresalesCheckpoint(
  invoke: NativeCheckpointInvoker,
  input: PairedCheckpointCommitInput,
): Promise<ProjectCheckpoint> {
  const requested = snapshotCommitInput(input);
  let response: unknown;
  try {
    response = await invoke('ppt_commit_checkpoint', { input: requested });
  } catch (commitError) {
    let recovered: unknown;
    try {
      recovered = await invoke('ppt_load_checkpoint', {
        projectId: requested.commit.projectId,
      });
    } catch (loadError) {
      throw new Error(
        `Presales checkpoint commit result is uncertain: ${message(commitError)}; recovery read failed: ${message(loadError)}`,
      );
    }
    return matchingCommittedCheckpoint(recovered, requested);
  }
  return matchingCommittedCheckpoint(response, requested);
}

function snapshotCommitInput(input: PairedCheckpointCommitInput): PairedCheckpointCommitInput {
  const root = exactObject(input, ['commit', 'presales'], [], 'commit input');
  const commit = exactObject(
    root.commit,
    ['projectId', 'expectedRevision', 'pipeline', 'writes'],
    ['visualRequestId', 'visualProvider', 'expectedStyleRevision'],
    'pipeline commit',
  );
  const projectId = nonEmptyString(commit.projectId, 'pipeline commit projectId');
  const expectedRevision = safeInteger(commit.expectedRevision, 'pipeline commit expectedRevision', 0);
  const pipeline = pipelineRecord(commit.pipeline);
  if (pipeline.project.id !== projectId || pipeline.revision !== expectedRevision + 1) {
    throw new Error('Presales checkpoint request pipeline identity or revision is invalid');
  }
  validateDraftPair(root.presales, pipeline);
  const writes = array(commit.writes, 'pipeline commit writes').map((value, index) => {
    const write = exactObject(
      value,
      ['relativePath', 'contentsBase64', 'sha256', 'byteLength', 'kind', 'versionId'],
      ['slideId', 'metadata'],
      `pipeline commit write ${index}`,
    );
    nonEmptyString(write.relativePath, 'artifact relativePath');
    string(write.contentsBase64, 'artifact contentsBase64');
    hash(write.sha256, 'artifact sha256');
    safeInteger(write.byteLength, 'artifact byteLength', 0);
    nonEmptyString(write.kind, 'artifact kind');
    nonEmptyString(write.versionId, 'artifact versionId');
    if (Object.hasOwn(write, 'slideId') && write.slideId !== null) {
      nonEmptyString(write.slideId, 'artifact slideId');
    }
    if (Object.hasOwn(write, 'metadata') && write.metadata !== null) {
      object(write.metadata, 'artifact metadata');
    }
    return write;
  });
  if (new Set(writes.map((write) => write.relativePath)).size !== writes.length) {
    throw new Error('Presales checkpoint request contains duplicate artifact paths');
  }
  return structuredClone(input);
}

function matchingCommittedCheckpoint(
  value: unknown,
  requested: PairedCheckpointCommitInput,
): ProjectCheckpoint {
  const checkpoint = parseProjectCheckpoint(value);
  if (
    checkpoint.presales === null
    || checkpoint.pipeline.revision !== requested.commit.pipeline.revision
    || !sameJson(checkpoint.pipeline, requested.commit.pipeline)
    || !sameJson(checkpoint.presales.draft, requested.presales)
  ) {
    throw new Error('Presales checkpoint conflict: persisted state differs from the requested commit');
  }
  return checkpoint;
}

function parseProjectCheckpoint(value: unknown): ProjectCheckpoint {
  const checkpoint = exactObject(value, ['pipeline', 'presales'], [], 'checkpoint');
  const pipeline = pipelineRecord(checkpoint.pipeline);
  if (checkpoint.presales === null) {
    return structuredClone({ pipeline, presales: null }) as ProjectCheckpoint;
  }
  const presales = exactObject(
    checkpoint.presales,
    ['schemaVersion', 'hashAlgorithm', 'skill', 'draft', 'basis', 'approvalBindings'],
    [],
    'presales checkpoint',
  );
  if (presales.schemaVersion !== 1 || presales.hashAlgorithm !== 'native-json-sha256-v1') {
    throw new Error('Presales checkpoint identity header is invalid');
  }
  const skill = skillIdentity(presales.skill, 'presales checkpoint skill');
  const draft = validateDraftPair(presales.draft, pipeline);
  const basis = exactObject(
    presales.basis,
    ['analysis', 'outline', 'details', 'bindings'],
    [],
    'presales checkpoint basis',
  );
  const analysis = exactObject(
    basis.analysis,
    ['requestId', 'artifactSha256', 'outputHash'],
    [],
    'presales analysis basis',
  );
  const pipelineAnalysis = object(pipeline.analysis, 'paired pipeline analysis');
  if (
    nonEmptyString(analysis.requestId, 'analysis basis requestId') !== pipelineAnalysis.requestId
    || hash(analysis.artifactSha256, 'analysis basis artifactSha256') !== pipelineAnalysis.sha256
  ) {
    throw new Error('Presales checkpoint analysis identity is inconsistent');
  }
  hash(analysis.outputHash, 'analysis basis outputHash');

  const outline = exactObject(
    basis.outline,
    ['versionId', 'contentHash', 'planHash'],
    [],
    'presales outline basis',
  );
  const pipelineOutline = object(pipeline.outline, 'paired pipeline outline');
  const outlineVersion = object(pipelineOutline.version, 'paired outline version');
  if (nonEmptyString(outline.versionId, 'outline basis versionId') !== outlineVersion.id) {
    throw new Error('Presales checkpoint outline identity is inconsistent');
  }
  hash(outline.contentHash, 'outline basis contentHash');
  hash(outline.planHash, 'outline basis planHash');

  let detailsBasis: PresalesCheckpoint['basis']['details'] = null;
  if (basis.details !== null) {
    const details = exactObject(
      basis.details,
      ['versionId', 'contentHash', 'designHash'],
      [],
      'presales details basis',
    );
    const pipelineDetails = object(pipeline.slideSpecs, 'paired pipeline slideSpecs');
    const detailsVersion = object(pipelineDetails.version, 'paired detail version');
    if (nonEmptyString(details.versionId, 'details basis versionId') !== detailsVersion.id) {
      throw new Error('Presales checkpoint detail identity is inconsistent');
    }
    detailsBasis = {
      versionId: details.versionId as string,
      contentHash: hash(details.contentHash, 'details basis contentHash'),
      designHash: hash(details.designHash, 'details basis designHash'),
    };
  }
  if ((draft.details === null) !== (detailsBasis === null)) {
    throw new Error('Presales checkpoint details identity is inconsistent');
  }

  const expectedBindings = draft.details?.designs.flatMap((design) =>
    design.textBindings.map(({ id, path }) => ({ slideId: design.slideId, id, path }))) ?? [];
  const bindings = array(basis.bindings, 'presales binding basis').map((value, index) => {
    const binding = exactObject(
      value,
      ['slideId', 'id', 'path', 'visibleValueHash'],
      [],
      `presales binding basis ${index}`,
    );
    const identity = {
      slideId: nonEmptyString(binding.slideId, 'binding slideId'),
      id: nonEmptyString(binding.id, 'binding id'),
      path: nonEmptyString(binding.path, 'binding path'),
    };
    if (!sameJson(identity, expectedBindings[index])) {
      throw new Error('Presales checkpoint visible binding identity is inconsistent');
    }
    return { ...identity, visibleValueHash: hash(binding.visibleValueHash, 'binding visibleValueHash') };
  });
  if (bindings.length !== expectedBindings.length) {
    throw new Error('Presales checkpoint visible binding identity is incomplete');
  }

  const approvals = array(pipeline.approvals, 'paired pipeline approvals');
  const approvalBindings = array(presales.approvalBindings, 'presales approval bindings')
    .map((value, index) => approvalBinding(value, approvals[index], pipeline.project.id, skill, {
      outline: {
        versionId: outline.versionId as string,
        contentHash: outline.contentHash as string,
        companionHash: outline.planHash as string,
      },
      details: detailsBasis === null ? null : {
        versionId: detailsBasis.versionId,
        contentHash: detailsBasis.contentHash,
        companionHash: detailsBasis.designHash,
      },
    }, index));
  if (approvalBindings.length !== approvals.length || approvalBindings.length > 2) {
    throw new Error('Presales checkpoint approval identity is incomplete');
  }
  validateLifecycle(pipeline, approvalBindings);

  return structuredClone(value) as ProjectCheckpoint;
}

function validateDraftPair(value: unknown, pipeline: NativePptPipeline): PresalesDraftPair {
  const pair = exactObject(value, ['schemaVersion', 'outline', 'details'], [], 'presales draft');
  if (pair.schemaVersion !== 1) throw new Error('Presales draft schemaVersion is invalid');
  if (pipeline.analysis === null || pipeline.outline === null) {
    throw new Error('Presales checkpoint pipeline is missing its paired authority');
  }
  const analysis = object(pipeline.analysis, 'paired pipeline analysis');
  const parsedOutline = parseOutlineEnvelope(pair.outline, analysis.output as never);
  const parsedDetails = pair.details === null
    ? null
    : parseDetailsEnvelope(pair.details, parsedOutline, analysis.output as never);
  const pipelineOutline = object(pipeline.outline, 'paired pipeline outline');
  if (!sameJson(parsedOutline.outline, pipelineOutline.value)) {
    throw new Error('Presales draft outline does not match the pipeline');
  }
  if (
    (parsedDetails === null) !== (pipeline.slideSpecs === null)
    || (parsedDetails !== null
      && !sameJson(parsedDetails.specs, object(pipeline.slideSpecs, 'paired slideSpecs').value))
  ) {
    throw new Error('Presales draft details do not match the pipeline');
  }
  return structuredClone(value) as PresalesDraftPair;
}

function pipelineRecord(value: unknown): NativePptPipeline {
  const pipeline = object(value, 'checkpoint pipeline');
  const revision = safeInteger(pipeline.revision, 'checkpoint pipeline revision', 1);
  const project = object(pipeline.project, 'checkpoint pipeline project');
  nonEmptyString(project.id, 'checkpoint pipeline project id');
  if (!Object.hasOwn(pipeline, 'slideSpecs')) {
    throw new Error('Presales checkpoint pipeline requires an explicit slideSpecs slot');
  }
  return { ...pipeline, revision, project } as unknown as NativePptPipeline;
}

function approvalBinding(
  value: unknown,
  pipelineValue: unknown,
  projectId: string,
  checkpointSkill: SkillIdentity,
  basis: {
    outline: { versionId: string; contentHash: string; companionHash: string };
    details: null | { versionId: string; contentHash: string; companionHash: string };
  },
  index: number,
): PresalesCheckpoint['approvalBindings'][number] {
  const binding = exactObject(
    value,
    ['approvalId', 'stage', 'versionId', 'contentHash', 'companionHash', 'skill', 'decidedAt'],
    [],
    `presales approval binding ${index}`,
  );
  const approval = exactObject(
    pipelineValue,
    ['id', 'projectId', 'versionId', 'stage', 'status', 'decidedAt'],
    [],
    `pipeline approval ${index}`,
  );
  const expectedStage = index === 0 ? 'outline_review' : 'detail_review';
  const expectedBasis = index === 0 ? basis.outline : basis.details;
  const skill = skillIdentity(binding.skill, `approval binding ${index} skill`);
  const decidedAt = rfc3339(binding.decidedAt, 'approval binding decidedAt');
  if (
    expectedBasis === null
    || binding.stage !== expectedStage
    || binding.approvalId !== approval.id
    || approval.projectId !== projectId
    || binding.stage !== approval.stage
    || binding.versionId !== approval.versionId
    || binding.decidedAt !== approval.decidedAt
    || approval.status !== 'approved'
    || binding.versionId !== expectedBasis.versionId
    || binding.contentHash !== expectedBasis.contentHash
    || binding.companionHash !== expectedBasis.companionHash
    || !sameJson(skill, checkpointSkill)
  ) {
    throw new Error('Presales checkpoint approval identity is inconsistent');
  }
  hash(binding.contentHash, 'approval contentHash');
  hash(binding.companionHash, 'approval companionHash');
  return {
    approvalId: nonEmptyString(binding.approvalId, 'approval binding approvalId'),
    stage: expectedStage,
    versionId: nonEmptyString(binding.versionId, 'approval binding versionId'),
    contentHash: binding.contentHash as string,
    companionHash: binding.companionHash as string,
    skill,
    decidedAt,
  };
}

function validateLifecycle(
  pipeline: NativePptPipeline,
  approvals: PresalesCheckpoint['approvalBindings'],
): void {
  const project = object(pipeline.project, 'paired pipeline project');
  const outline = object(pipeline.outline, 'paired pipeline outline');
  const outlineVersion = object(outline.version, 'paired outline version');
  if (approvals.length === 0) {
    if (
      project.workflowStatus !== 'outline_review'
      || outlineVersion.status !== 'draft'
      || outlineVersion.frozenAt !== null
      || pipeline.slideSpecs !== null
      || pipeline.currentSlideId !== null
    ) throw new Error('Presales checkpoint lifecycle is inconsistent');
    return;
  }
  if (
    outlineVersion.status !== 'frozen'
    || outlineVersion.frozenAt !== approvals[0]!.decidedAt
  ) throw new Error('Presales checkpoint outline lifecycle is inconsistent');
  if (approvals.length === 1) {
    if (project.workflowStatus !== 'detail_review' || pipeline.currentSlideId !== null) {
      throw new Error('Presales checkpoint detail draft lifecycle is inconsistent');
    }
    if (pipeline.slideSpecs !== null) {
      const version = object(object(pipeline.slideSpecs, 'paired slideSpecs').version, 'detail version');
      if (version.status !== 'draft' || version.frozenAt !== null) {
        throw new Error('Presales checkpoint detail draft lifecycle is inconsistent');
      }
    }
    return;
  }
  const slideSpecs = object(pipeline.slideSpecs, 'paired slideSpecs');
  const detailsVersion = object(slideSpecs.version, 'paired detail version');
  const specs = array(slideSpecs.value, 'paired slide specs');
  if (
    project.workflowStatus !== 'visual_review'
    || detailsVersion.status !== 'frozen'
    || detailsVersion.frozenAt !== approvals[1]!.decidedAt
    || pipeline.currentSlideId !== object(specs[0], 'first slide spec').id
  ) throw new Error('Presales checkpoint detail lifecycle is inconsistent');
}

function skillIdentity(value: unknown, path: string): SkillIdentity {
  const skill = exactObject(value, ['id', 'version', 'sha256'], [], path);
  return {
    id: nonEmptyString(skill.id, `${path} id`),
    version: nonEmptyString(skill.version, `${path} version`),
    sha256: hash(skill.sha256, `${path} sha256`),
  };
}

function exactObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  path: string,
): Record<string, unknown> {
  const result = object(value, path);
  const allowed = new Set([...required, ...optional]);
  if (Object.keys(result).some((key) => !allowed.has(key))) {
    throw new Error(`${path} has unknown fields`);
  }
  if (required.some((key) => !Object.hasOwn(result, key))) {
    throw new Error(`${path} has missing fields`);
  }
  return result;
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  return value;
}

function string(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new Error(`${path} must be a string`);
  return value;
}

function nonEmptyString(value: unknown, path: string): string {
  const result = string(value, path);
  if (!result) throw new Error(`${path} must not be empty`);
  return result;
}

function hash(value: unknown, path: string): string {
  const result = string(value, path);
  if (!/^[0-9a-f]{64}$/u.test(result)) throw new Error(`${path} must be a lowercase SHA-256`);
  return result;
}

function safeInteger(value: unknown, path: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new Error(`${path} must be a safe integer`);
  }
  return value as number;
}

function rfc3339(value: unknown, path: string): string {
  const result = string(value, path);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(result)
    || Number.isNaN(Date.parse(result))
  ) throw new Error(`${path} must be RFC3339`);
  return result;
}

function sameJson(left: unknown, right: unknown): boolean {
  const canonical = (value: unknown): string => JSON.stringify(value, (_key, entry: unknown) =>
    entry !== null && typeof entry === 'object' && !Array.isArray(entry)
      ? Object.fromEntries(Object.entries(entry).sort(([leftKey], [rightKey]) =>
        leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0))
      : entry);
  return canonical(left) === canonical(right);
}

function message(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
