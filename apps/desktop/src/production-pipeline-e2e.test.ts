import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createTauriDesktopAdapter,
  type NativeAppServerTransport,
  type NativeJsonRpcMessage,
} from './desktop-adapter.js';
import type { WorkflowWorkerGateway, WorkflowWorkerHealth } from './workflow-worker-client.js';
import {
  createNativePipeline,
  NativePptRpcRuntime,
  type NativePipelineAction,
  type NativePptPipeline,
} from '../../worker/src/native-pipeline.js';
import {
  goldenOutline,
  goldenSlideSpecs,
  goldenSourceAnalysis,
} from '../../worker/src/golden-project.js';

class ScriptedPptAppServer implements NativeAppServerTransport {
  private line: ((line: string) => void) | null = null;
  private turn = 0;
  async start(): Promise<void> {}
  async send(line: string): Promise<void> {
    const message = JSON.parse(line) as NativeJsonRpcMessage;
    if (message.id === undefined || !message.method) return;
    let result: unknown = {};
    if (message.method === 'thread/start') result = { thread: { id: `thread-${this.turn + 1}` } };
    if (message.method === 'turn/start') result = { turn: { id: `turn-${++this.turn}` } };
    queueMicrotask(() => this.line?.(JSON.stringify({ id: message.id, result })));
    if (message.method === 'turn/start') {
      const output = [goldenSourceAnalysis(), goldenOutline(), goldenSlideSpecs()][this.turn - 1];
      setTimeout(() => {
        this.line?.(JSON.stringify({ method: 'item/agentMessage/delta', params: {
          threadId: `thread-${this.turn}`, turnId: `turn-${this.turn}`,
          itemId: `answer-${this.turn}`, delta: JSON.stringify(output),
        }}));
        this.line?.(JSON.stringify({ method: 'turn/completed', params: {
          threadId: `thread-${this.turn}`,
          turn: { id: `turn-${this.turn}`, status: 'completed', error: null },
        }}));
      }, 0);
    }
  }
  onLine(listener: (line: string) => void): () => void { this.line = listener; return () => { this.line = null; }; }
  onExit(): () => void { return () => {}; }
}

class DirectWorker implements WorkflowWorkerGateway {
  readonly runtime = new NativePptRpcRuntime({ imageGenAvailable: false });
  async health(): Promise<WorkflowWorkerHealth> { return { protocolVersion: 1, worker: 'digital-twin-workflow-worker', status: 'ready' }; }
  async createProject(input: Parameters<WorkflowWorkerGateway['createProject']>[0]) {
    return { pipeline: this.runtime.create(input), writes: [], message: '已创建' };
  }
  async restoreProject(pipeline: NativePptPipeline) { return this.runtime.restore(pipeline); }
  async executeProject(projectId: string, action: NativePipelineAction) { return this.runtime.execute(projectId, action); }
  async snapshotProject(projectId: string) { return this.runtime.snapshot(projectId); }
}

function nativePersistenceHarness() {
  const pipeline = createNativePipeline({
    id: 'project-e2e', name: '五页经营复盘', goal: '管理层决策',
    createdAt: '2026-09-03T00:00:00.000Z',
    preferenceSnapshot: [{ proposalId: 'memory-1', title: '图表优先', content: '数据页优先图表', approvedAt: 'now' }],
  });
  pipeline.sources = [
    ['source-report', 'management-memo.pdf', 'application/pdf'],
    ['source-kpis', 'kpis.csv', 'text/csv'],
    ['source-market', 'market-background.png', 'image/png'],
    ['source-style', 'style-reference.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  ].map(([id, fileName, mediaType]) => ({
    id: id!, fileName: fileName!, mediaType: mediaType!, relativePath: `sources/${fileName}`,
    sha256: 'a'.repeat(64), byteLength: 1,
  }));
  const state = { pipeline, files: new Map<string, string>() };
  const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command === 'ppt_load_pipeline') return structuredClone(state.pipeline);
    if (command === 'ppt_project_directory') return resolve('../..', 'fixtures/golden-project');
    if (command === 'ppt_commit_pipeline') {
      const input = args?.input as { pipeline: NativePptPipeline; writes: Array<{ relativePath: string; contentsBase64: string }> };
      for (const write of input.writes) state.files.set(write.relativePath, write.contentsBase64);
      state.pipeline = structuredClone(input.pipeline);
      return structuredClone(state.pipeline);
    }
    if (command === 'ppt_read_artifact') return state.files.get(String(args?.relativePath));
    if (command === 'memory_propose') return { status: '偏好建议等待用户批准' };
    throw new Error(`Unexpected native command: ${command}`);
  });
  return { state, invoke };
}

describe('production-equivalent UI adapter → App Server → Worker → Rust persistence flow', () => {
  it('runs all legal content and visual stages, survives a Worker restart, and commits an editable deck', async () => {
    const native = nativePersistenceHarness();
    const adapter = createTauriDesktopAdapter(new ScriptedPptAppServer(), native.invoke, new DirectWorker());
    let pipeline = await adapter.analyzeProject('project-e2e');
    expect(pipeline.project.workflowStatus).toBe('source_analysis');
    pipeline = await adapter.generateOutline('project-e2e');
    expect(pipeline.outline?.value.slides).toHaveLength(5);
    pipeline = await adapter.approveOutline('project-e2e');
    expect(pipeline.project.workflowStatus).toBe('detail_review');
    pipeline = await adapter.generateDetails('project-e2e');
    expect(pipeline.slideSpecs?.value).toHaveLength(5);
    pipeline = await adapter.approveDetails('project-e2e');
    expect(pipeline.currentSlideId).toBe('slide-cover');

    const restarted = createTauriDesktopAdapter(new ScriptedPptAppServer(), native.invoke, new DirectWorker());
    pipeline = await restarted.loadProjectPipeline('project-e2e');
    expect(pipeline.preferenceSnapshot[0]?.content).toBe('数据页优先图表');
    pipeline = await restarted.requestVisual('project-e2e', 'slide-cover');
    expect(pipeline).toMatchObject({ project: { workflowStatus: 'blocked' }, blockedCondition: { recoverable: true } });

    const imageBase64 = (await readFile(resolve('../..', 'fixtures/golden-project/sources/market-background.png'))).toString('base64');
    for (const spec of goldenSlideSpecs()) {
      pipeline = await restarted.replaceVisual('project-e2e', spec.id, imageBase64, `用户替换 ${spec.id}`);
      pipeline = await restarted.approveVisual('project-e2e', spec.id);
    }
    expect(pipeline.project.workflowStatus).toBe('conversion');
    await expect(restarted.exportProject('project-e2e', '五页经营复盘')).resolves.toMatchObject({ message: expect.stringContaining('.pptx') });
    expect(native.state.pipeline.project.workflowStatus).toBe('qa');
    expect(native.state.files.get('exports/五页经营复盘.pptx')).toBeTruthy();
    expect(native.state.pipeline.approvals).toHaveLength(7);
    expect(native.state.pipeline.tasks.some(({ kind }) => kind === 'conversion')).toBe(true);
  });
});
