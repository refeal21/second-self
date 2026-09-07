import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createTauriDesktopAdapter,
  type NativeAppServerTransport,
  type NativeJsonRpcMessage,
} from './desktop-adapter.js';
import { buildPptPrompt } from './ppt-prompts.js';
import type { WorkflowWorkerGateway, WorkflowWorkerHealth } from './workflow-worker-client.js';
import {
  createNativePipeline,
  NativePptRpcRuntime,
  parseNativePipelineAction,
  type NativePipelineAction,
  type NativePptPipeline,
} from '../../worker/src/native-pipeline.js';
import {
  createDistinctApprovedVisual,
  goldenOutline,
  goldenSlideSpecs,
  goldenSourceAnalysis,
} from '../../worker/src/golden-project.js';

class ScriptedPptAppServer implements NativeAppServerTransport {
  readonly prompts: string[] = [];
  hold = false;
  private line: ((line: string) => void) | null = null;
  private turn = 0;
  constructor(private readonly outputs: readonly unknown[] = [
    goldenSourceAnalysis(), goldenOutline(), goldenSlideSpecs(),
  ]) {}
  async start(): Promise<void> {}
  async send(line: string): Promise<void> {
    const message = JSON.parse(line) as NativeJsonRpcMessage;
    if (message.id === undefined || !message.method) return;
    let result: unknown = {};
    if (message.method === 'account/read') result = {
      account: { type: 'chatgpt', email: 'production@example.com', planType: 'plus' },
      requiresOpenaiAuth: false,
    };
    if (message.method === 'thread/start') result = { thread: { id: `thread-${this.turn + 1}` } };
    if (message.method === 'turn/start') {
      const params = message.params as { input: Array<{ text?: string }> };
      this.prompts.push(params.input.map(({ text }) => text ?? '').join('\n'));
      result = { turn: { id: `turn-${++this.turn}` } };
    }
    queueMicrotask(() => this.line?.(JSON.stringify({ id: message.id, result })));
    if (message.method === 'turn/start') {
      const output = this.outputs[this.turn - 1];
      if (this.hold) return;
      const turn = this.turn;
      setTimeout(() => {
        this.complete(output, turn);
      }, 0);
    }
  }
  complete(output: unknown, turn = this.turn) {
    this.line?.(JSON.stringify({ method: 'item/agentMessage/delta', params: {
      threadId: `thread-${turn}`, turnId: `turn-${turn}`,
      itemId: `answer-${turn}`, delta: JSON.stringify(output),
    }}));
    this.line?.(JSON.stringify({ method: 'turn/completed', params: {
      threadId: `thread-${turn}`, turn: { id: `turn-${turn}`, status: 'completed', error: null },
    }}));
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
  async executeProject(projectId: string, action: NativePipelineAction) { return this.runtime.execute(projectId, parseNativePipelineAction(action)); }
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
      const input = args?.input as { expectedRevision: number; pipeline: NativePptPipeline; writes: Array<{ relativePath: string; contentsBase64: string }> };
      // Match the real Rust optimistic-concurrency gate before any file/state writes.
      if (input.expectedRevision !== state.pipeline.revision) throw new Error('stale pipeline revision');
      for (const write of input.writes) state.files.set(write.relativePath, write.contentsBase64);
      state.pipeline = structuredClone(input.pipeline);
      return structuredClone(state.pipeline);
    }
    if (command === 'ppt_read_artifact') return state.files.get(String(args?.relativePath));
    if (command === 'ppt_prepare_qa') {
      const specs = state.pipeline.slideSpecs?.value ?? [];
      const approvedVisuals = specs.map(({ id }) => {
        const relativePath = state.pipeline.visuals[id]!.at(-1)!.relativePath;
        return { slideId: id, relativePath, contentsBase64: state.files.get(relativePath)! };
      });
      return {
        status: 'ready', sofficePath: '/mock/soffice', rendererPath: '/mock/pdftoppm',
        pptxBase64: state.files.get(state.pipeline.exportReceipt!.relativePath)!,
        pdfBase64: Buffer.from('%PDF-mock').toString('base64'),
        renderedPages: approvedVisuals.map((visual, index) => ({
          fileName: `rendered-${index + 1}.png`, contentsBase64: visual.contentsBase64,
        })),
        approvedVisuals,
        fontAvailability: { 'Hiragino Sans GB': true },
      };
    }
    if (command === 'memory_propose') return { status: '偏好建议等待用户批准' };
    throw new Error(`Unexpected native command: ${command}`);
  });
  return { state, invoke };
}

describe('production-equivalent UI adapter → App Server → Worker → Rust persistence flow', () => {
  it('accepts real-world legacy detail forms through strict Worker parsing and keeps them pending review after reload', async () => {
    const raw = structuredClone(goldenSlideSpecs()) as unknown as Record<string, unknown>[];
    raw[0] = { ...raw[0], body: '业务背景。\n\n建设目标。',
      shapes: [{ id: 'concept-1', type: 'layeredDiagram', layers: ['入口', '业务'], note: '规划关系' }],
      tables: [{ id: 'table-1', title: '层级数', columns: ['项目', '数量'], rows: [['层级', 2]], note: '材料结构计数' }],
      sourceMap: [{ sourceId: 'source-report', locator: '第 1 页', targets: ['body'], note: '依据当前分析' }],
    };
    const native = nativePersistenceHarness();
    const server = new ScriptedPptAppServer([goldenSourceAnalysis(), goldenOutline(), raw]);
    const adapter = createTauriDesktopAdapter(server, native.invoke, new DirectWorker());
    await adapter.analyzeProject('project-e2e');
    await adapter.generateOutline('project-e2e');
    await adapter.approveOutline('project-e2e');
    const before = structuredClone(native.state.pipeline);
    await adapter.generateDetails('project-e2e');
    const reopened = await createTauriDesktopAdapter(server, native.invoke, new DirectWorker()).loadProjectPipeline('project-e2e');
    expect(reopened.slideSpecs?.version.status).toBe('draft');
    expect(reopened.slideSpecs?.value[0]?.body).toEqual(['业务背景。\n\n建设目标。']);
    expect(reopened.slideSpecs?.value[0]?.imageGenerationBrief).toContain('规划关系');
    expect(reopened.project.workflowStatus).toBe('detail_review');
    expect(reopened.approvals).toEqual(before.approvals);
    expect(reopened.outline).toEqual(before.outline);
    expect(reopened.tasks.at(-1)?.kind).toBe('detail_generation');
    expect(native.state.files.has('slide-specs/slide-specs-v1.json')).toBe(true);
    expect(server.prompts).toHaveLength(3);
  });
  it.each(['analysis', 'outline', 'details'] as const)('keeps %s single-flight across subscriptions and completes only after durable commit', async (kind) => {
    const native = nativePersistenceHarness();
    const server = new ScriptedPptAppServer();
    let releaseCommit!: () => void;
    let commitEntered = false;
    let holdCommit = false;
    const adapter = createTauriDesktopAdapter(server, async (command, args) => {
      if (command === 'ppt_commit_pipeline' && holdCommit) {
        commitEntered = true;
        await new Promise<void>((resolve) => { releaseCommit = resolve; });
      }
      return native.invoke(command, args);
    }, new DirectWorker());
    if (kind !== 'analysis') await adapter.analyzeProject('project-e2e');
    if (kind === 'details') { await adapter.generateOutline('project-e2e'); await adapter.approveOutline('project-e2e'); }
    server.hold = true;
    holdCommit = true;
    const turns = server.prompts.length;
    const generate = () => kind === 'analysis' ? adapter.analyzeProject('project-e2e')
      : kind === 'outline' ? adapter.generateOutline('project-e2e') : adapter.generateDetails('project-e2e');
    const first = generate();
    expect(adapter.getProjectGeneration('project-e2e')).toMatchObject({ kind, status: 'running' });
    const duplicate = generate();
    await vi.waitFor(() => expect(server.prompts).toHaveLength(turns + 1));
    const listener = vi.fn();
    const stop = adapter.subscribeProjectGeneration('project-e2e', listener);
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'running' }));
    stop();
    server.complete(kind === 'analysis' ? goldenSourceAnalysis() : kind === 'outline' ? goldenOutline() : goldenSlideSpecs());
    await vi.waitFor(() => expect(commitEntered).toBe(true));
    expect(adapter.getProjectGeneration('project-e2e')!.status).toBe('running');
    expect(native.state.pipeline.slideSpecs).toBeNull();
    releaseCommit();
    const [saved, reused] = await Promise.all([first, duplicate]);
    expect(reused).toEqual(saved);
    expect(server.prompts).toHaveLength(turns + 1);
    expect(adapter.getProjectGeneration('project-e2e')).toMatchObject({ status: 'completed', pipeline: native.state.pipeline });
    if (kind === 'details') {
      await expect(generate()).rejects.toThrow('已有逐页细化');
      expect(server.prompts).toHaveLength(turns + 1);
    }
  });

  it('retains persistence failures off-page and releases the generation lock for an explicit retry', async () => {
    const native = nativePersistenceHarness();
    const server = new ScriptedPptAppServer();
    let failCommit = true;
    const adapter = createTauriDesktopAdapter(server, async (command, args) => {
      if (command === 'ppt_commit_pipeline' && failCommit) throw new Error('磁盘写入失败');
      return native.invoke(command, args);
    }, new DirectWorker());
    await expect(adapter.analyzeProject('project-e2e')).rejects.toThrow('磁盘写入失败');
    expect(adapter.getProjectGeneration('project-e2e')).toMatchObject({ status: 'failed', error: '磁盘写入失败', pipeline: null });
    expect(native.state.pipeline.analysis).toBeNull();
    expect(server.prompts).toHaveLength(1);
    failCommit = false;
    server.hold = true;
    const retry = adapter.analyzeProject('project-e2e');
    await vi.waitFor(() => expect(server.prompts).toHaveLength(2));
    server.complete(goldenSourceAnalysis());
    await retry;
    expect(adapter.getProjectGeneration('project-e2e')!.status).toBe('completed');
  });

  it('fails an obsolete generation commit without overwriting a newer persisted checkpoint', async () => {
    const native = nativePersistenceHarness();
    const server = new ScriptedPptAppServer();
    let releaseCommit!: () => void;
    let commitEntered = false;
    const adapter = createTauriDesktopAdapter(server, async (command, args) => {
      if (command === 'ppt_commit_pipeline') {
        commitEntered = true;
        await new Promise<void>((resolve) => { releaseCommit = resolve; });
      }
      return native.invoke(command, args);
    }, new DirectWorker());
    const generation = adapter.analyzeProject('project-e2e');
    await vi.waitFor(() => expect(commitEntered).toBe(true));
    const newer = structuredClone(native.state.pipeline);
    newer.revision += 1;
    newer.promptContext = { taskBrief: '另一次操作保存的新背景', sourceInstructions: {}, outlineRequirements: '' };
    native.state.pipeline = newer;
    const failed = expect(generation).rejects.toThrow('stale pipeline revision');
    releaseCommit();
    await failed;
    expect(native.state.pipeline).toEqual(newer);
    expect(adapter.getProjectGeneration('project-e2e')).toMatchObject({ status: 'failed', pipeline: null });
    expect(server.prompts).toHaveLength(1);
    expect(native.state.files.size).toBe(0);
  });

  it('grounds a single-flight memory proposal in the approved snapshot and holds it through native persistence', async () => {
    const native = nativePersistenceHarness();
    const server = new ScriptedPptAppServer([
      goldenSourceAnalysis(), goldenOutline(), goldenSlideSpecs(),
      { title: '图表优先', content: '数据页优先使用已批准图表风格' },
    ]);
    let persistenceEntered = false;
    let releasePersistence!: () => void;
    const adapter = createTauriDesktopAdapter(server, async (command, args) => {
      if (command === 'memory_propose') {
        persistenceEntered = true;
        await new Promise<void>((resolve) => { releasePersistence = resolve; });
      }
      return native.invoke(command, args);
    }, new DirectWorker());
    await adapter.analyzeProject('project-e2e');
    await adapter.generateOutline('project-e2e');
    await adapter.approveOutline('project-e2e');
    await adapter.generateDetails('project-e2e');
    await adapter.approveDetails('project-e2e');
    const [approvedSlide, draftSlide] = goldenSlideSpecs();
    const background = new Uint8Array(await readFile(resolve('../..', 'fixtures/golden-project/sources/market-background.png')));
    await adapter.replaceVisual('project-e2e', approvedSlide!.id,
      Buffer.from(createDistinctApprovedVisual(background, 0)).toString('base64'),
      '已批准的图表视觉决策');
    await adapter.approveVisual('project-e2e', approvedSlide!.id);
    await adapter.replaceVisual('project-e2e', draftSlide!.id,
      Buffer.from(createDistinctApprovedVisual(background, 1)).toString('base64'),
      '未批准的草稿视觉不应进入快照');

    const first = adapter.proposeProjectMemory('project-e2e');
    const duplicate = adapter.proposeProjectMemory('project-e2e');
    expect(duplicate).toBe(first);
    await vi.waitFor(() => expect(persistenceEntered).toBe(true));
    expect(server.prompts).toHaveLength(4);
    expect(server.prompts[3]).toContain('五页经营复盘');
    expect(server.prompts[3]).toContain('project-e2e-slide-specs-v1');
    expect(server.prompts[3]).toContain('已批准的图表视觉决策');
    expect(server.prompts[3]).not.toContain('未批准的草稿视觉不应进入快照');
    expect(adapter.getProjectGeneration('project-e2e')).toMatchObject({
      kind: 'memory', status: 'running', pipeline: null, result: null,
    });

    releasePersistence();
    await expect(first).resolves.toEqual({ status: '偏好建议等待用户批准' });
    expect(adapter.getProjectGeneration('project-e2e')).toMatchObject({
      kind: 'memory', status: 'completed', pipeline: null,
      result: { status: '偏好建议等待用户批准' },
    });
    expect(native.invoke).toHaveBeenCalledWith('memory_propose', {
      title: '图表优先', content: '数据页优先使用已批准图表风格',
    });
  });

  it('retains memory persistence failure and spends another turn only after explicit retry', async () => {
    const native = nativePersistenceHarness();
    const server = new ScriptedPptAppServer([
      { title: '简洁表达', content: '保持简洁' },
      { title: '简洁表达', content: '保持简洁' },
    ]);
    let failPersistence = true;
    const adapter = createTauriDesktopAdapter(server, async (command, args) => {
      if (command === 'memory_propose' && failPersistence) throw new Error('偏好建议写入失败');
      return native.invoke(command, args);
    }, new DirectWorker());

    await expect(adapter.proposeProjectMemory('project-e2e')).rejects.toThrow('偏好建议写入失败');
    expect(adapter.getProjectGeneration('project-e2e')).toMatchObject({
      kind: 'memory', status: 'failed', error: '偏好建议写入失败', result: null,
    });
    expect(server.prompts).toHaveLength(1);
    await Promise.resolve();
    expect(server.prompts).toHaveLength(1);

    failPersistence = false;
    await expect(adapter.proposeProjectMemory('project-e2e')).resolves.toEqual({
      status: '偏好建议等待用户批准',
    });
    expect(server.prompts).toHaveLength(2);
    expect(adapter.getProjectGeneration('project-e2e')).toMatchObject({
      kind: 'memory', status: 'completed', error: null,
    });
  });

  it('persists document edits, page order and references across restart and rejects editing a frozen outline', async () => {
    const native = nativePersistenceHarness();
    const server = new ScriptedPptAppServer();
    const adapter = createTauriDesktopAdapter(server, native.invoke, new DirectWorker());
    await adapter.analyzeProject('project-e2e');
    const generated = await adapter.generateOutline('project-e2e');
    const original = generated.outline!;
    const edited = {
      ...original.value, title: '董事会审阅稿',
      slides: [original.value.slides[2]!,
        { ...original.value.slides[0]!, title: '先看决策', purpose: '明确本次需要批准的事项' },
        { id: 'slide-new-summary', title: '讨论与总结', purpose: '确认后续行动', sourceIds: [] }],
    };
    const saved = await adapter.saveOutline('project-e2e', edited);
    expect(saved.outline?.value).toEqual(edited);
    expect(saved.outline?.version.id).toBe(original.version.id);
    const outlineFiles = [...native.state.files.entries()].filter(([path]) => path.startsWith('outline/'));
    expect(outlineFiles.length).toBeGreaterThan(0);
    // Persistence canonicalizes object keys; page/array ordering remains exact.
    expect(outlineFiles.map(([, contents]) =>
      JSON.parse(Buffer.from(contents, 'base64').toString('utf8')) as unknown)).toContainEqual(edited);
    const restarted = createTauriDesktopAdapter(server, native.invoke, new DirectWorker());
    expect((await restarted.loadProjectPipeline('project-e2e')).outline?.value).toEqual(edited);
    const approved = await restarted.approveOutline('project-e2e');
    expect(approved.outline).toMatchObject({ value: edited, version: { status: 'frozen' } });
    await expect(restarted.saveOutline('project-e2e', { ...edited, title: '不应覆盖' })).rejects.toThrow();
    expect(native.state.pipeline.outline?.value).toEqual(edited);
    expect(server.prompts).toHaveLength(2);
  });

  it('persists the three instructions and sends the same preview through analysis, outline and approved details after restart', async () => {
    const native = nativePersistenceHarness();
    const server = new ScriptedPptAppServer();
    const adapter = createTauriDesktopAdapter(server, native.invoke, new DirectWorker());
    const context = {
      taskBrief: '向董事会解释建设背景，突出运营价值',
      sourceInstructions: { 'source-style': '只参考视觉风格，不采用其中数字', 'source-kpis': '这是本季度正式数据' },
      outlineRequirements: '控制五页，先讲价值，再讲建设路径',
    };
    const saved = await adapter.saveProjectContext('project-e2e', context);
    expect(saved.promptContext).toEqual(context);
    expect(server.prompts).toHaveLength(0);
    const restarted = createTauriDesktopAdapter(server, native.invoke, new DirectWorker());
    const restored = await restarted.loadProjectPipeline('project-e2e');
    const preview = buildPptPrompt(restored, 'analysis');
    await restarted.analyzeProject('project-e2e');
    expect(server.prompts[0]).toBe(preview);
    expect(server.prompts[0]).toContain('向董事会解释建设背景');
    expect(server.prompts[0]).toContain('只参考视觉风格，不采用其中数字');
    expect(server.prompts[0]).not.toContain('控制五页');
    await restarted.generateOutline('project-e2e');
    expect(server.prompts[1]).toContain('控制五页');
    await restarted.approveOutline('project-e2e');
    await restarted.generateDetails('project-e2e');
    expect(server.prompts[2]).toContain('向董事会解释建设背景');
    expect(server.prompts[2]).toContain('控制五页');
    expect(server.prompts[2]).toContain('只参考视觉风格，不采用其中数字');
    await expect(restarted.saveProjectContext('project-e2e', { ...context, taskBrief: '更改已批准的方向' })).rejects.toThrow();
    expect(native.state.pipeline.promptContext).toEqual(context);
    expect(server.prompts).toHaveLength(3);
  });

  it('rejects a generation call at the wrong stage before spending a Codex turn', async () => {
    const native = nativePersistenceHarness();
    const server = new ScriptedPptAppServer();
    const adapter = createTauriDesktopAdapter(server, native.invoke, new DirectWorker());
    await adapter.analyzeProject('project-e2e');
    await adapter.generateOutline('project-e2e');
    await adapter.approveOutline('project-e2e');
    await expect(adapter.generateOutline('project-e2e')).rejects.toThrow();
    await expect(adapter.analyzeProject('project-e2e')).rejects.toThrow();
    expect(server.prompts).toHaveLength(2);
  });

  it('sends the saved project goal and exact source inventory even for a legacy project without extra instructions', async () => {
    const native = nativePersistenceHarness();
    const server = new ScriptedPptAppServer();
    const adapter = createTauriDesktopAdapter(server, native.invoke, new DirectWorker());
    await adapter.analyzeProject('project-e2e');
    expect(server.prompts[0]).toContain('管理层决策');
    expect(server.prompts[0]).toContain('source-report');
    expect(server.prompts[0]).toContain('sources/management-memo.pdf');
    expect(server.prompts[0]).toContain('style-reference.pptx');
    await adapter.generateOutline('project-e2e');
    expect(server.prompts[1]).toContain(native.state.pipeline.analysis!.artifactRelativePath);
    await adapter.approveOutline('project-e2e');
    await adapter.generateDetails('project-e2e');
    expect(server.prompts[2]).toContain('管理层决策');
    expect(server.prompts[2]).toContain('slide-cover');
  });

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

    const background = new Uint8Array(await readFile(resolve('../..', 'fixtures/golden-project/sources/market-background.png')));
    for (const [index, spec] of goldenSlideSpecs().entries()) {
      const imageBase64 = Buffer.from(createDistinctApprovedVisual(background, index)).toString('base64');
      pipeline = await restarted.replaceVisual('project-e2e', spec.id, imageBase64, `用户替换 ${spec.id}`);
      pipeline = await restarted.approveVisual('project-e2e', spec.id);
    }
    expect(pipeline.project.workflowStatus).toBe('conversion');
    await expect(restarted.exportProject('project-e2e', '五页经营复盘')).resolves.toMatchObject({ message: expect.stringContaining('.pptx') });
    expect(native.state.pipeline.project.workflowStatus).toBe('qa');
    expect(native.state.files.get('exports/五页经营复盘.pptx')).toBeTruthy();
    expect(native.state.pipeline.approvals).toHaveLength(7);
    expect(native.state.pipeline.tasks.some(({ kind }) => kind === 'conversion')).toBe(true);
    pipeline = await restarted.runProjectQa('project-e2e');
    expect(pipeline.project.workflowStatus).toBe('completed');
    expect(pipeline.qaReport).toMatchObject({ status: 'passed', actualPageCount: 5 });
    expect(new Set(pipeline.qaReport!.comparisons.map(({ approvedVisualPath }) => approvedVisualPath)).size).toBe(5);
    expect(native.state.files.get('qa/qa-round-1.txt')).toContain('TGlicmVPZmZpY2UgUUE');
  });
});
