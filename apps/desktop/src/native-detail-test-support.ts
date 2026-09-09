import { NativePptRpcRuntime, type NativePipelineAction, type NativePptPipeline } from '../../worker/src/native-pipeline.js';
import { createTauriDesktopAdapter, type NativeAppServerTransport } from './desktop-adapter.js';
import type { WorkflowWorkerGateway } from './workflow-worker-client.js';

/** Synthetic in-memory native boundary; Worker validation and adapter remain real. */
export async function detailTestHarness() {
  const runtime = new NativePptRpcRuntime({ imageGenAvailable: false });
  const id = 'detail-integration';
  const initial = runtime.create({ id, name: '合成复盘', goal: '验证人工编辑', createdAt: '2026-09-01T00:00:00.000Z' });
  initial.sources.push({ id: 'source-one', fileName: '合成材料.txt', mediaType: 'text/plain', relativePath: 'sources/one.txt', sha256: 'a'.repeat(64), byteLength: 1 });
  await runtime.restore(initial);
  await runtime.execute(id, { kind: 'analysis.commit', at: '2026-09-01T00:01:00.000Z', requestId: 'analysis-one', output: {
    findings: [], dataPoints: [], sourceMap: [{ sourceId: 'source-one', title: '合成材料', locator: '第一行' }],
  } });
  await runtime.execute(id, { kind: 'outline.submit', at: '2026-09-01T00:02:00.000Z', outline: { title: '合成复盘', slides: [
    { id: 'page-a', title: '第一页', purpose: '解释经营结果' }, { id: 'page-b', title: '第二页', purpose: '说明计划' },
  ] } });
  await runtime.execute(id, { kind: 'outline.approve', at: '2026-09-01T00:03:00.000Z' });
  await runtime.execute(id, { kind: 'details.submit', at: '2026-09-01T00:04:00.000Z', specs: ['a', 'b'].map((page, index) => ({
    id: `page-${page}`, title: index ? '第二页' : '第一页', body: ['原文第一段\n保留换行', '特殊字符 {"x":1}'],
    tables: [], charts: [], shapes: [], sourceMap: [], imageGenerationBrief: '用户填写的构图说明',
  })) });
  let stored = runtime.snapshot(id);
  const controls = { failCommit: false, loseResponse: false, failLoad: false, failReconcile: false, holdCommit: null as null | Promise<void> };
  const commits: number[] = [];
  const actions: NativePipelineAction[] = [];
  const worker: WorkflowWorkerGateway = {
    inspectTemplateStyle: async () => { throw new Error('No template inspection in edit tests'); },
    health: async () => ({ protocolVersion: 1, worker: 'digital-twin-workflow-worker', status: 'ready' }),
    createProject: async () => { throw new Error('No project creation in edit tests'); },
    restoreProject: (value) => runtime.restore(value),
    executeProject: async (projectId, action) => { actions.push(structuredClone(action)); return runtime.execute(projectId, action); },
    snapshotProject: async (projectId) => runtime.snapshot(projectId),
  };
  const transport: NativeAppServerTransport = {
    start: async () => { throw new Error('No model connection in edit tests'); },
    send: async () => { throw new Error('No model request in edit tests'); },
    onLine: () => () => {}, onExit: () => () => {},
  };
  const adapter = createTauriDesktopAdapter(transport, async (command, args) => {
    if (command === 'ppt_load_visual_style') return { revision: 0, profile: null, locked: false };
    if (command === 'ppt_visual_records') return [];
    if (command === 'ppt_load_pipeline') {
      if (controls.failLoad) throw new Error('暂时无法读取检查点');
      return structuredClone(stored);
    }
    if (command === 'ppt_commit_pipeline') {
      const input = args!.input as { expectedRevision: number; pipeline: NativePptPipeline };
      commits.push(input.expectedRevision);
      if (controls.holdCommit) await controls.holdCommit;
      if (controls.failCommit) throw new Error('磁盘暂时不可用');
      if (input.expectedRevision !== stored.revision) throw new Error('native revision conflict');
      stored = structuredClone(input.pipeline);
      if (controls.loseResponse) { if (controls.failReconcile) controls.failLoad = true; throw new Error('提交响应丢失'); }
      return structuredClone(stored);
    }
    throw new Error(`Unexpected native command ${command}`);
  }, worker);
  return { id, adapter, controls, commits, actions,
    getStored: () => structuredClone(stored),
    setStored: (value: NativePptPipeline) => { stored = structuredClone(value); },
  };
}
