import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { isAbsolute, join, resolve } from 'node:path';

import type { AppServerExit, AppServerTransport } from '../../worker/src/app-server.js';
import {
  createDistinctApprovedVisual,
  goldenOutline,
  goldenSlideSpecs,
  goldenSourceAnalysis,
} from '../../worker/src/golden-project.js';
import type {
  NativePipelineAction,
  NativePipelineResult,
  NativePptPipeline,
  NativePreferenceSnapshot,
} from '../../worker/src/native-pipeline.js';
import {
  detectLikelyTofuGlyphs,
} from '../../worker/src/native-pipeline.js';
import { inspectPptxOoxml } from '../../worker/src/libreoffice-qa.js';
import { createTauriDesktopAdapter } from '../src/desktop-adapter.js';
import type {
  WorkflowWorkerGateway,
  WorkflowWorkerHealth,
} from '../src/workflow-worker-client.js';

const repository = resolve(import.meta.dirname, '../../..');
const evidenceRoot = join(repository, 'artifacts/qa/production-harness');
const databasePath = join(evidenceRoot, 'workbench.sqlite3');
const workspacePath = join(evidenceRoot, 'workspace');
const rustBinary = process.env.DIGITAL_TWIN_PRODUCTION_HARNESS ?? join(
  repository,
  'apps/desktop/src-tauri/target/release/production-harness',
);
const samplerBinary = process.env.DIGITAL_TWIN_RSS_SAMPLER ?? join(
  repository,
  'apps/desktop/src-tauri/target/release/process-rss-sampler',
);
const workerBinary = process.env.DIGITAL_TWIN_PACKAGED_WORKER ?? join(
  repository,
  'apps/desktop/src-tauri/target/release/bundle/macos',
  'Digital Twin Workbench.app/Contents/MacOS/digital-twin-worker',
);
assert.ok(isAbsolute(workerBinary), 'DIGITAL_TWIN_PACKAGED_WORKER must be an absolute binary path');
const fixtureRoot = join(repository, 'fixtures/golden-project/sources');

interface JsonLineResponse { id: number; result?: unknown; error?: unknown }

interface MemoryEvidence {
  rootPid: number;
  sampleCount: number;
  peakRssKiB: number;
  peakRssMiB: number;
  gateMiB: number;
  passed: boolean;
}

class OperationRssSamplerProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private result: MemoryEvidence | null = null;

  constructor(private readonly outputPath: string) {
    this.child = spawn(samplerBinary, [
      '--root-pid', String(process.pid),
      '--output', outputPath,
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  }

  mark(operation: string): void {
    if (this.result || this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.stdin.write(`${JSON.stringify({ operation, at: new Date().toISOString() })}\n`);
  }

  async stop(): Promise<MemoryEvidence> {
    if (this.result) return this.result;
    if (this.child.exitCode === null && this.child.signalCode === null) {
      const exited = once(this.child, 'exit');
      this.child.stdin.end(`${JSON.stringify({ stop: true })}\n`);
      await exited;
    }
    if (this.child.exitCode !== 0) throw new Error(`RSS sampler exited with code ${this.child.exitCode}`);
    this.result = JSON.parse(await readFile(this.outputPath, 'utf8')) as MemoryEvidence;
    return this.result;
  }
}

class JsonLineProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly lines: AsyncIterator<string>;
  private requestId = 1;

  constructor(command: string, args: string[]) {
    this.child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PATH: '' },
    });
    this.lines = createInterface({ input: this.child.stdout })[Symbol.asyncIterator]();
  }

  async call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    const id = this.requestId++;
    this.child.stdin.write(`${JSON.stringify({ id, command, args: args ?? {} })}\n`);
    const next = await this.lines.next();
    if (next.done) throw new Error(`${command} process closed stdout`);
    const response = JSON.parse(next.value) as JsonLineResponse;
    if (response.id !== id) throw new Error(`${command} response id is out of order`);
    if (response.error !== undefined) throw new Error(String(response.error));
    return response.result as T;
  }

  async close(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    await this.call('harness.close');
    await once(this.child, 'exit');
  }
}

class PackagedWorkerGateway implements WorkflowWorkerGateway {
  private child: ChildProcessWithoutNullStreams | null = null;
  private lines: AsyncIterator<string> | null = null;
  private requestId = 1;

  async health(): Promise<WorkflowWorkerHealth> {
    return this.call('system.health');
  }

  createProject(input: {
    id: string;
    name: string;
    goal: string;
    createdAt: string;
    preferenceSnapshot: NativePreferenceSnapshot[];
  }): Promise<NativePipelineResult> {
    return this.call('ppt.project.create', input);
  }

  restoreProject(pipeline: NativePptPipeline): Promise<NativePptPipeline> {
    return this.call('ppt.project.restore', { pipeline });
  }

  executeProject(projectId: string, action: NativePipelineAction): Promise<NativePipelineResult> {
    return this.call('ppt.project.execute', { projectId, action });
  }

  snapshotProject(projectId: string): Promise<NativePptPipeline> {
    return this.call('ppt.project.snapshot', { projectId });
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.health();
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.lines = null;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
  }

  private async call<T>(method: string, params?: unknown): Promise<T> {
    this.start();
    const child = this.child!;
    const lines = this.lines!;
    const id = this.requestId++;
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    const next = await lines.next();
    if (next.done) throw new Error(`Embedded Worker closed stdout during ${method}`);
    const response = JSON.parse(next.value) as {
      id: number;
      result?: T;
      error?: { code: number; message: string };
    };
    if (response.id !== id) throw new Error(`Embedded Worker response id is out of order for ${method}`);
    if (response.error) throw new Error(`${response.error.code}: ${response.error.message}`);
    return response.result as T;
  }

  private start(): void {
    if (this.child) return;
    const child = spawn(workerBinary, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stderr.on('data', (chunk) => process.stderr.write(chunk));
    this.child = child;
    this.lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  }
}

class ScriptedCodexTransport implements AppServerTransport {
  private readonly lineListeners = new Set<(line: string) => void>();
  private readonly exitListeners = new Set<(detail: AppServerExit) => void>();
  private outputIndex = 0;
  private threadIndex = 0;
  readonly methods: string[] = [];

  constructor(private readonly outputs: readonly unknown[]) {}

  async start(): Promise<void> {}

  async send(line: string): Promise<void> {
    const request = JSON.parse(line) as { id?: number; method: string; params?: unknown };
    this.methods.push(request.method);
    if (request.id === undefined) return;
    if (request.method === 'initialize') {
      this.emit({ id: request.id, result: { serverInfo: { name: 'scripted-codex', version: '1' } } });
      return;
    }
    if (request.method === 'account/read') {
      this.emit({ id: request.id, result: {
        account: { type: 'chatgpt', email: 'production-harness@example.test', planType: 'plus' },
        requiresOpenaiAuth: false,
      } });
      return;
    }
    if (request.method === 'thread/start') {
      const threadId = `harness-thread-${++this.threadIndex}`;
      this.emit({ id: request.id, result: { thread: { id: threadId } } });
      return;
    }
    if (request.method === 'turn/start') {
      const params = request.params as { threadId: string };
      const turnId = `harness-turn-${this.outputIndex + 1}`;
      const output = this.outputs[this.outputIndex++];
      if (output === undefined) throw new Error('Scripted Codex output fixture is exhausted');
      this.emit({ id: request.id, result: { turn: { id: turnId } } });
      setTimeout(() => {
        this.emit({ method: 'item/agentMessage/delta', params: {
          threadId: params.threadId, turnId, itemId: `${turnId}-assistant`,
          delta: JSON.stringify(output),
        } });
        this.emit({ method: 'turn/completed', params: {
          threadId: params.threadId, turn: { id: turnId, status: 'completed' },
        } });
      }, 5);
      return;
    }
    throw new Error(`Unexpected scripted App Server method: ${request.method}`);
  }

  onLine(listener: (line: string) => void): () => void {
    this.lineListeners.add(listener);
    return () => this.lineListeners.delete(listener);
  }

  onExit(listener: (detail: AppServerExit) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  private emit(message: unknown): void {
    const line = JSON.stringify(message);
    for (const listener of this.lineListeners) listener(line);
  }
}

function remapSourceIds<T>(value: T, mapping: Readonly<Record<string, string>>): T {
  const visit = (input: unknown): unknown => {
    if (typeof input === 'string') return mapping[input] ?? input;
    if (Array.isArray(input)) return input.map(visit);
    if (input && typeof input === 'object') {
      return Object.fromEntries(Object.entries(input).map(([key, nested]) => [key, visit(nested)]));
    }
    return input;
  };
  return visit(value) as T;
}

async function main(): Promise<void> {
  await rm(evidenceRoot, { recursive: true, force: true });
  await mkdir(evidenceRoot, { recursive: true });
  const rust = new JsonLineProcess(rustBinary, [
    '--database', databasePath,
    '--workspace', workspacePath,
  ]);
  const worker = new PackagedWorkerGateway();
  const memoryPath = join(evidenceRoot, 'memory.json');
  const sampler = new OperationRssSamplerProcess(memoryPath);
  const operations: Array<{ operation: string; at: string; revision?: number }> = [];
  const codexTransports: ScriptedCodexTransport[] = [];
  const codexTransport = (outputs: readonly unknown[]) => {
    const transport = new ScriptedCodexTransport(outputs);
    codexTransports.push(transport);
    return transport;
  };
  const record = (operation: string, pipeline?: NativePptPipeline) => {
    sampler.mark(operation);
    operations.push({
      operation,
      at: new Date().toISOString(),
      ...(pipeline ? { revision: pipeline.revision } : {}),
    });
  };
  try {
    let adapter = createTauriDesktopAdapter(
      codexTransport([]),
      (command, args) => rust.call(command, args),
      worker,
    );
    await adapter.loadInitialState();
    const project = await adapter.createProject({
      name: '五页中文经营复盘生产验收',
      goal: '使用真实本地服务边界交付可编辑 PPTX',
    });
    record('create-project');
    await adapter.saveProjectContext(project.id, {
      taskBrief: '面向管理层，强调经营价值与下一步决策',
      sourceInstructions: {}, outlineRequirements: '',
    });
    record('save-task-brief-before-attachments');
    const sourceFiles = [
      ['management-memo.pdf', 'application/pdf'],
      ['kpis.csv', 'text/csv'],
      ['market-background.png', 'image/png'],
      ['style-reference.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
    ] as const;
    let pipeline: NativePptPipeline | null = null;
    for (const [fileName, mediaType] of sourceFiles) {
      pipeline = await adapter.attachSource(project.id, {
        fileName,
        mediaType,
        contentsBase64: (await readFile(join(fixtureRoot, fileName))).toString('base64'),
      });
    }
    record('attach-materials', pipeline!);
    pipeline = await adapter.loadProjectPipeline(project.id);
    record('open-project', pipeline);
    const sourceMapping = Object.fromEntries([
      ['source-report', 'management-memo.pdf'],
      ['source-kpis', 'kpis.csv'],
      ['source-market', 'market-background.png'],
      ['source-style', 'style-reference.pptx'],
    ].map(([canonical, fileName]) => {
      const attached = pipeline!.sources.find((source) => source.fileName === fileName);
      if (!attached) throw new Error(`Attached source metadata missing for ${fileName}`);
      return [canonical, attached.id];
    }));
    const promptContext = {
      taskBrief: '面向管理层，强调经营价值与下一步决策',
      sourceInstructions: { [sourceMapping['source-style']!]: '只参考视觉风格，不采用其中数字' },
      outlineRequirements: '五页，先结论再展开证据',
    };
    pipeline = await adapter.saveProjectContext(project.id, promptContext);
    record('save-file-purpose-and-outline-requirements', pipeline);
    await rust.call('harness.restart');
    await worker.restart();
    pipeline = await adapter.loadProjectPipeline(project.id);
    assert.deepEqual(pipeline.promptContext, promptContext);
    record('restore-prompt-context-from-sqlite-and-embedded-worker', pipeline);
    const analysis = remapSourceIds(goldenSourceAnalysis(), sourceMapping);
    const generatedOutline = remapSourceIds(goldenOutline(), sourceMapping);
    const generatedSpecs = remapSourceIds(goldenSlideSpecs(), sourceMapping);
    const scripted = codexTransport([analysis, analysis, generatedOutline, generatedSpecs]);
    adapter = createTauriDesktopAdapter(scripted, (command, args) => rust.call(command, args), worker);

    pipeline = await adapter.analyzeProject(project.id);
    record('source-analysis', pipeline);
    pipeline = await adapter.saveProjectContext(project.id, {
      ...promptContext, taskBrief: `${promptContext.taskBrief}；补充新的参考材料后重新分析`,
    });
    record('reset-analysis-after-context-change', pipeline);
    pipeline = await adapter.attachSource(project.id, {
      fileName: 'supplement.txt', mediaType: 'text/plain',
      contentsBase64: Buffer.from('补充说明：沿用正式材料中的可验证事实。').toString('base64'),
    });
    await rust.call('harness.restart');
    await worker.restart();
    pipeline = await adapter.loadProjectPipeline(project.id);
    assert.equal(pipeline.sources.length, 5);
    assert.equal(pipeline.project.workflowStatus, 'intake');
    record('restore-after-reset-and-additional-attachment', pipeline);
    pipeline = await adapter.analyzeProject(project.id);
    record('reanalyze-after-additional-attachment', pipeline);
    pipeline = await adapter.generateOutline(project.id);
    const editedOutline = structuredClone(pipeline.outline!.value);
    editedOutline.slides[0]!.title = '用户编辑：2026 年经营复盘与增长计划';
    pipeline = await adapter.saveOutline(project.id, editedOutline);
    pipeline = await adapter.approveOutline(project.id);
    record('outline-edit-save-approve', pipeline);
    // The scripted detail response must use the explicitly approved edited title.
    // This adjusts synthetic generation only; production validation stays strict.
    generatedSpecs[0]!.title = pipeline.outline!.value.slides[0]!.title;
    assert.deepEqual(generatedSpecs.map(({ id, title }) => ({ id, title })),
      pipeline.outline!.value.slides.map(({ id, title }) => ({ id, title })),
      'Scripted generated details must match the approved outline IDs and titles');
    pipeline = await adapter.generateDetails(project.id);
    assert.equal(pipeline.schemaVersion, 1);

    // Hold a real adapter commit while another adapter writes the same baseline.
    // The losing request must reach Rust's actual CAS gate, not a fake save.
    const raceBaseline = pipeline;
    let commitEntered!: () => void;
    const entered = new Promise<void>((ready) => { commitEntered = ready; });
    let releaseCommit!: () => void;
    const released = new Promise<void>((release) => { releaseCommit = release; });
    let nativeCasRejected = false;
    const racingAdapter = createTauriDesktopAdapter(codexTransport([]), async (command, args) => {
      if (command === 'ppt_commit_pipeline') {
        commitEntered();
        await released;
        try { return await rust.call(command, args); }
        catch (reason) { nativeCasRejected = true; throw reason; }
      }
      return rust.call(command, args);
    }, worker);
    const losingSpecs = structuredClone(raceBaseline.slideSpecs!.value);
    losingSpecs[0]!.body = ['过期编辑不应覆盖当前正文'];
    const racingSave = racingAdapter.saveDetails(project.id, losingSpecs, raceBaseline.revision);
    const rejectedRace = assert.rejects(racingSave, /版本冲突/);
    await Promise.race([entered, racingSave]);
    const winningSpecs = structuredClone(raceBaseline.slideSpecs!.value);
    winningSpecs[0]!.body = ['已保存的并发编辑正文'];
    try {
      pipeline = await adapter.saveDetails(project.id, winningSpecs, raceBaseline.revision);
    } finally { releaseCommit(); }
    await rejectedRace;
    assert.equal(nativeCasRejected, true);
    assert.deepEqual(await adapter.loadProjectPipeline(project.id), pipeline);
    assert.deepEqual(pipeline.approvals, raceBaseline.approvals);
    record('actual-rust-cas-rejects-obsolete-detail-commit', pipeline);

    const originalV1 = structuredClone(pipeline);
    const originalArtifactPaths = ['outline/outline-v1.json', 'slide-specs/slide-specs-v1.json'];
    const originalArtifactBytes = await Promise.all(originalArtifactPaths.map((relativePath) =>
      rust.call<string>('ppt_read_artifact', { projectId: project.id, relativePath })));
    const revisionOutline = structuredClone(pipeline.outline!.value);
    revisionOutline.slides[0]!.title = '人工结构修订：经营复盘与增长计划';
    revisionOutline.slides[0]!.purpose = '审核结构变化后再单独批准细化内容';
    const revisionSpecs = pipeline.slideSpecs!.value.map((spec, index) => ({
      ...structuredClone(spec), title: revisionOutline.slides[index]!.title,
    }));
    const revisionId = 'production-harness-revision';
    const baseOutlineVersionId = pipeline.outline!.version.id;

    // Rust really commits; only its response and one reconciliation read are lost.
    let loseCommitResponse = true;
    let loseReconciliationRead = false;
    let revisionCommitCount = 0;
    adapter = createTauriDesktopAdapter(codexTransport([]), async (command, args) => {
      if (command === 'ppt_load_pipeline' && loseReconciliationRead) {
        loseReconciliationRead = false;
        throw new Error('Synthetic transport interruption after durable native commit');
      }
      const result = await rust.call(command, args);
      if (command === 'ppt_commit_pipeline' && loseCommitResponse) {
        revisionCommitCount += 1;
        loseCommitResponse = false;
        loseReconciliationRead = true;
        throw new Error('Synthetic lost native commit response');
      }
      if (command === 'ppt_commit_pipeline') revisionCommitCount += 1;
      return result;
    }, worker);
    await assert.rejects(adapter.saveOutlineRevision(project.id, {
      id: revisionId, baseOutlineVersionId, outline: revisionOutline, specs: revisionSpecs,
      createdAt: pipeline.project.updatedAt, updatedAt: pipeline.project.updatedAt,
    }, pipeline.revision), /尚未核实/);
    pipeline = await adapter.retryProjectEdit(project.id);
    assert.equal(revisionCommitCount, 1, 'Reconciliation must not submit the saved revision twice');
    assert.equal(pipeline.schemaVersion, 2);
    assert.deepEqual(pipeline.revisionOrigin, originalV1);
    assert.deepEqual(pipeline.approvals, originalV1.approvals);
    assert.deepEqual(pipeline.outline, originalV1.outline);
    assert.deepEqual(pipeline.slideSpecs, originalV1.slideSpecs);
    const pendingRevision = structuredClone(pipeline);
    record('structure-save-reconciles-uncertain-durable-commit', pipeline);

    await rust.call('harness.restart');
    await worker.restart();
    adapter = createTauriDesktopAdapter(codexTransport([]), (command, args) => rust.call(command, args), worker);
    pipeline = await adapter.loadProjectPipeline(project.id);
    assert.deepEqual(pipeline, pendingRevision);
    await assert.rejects(adapter.approveDetails(project.id, pipeline.revision));
    assert.deepEqual(await adapter.loadProjectPipeline(project.id), pendingRevision);
    record('restart-restores-pending-structure-without-approval', pipeline);
    pipeline = await adapter.approveOutlineRevision(project.id, revisionId, baseOutlineVersionId, pipeline.revision);
    assert.equal(pipeline.outlineRevisionDraft, null);
    assert.equal(pipeline.project.workflowStatus, 'detail_review');
    assert.equal(pipeline.outline!.version.id, `${project.id}-outline-v2`);
    assert.equal(pipeline.slideSpecs!.version.id, `${project.id}-slide-specs-v2`);
    assert.equal(pipeline.slideSpecs!.version.status, 'draft');
    assert.deepEqual(pipeline.approvals.slice(0, originalV1.approvals.length), originalV1.approvals);
    assert.equal(pipeline.approvals.length, originalV1.approvals.length + 1);
    assert.deepEqual(pipeline.revisionHistory, [{
      id: revisionId, status: 'confirmed', baseOutline: originalV1.outline,
      baseSlideSpecs: originalV1.slideSpecs, draft: pendingRevision.outlineRevisionDraft,
      decidedAt: pipeline.project.updatedAt, newOutlineVersionId: `${project.id}-outline-v2`,
    }]);
    const confirmedRevision = structuredClone(pipeline);
    record('confirm-structure-keeps-details-draft', pipeline);
    const editedSpecs = structuredClone(pipeline.slideSpecs!.value);
    editedSpecs[0]!.body = ['改后正文：用户编辑｜管理层汇报｜2026 年 9 月', '第二段\n保留换行'];
    pipeline = await adapter.saveDetails(project.id, editedSpecs, pipeline.revision);
    assert.equal(pipeline.slideSpecs!.version.id, `${project.id}-slide-specs-v3`);
    assert.equal(pipeline.slideSpecs!.version.status, 'draft');
    assert.deepEqual(pipeline.approvals, confirmedRevision.approvals);
    const contentDraft = structuredClone(pipeline);
    await rust.call('harness.restart');
    await worker.restart();
    adapter = createTauriDesktopAdapter(codexTransport([]), (command, args) => rust.call(command, args), worker);
    pipeline = await adapter.loadProjectPipeline(project.id);
    assert.deepEqual(pipeline, contentDraft);
    pipeline = await adapter.approveDetails(project.id, pipeline.revision);
    assert.equal(pipeline.slideSpecs!.version.status, 'frozen');
    const approvedDetails = structuredClone(pipeline.slideSpecs);
    const contentApprovals = structuredClone(pipeline.approvals);
    record('detail-edit-reload-separate-approval', pipeline);

    record('quit-worker-close-sqlite', pipeline);
    await rust.call('harness.restart');
    await worker.restart();
    record('restart-rust-sqlite-worker');
    adapter = createTauriDesktopAdapter(
      codexTransport([]),
      (command, args) => rust.call(command, args),
      worker,
    );
    pipeline = await adapter.loadProjectPipeline(project.id);
    if (pipeline.project.workflowStatus !== 'visual_review') {
      throw new Error(`Restart did not restore detail checkpoint: ${pipeline.project.workflowStatus}`);
    }
    record('reopen-project-after-restart', pipeline);

    const background = new Uint8Array(await readFile(join(fixtureRoot, 'market-background.png')));
    const distinctHashes = new Set<string>();
    for (const [index, spec] of pipeline.slideSpecs!.value.entries()) {
      pipeline = await adapter.requestVisual(project.id, spec.id);
      if (pipeline.project.workflowStatus !== 'blocked'
        || pipeline.blockedCondition?.capability !== 'image_gen.imagegen') {
        throw new Error(`Unavailable ImageGen was not represented honestly for ${spec.id}`);
      }
      const visual = createDistinctApprovedVisual(background, index);
      distinctHashes.add(createHash('sha256').update(visual).digest('hex'));
      pipeline = await adapter.replaceVisual(
        project.id,
        spec.id,
        Buffer.from(visual).toString('base64'),
        `用户上传的第 ${index + 1} 页完整视觉`,
      );
      pipeline = await adapter.approveVisual(project.id, spec.id);
      record(`visual-${index + 1}-blocked-replace-approve`, pipeline);
    }
    if (distinctHashes.size !== 5 || pipeline.project.workflowStatus !== 'conversion') {
      throw new Error('Sequential distinct visual approvals did not reach conversion');
    }

    await adapter.exportProject(project.id, 'production-harness.pptx');
    pipeline = await adapter.loadProjectPipeline(project.id);
    record('editable-pptx-export', pipeline);
    const exportedPptx = Buffer.from(await rust.call<string>('ppt_read_artifact', {
      projectId: project.id,
      relativePath: pipeline.exportReceipt!.relativePath,
    }), 'base64');
    const pptxInspection = await inspectPptxOoxml(exportedPptx);
    assert.ok(pptxInspection.slideEvidence![0]!.textValues.includes('人工结构修订：经营复盘与增长计划'));
    assert.ok(pptxInspection.slideEvidence![0]!.textValues.includes('改后正文：用户编辑｜管理层汇报｜2026 年 9 月'));
    if ((pptxInspection.mediaCount ?? 0) <= 0) {
      throw new Error('Production PPTX contains no embedded approved visual media');
    }
    if (pptxInspection.slideEvidence?.length !== pipeline.slideSpecs!.value.length) {
      throw new Error('Production PPTX slide evidence does not map one-to-one to approved specs');
    }
    pipeline.slideSpecs!.value.forEach((spec, index) => {
      const evidence = pptxInspection.slideEvidence![index]!;
      if (evidence.imageCount < 1) throw new Error(`Approved visual missing from PPTX page ${index + 1}`);
      if (evidence.textValues.filter((value) => value === spec.title).length !== 1) {
        throw new Error(`Editable title is missing or duplicated on PPTX page ${index + 1}`);
      }
      if (evidence.tableCount < spec.tables.length || evidence.chartCount < spec.charts.length) {
        throw new Error(`Editable table/chart objects are incomplete on PPTX page ${index + 1}`);
      }
      if (evidence.shapeCount < 1 + (spec.body.length > 0 ? 1 : 0) + spec.shapes.length) {
        throw new Error(`Editable basic shapes are incomplete on PPTX page ${index + 1}`);
      }
    });
    pipeline = await adapter.runProjectQa(project.id);
    record('libreoffice-pdftoppm-qa', pipeline);
    if (pipeline.project.workflowStatus !== 'completed' || pipeline.qaReport?.status !== 'passed') {
      throw new Error(`Real production QA did not pass: ${pipeline.qaReport?.issues.join('; ')}`);
    }
    const renderedPixelEvidence = await Promise.all(pipeline.qaReport.renderedPages.map(async (relativePath) => {
      const bytes = Buffer.from(await rust.call<string>('ppt_read_artifact', {
        projectId: project.id,
        relativePath,
      }), 'base64');
      return {
        relativePath,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        likelyTofu: detectLikelyTofuGlyphs(bytes),
      };
    }));
    if (renderedPixelEvidence.some(({ likelyTofu }) => likelyTofu)) {
      throw new Error('Rendered production PNG contains likely tofu replacement glyphs');
    }
    const codexMethods = codexTransports.flatMap(({ methods }) => methods);
    assert.equal(codexMethods.filter((method) => method === 'turn/start').length, 4,
      'Manual revision, recovery, confirmation and approval must not regenerate model content');
    const accountReads = codexMethods.filter((method) => method === 'account/read').length;
    const firstAccountRead = codexMethods.indexOf('account/read');
    const firstThreadStart = codexMethods.indexOf('thread/start');
    if (accountReads < 8 || firstAccountRead < 0 || firstThreadStart < firstAccountRead) {
      throw new Error('Structured and visual model requests were not preceded by active ChatGPT account reads');
    }

    await rust.call('harness.restart');
    await worker.restart();
    const reopenedAdapter = createTauriDesktopAdapter(
      codexTransport([]),
      (command, args) => rust.call(command, args),
      worker,
    );
    const reopened = await reopenedAdapter.loadProjectPipeline(project.id);
    assert.deepEqual(reopened, pipeline);
    assert.equal(reopened.outlineRevisionDraft, null);
    assert.deepEqual(reopened.revisionOrigin, originalV1);
    assert.deepEqual(reopened.revisionHistory, confirmedRevision.revisionHistory);
    assert.deepEqual(reopened.outline, confirmedRevision.outline);
    assert.deepEqual(reopened.slideSpecs, approvedDetails);
    assert.deepEqual(reopened.approvals.slice(0, contentApprovals.length), contentApprovals);
    assert.equal(reopened.approvals.length, contentApprovals.length + 5);
    for (const [index, relativePath] of originalArtifactPaths.entries()) {
      assert.equal(await rust.call<string>('ppt_read_artifact', { projectId: project.id, relativePath }),
        originalArtifactBytes[index], `Historical v1 artifact changed: ${relativePath}`);
    }
    record('restart-reopen-completed', reopened);
    if (reopened.project.workflowStatus !== 'completed' || reopened.revision !== pipeline.revision) {
      throw new Error('Completed pipeline did not survive SQLite and Worker restart');
    }
    const inspection = await rust.call<{
      pipeline: NativePptPipeline;
      counts: { versions: number; approvals: number; tasks: number; artifacts: number };
      projectDirectory: string;
      databasePath: string;
      workspacePath: string;
    }>('harness.inspect', { projectId: project.id });
    const textReport = Buffer.from(await rust.call<string>('ppt_read_artifact', {
      projectId: project.id,
      relativePath: reopened.qaReport!.textReportPath,
    }), 'base64').toString('utf8');
    if (!textReport.includes('LibreOffice QA round 1: passed')) {
      throw new Error('Persisted readable QA report is not the actual passing report');
    }
    const comparisonPaths = reopened.qaReport!.comparisons.map(({ approvedVisualPath }) => approvedVisualPath);
    if (new Set(comparisonPaths).size !== 5) {
      throw new Error('QA did not compare against five distinct approved visual paths');
    }
    record('stable-sampling-window', reopened);
    await new Promise((resolveWait) => setTimeout(resolveWait, 2_000));
    const memoryEvidence = await sampler.stop();
    if (!memoryEvidence.passed) {
      throw new Error(`Production operation window exceeded 4 GiB: ${memoryEvidence.peakRssMiB} MiB`);
    }
    const result = {
      harness: 'compiled-rust-command-boundary + production-tauri-adapter + embedded-sea',
      codexBoundary: 'scripted deterministic JSON only',
      projectId: project.id,
      workflowStatus: reopened.project.workflowStatus,
      revision: reopened.revision,
      structureRevision: {
        schemaVersion: reopened.schemaVersion,
        id: revisionId,
        pendingRestartRestored: true,
        actualRustCasRejected: nativeCasRejected,
        uncertainCommitReconciledWithoutResubmit: revisionCommitCount === 1,
        outlineVersionId: reopened.outline!.version.id,
        detailVersionId: reopened.slideSpecs!.version.id,
        historyPreserved: true,
        originalArtifactsPreserved: true,
        detailsApprovedSeparately: true,
      },
      sqliteRestarted: true,
      workerRestarted: true,
      databasePath: inspection.databasePath,
      projectDirectory: inspection.projectDirectory,
      embeddedWorkerPath: workerBinary,
      rustHarnessPath: rustBinary,
      libreOfficePath: reopened.qaReport!.sofficePath,
      pdfRendererPath: reopened.qaReport!.rendererPath,
      pages: reopened.qaReport!.actualPageCount,
      maximumDifferenceScore: Math.max(...reopened.qaReport!.comparisons.map(({ differenceScore }) => differenceScore ?? 1)),
      distinctApprovedVisuals: distinctHashes.size,
      pptxOoxml: {
        mediaCount: pptxInspection.mediaCount,
        slideEvidence: pptxInspection.slideEvidence,
      },
      chatGptAuthGate: {
        accountReads,
        threadStarts: codexMethods.filter((method) => method === 'thread/start').length,
        turnStarts: codexMethods.filter((method) => method === 'turn/start').length,
        accountReadBeforeFirstThread: firstAccountRead < firstThreadStart,
      },
      renderedPixelEvidence,
      comparisonApprovedPaths: comparisonPaths,
      readableReportPath: join(inspection.projectDirectory, reopened.qaReport!.textReportPath),
      exportPath: join(inspection.projectDirectory, reopened.exportReceipt!.relativePath),
      persistenceCounts: inspection.counts,
      operations,
      memory: {
        rootPid: memoryEvidence.rootPid,
        sampleCount: memoryEvidence.sampleCount,
        peakRssKiB: memoryEvidence.peakRssKiB,
        peakRssMiB: memoryEvidence.peakRssMiB,
        gateMiB: memoryEvidence.gateMiB,
        passed: memoryEvidence.passed,
        evidencePath: join(evidenceRoot, 'memory.json'),
      },
    };
    await writeFile(join(evidenceRoot, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await sampler.stop();
    await worker.stop();
    await rust.close();
  }
}

await main();
