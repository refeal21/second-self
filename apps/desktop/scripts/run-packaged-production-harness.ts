import { createHash } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';

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
    this.child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
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

  constructor(private readonly outputs: readonly unknown[]) {}

  async start(): Promise<void> {}

  async send(line: string): Promise<void> {
    const request = JSON.parse(line) as { id?: number; method: string; params?: unknown };
    if (request.id === undefined) return;
    if (request.method === 'initialize') {
      this.emit({ id: request.id, result: { serverInfo: { name: 'scripted-codex', version: '1' } } });
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
      new ScriptedCodexTransport([]),
      (command, args) => rust.call(command, args),
      worker,
    );
    await adapter.loadInitialState();
    const project = await adapter.createProject({
      name: '五页中文经营复盘生产验收',
      goal: '使用真实本地服务边界交付可编辑 PPTX',
    });
    record('create-project');
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
    const analysis = remapSourceIds(goldenSourceAnalysis(), sourceMapping);
    const generatedOutline = remapSourceIds(goldenOutline(), sourceMapping);
    const generatedSpecs = remapSourceIds(goldenSlideSpecs(), sourceMapping);
    const scripted = new ScriptedCodexTransport([analysis, generatedOutline, generatedSpecs]);
    adapter = createTauriDesktopAdapter(scripted, (command, args) => rust.call(command, args), worker);

    pipeline = await adapter.analyzeProject(project.id);
    record('source-analysis', pipeline);
    pipeline = await adapter.generateOutline(project.id);
    const editedOutline = structuredClone(pipeline.outline!.value);
    editedOutline.slides[0]!.title = '用户编辑：2026 年经营复盘与增长计划';
    pipeline = await adapter.saveOutline(project.id, editedOutline);
    pipeline = await adapter.approveOutline(project.id);
    record('outline-edit-save-approve', pipeline);
    pipeline = await adapter.generateDetails(project.id);
    const editedSpecs = structuredClone(pipeline.slideSpecs!.value);
    editedSpecs[0] = { ...editedSpecs[0]!, body: ['用户编辑｜管理层汇报｜2026 年 9 月'] };
    pipeline = await adapter.saveDetails(project.id, editedSpecs);
    pipeline = await adapter.approveDetails(project.id);
    record('detail-edit-save-approve', pipeline);

    record('quit-worker-close-sqlite', pipeline);
    await rust.call('harness.restart');
    await worker.restart();
    record('restart-rust-sqlite-worker');
    adapter = createTauriDesktopAdapter(
      new ScriptedCodexTransport([]),
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
    pipeline = await adapter.runProjectQa(project.id);
    record('libreoffice-pdftoppm-qa', pipeline);
    if (pipeline.project.workflowStatus !== 'completed' || pipeline.qaReport?.status !== 'passed') {
      throw new Error(`Real production QA did not pass: ${pipeline.qaReport?.issues.join('; ')}`);
    }

    await rust.call('harness.restart');
    await worker.restart();
    const reopenedAdapter = createTauriDesktopAdapter(
      new ScriptedCodexTransport([]),
      (command, args) => rust.call(command, args),
      worker,
    );
    const reopened = await reopenedAdapter.loadProjectPipeline(project.id);
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
