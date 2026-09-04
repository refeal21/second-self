import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { basename, join, resolve } from 'node:path';

const repository = resolve(import.meta.dirname, '..');
const binary = process.argv[2] ?? join(
  repository,
  'apps/desktop/src-tauri/target/release/bundle/macos/Digital Twin Workbench.app/Contents/MacOS/digital-twin-worker',
);
const goldenRoot = join(repository, 'artifacts/qa/golden-project/golden-project');
const fixtureRoot = join(repository, 'fixtures/golden-project/sources');
const at = '2026-09-03T04:00:00.000Z';
let requestId = 1;

function start() {
  const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  return {
    child,
    async rawCall(method, params) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId++, method, params })}\n`);
      const next = await lines.next();
      if (next.done) throw new Error('Packaged Worker closed stdout');
      return JSON.parse(next.value);
    },
    async call(method, params) {
      const response = await this.rawCall(method, params);
      if (response.error) throw new Error(JSON.stringify(response.error));
      return response.result;
    },
  };
}

async function stop(worker) {
  if (worker.child.exitCode !== null || worker.child.signalCode !== null) return;
  const exited = once(worker.child, 'exit');
  worker.child.kill('SIGTERM');
  await exited;
}

const outline = JSON.parse(await readFile(join(goldenRoot, 'outline/outline-v1.json'), 'utf8'));
const { specs } = JSON.parse(await readFile(join(goldenRoot, 'slide-specs/slide-specs-v1.json'), 'utf8'));
const { output: analysis } = JSON.parse(await readFile(join(goldenRoot, 'sources/analysis-golden-analysis.json'), 'utf8'));
const sourceInputs = [
  ['source-report', 'management-memo.pdf', 'application/pdf'],
  ['source-kpis', 'kpis.csv', 'text/csv'],
  ['source-market', 'market-background.png', 'image/png'],
  ['source-style', 'style-reference.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
];

let worker = start();
try {
  const adversarial = await worker.call('ppt.project.create', {
    id: 'project-packaged-boundary', name: '打包边界回归', goal: '拒绝跳过审批和未知动作',
    createdAt: at, preferenceSnapshot: [],
  });
  const forged = structuredClone(adversarial.pipeline);
  forged.project.workflowStatus = 'completed';
  forged.revision = 99;
  const forgedResponse = await worker.rawCall('ppt.project.restore', { pipeline: forged });
  if (forgedResponse.error?.code !== -32602) {
    throw new Error(`Packaged Worker accepted a forged completed restore: ${JSON.stringify(forgedResponse)}`);
  }
  const unknownResponse = await worker.rawCall('ppt.project.execute', {
    projectId: 'project-packaged-boundary',
    action: { kind: 'unknown.action', at },
  });
  if (unknownResponse.error?.code !== -32602) {
    throw new Error(`Packaged Worker accepted an unknown action: ${JSON.stringify(unknownResponse)}`);
  }
  const malformedResponse = await worker.rawCall('ppt.project.execute', {
    projectId: 'project-packaged-boundary',
    action: { kind: 'visual.approve', at: 123, slideId: false },
  });
  if (malformedResponse.error?.code !== -32602) {
    throw new Error(`Packaged Worker accepted a malformed action: ${JSON.stringify(malformedResponse)}`);
  }
  const boundarySnapshot = await worker.call('ppt.project.snapshot', {
    projectId: 'project-packaged-boundary',
  });
  if (boundarySnapshot.revision !== adversarial.pipeline.revision
    || boundarySnapshot.project.workflowStatus !== 'intake') {
    throw new Error('Packaged Worker mutated state after rejecting adversarial input');
  }

  const created = await worker.call('ppt.project.create', {
    id: 'project-packaged-smoke', name: '五页经营复盘', goal: '验证打包 Worker 完整链路', at,
    createdAt: at, preferenceSnapshot: [],
  });
  created.pipeline.sources = await Promise.all(sourceInputs.map(async ([id, fileName, mediaType]) => {
    const bytes = await readFile(join(fixtureRoot, fileName));
    return {
      id, fileName, mediaType, relativePath: `sources/${fileName}`,
      sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.byteLength,
    };
  }));
  created.pipeline.revision = 1 + created.pipeline.sources.length;
  await worker.call('ppt.project.restore', { pipeline: created.pipeline });
  const execute = (action) => worker.call('ppt.project.execute', {
    projectId: 'project-packaged-smoke', action,
  });
  let result = await execute({ kind: 'analysis.commit', at, requestId: 'analysis-packaged', output: analysis });
  result = await execute({ kind: 'outline.submit', at, outline });
  const editedOutline = structuredClone(outline);
  editedOutline.slides[0].title = '用户编辑：2026 年经营复盘与增长计划';
  result = await execute({ kind: 'outline.submit', at, outline: editedOutline });
  result = await execute({ kind: 'outline.approve', at });
  result = await execute({ kind: 'details.submit', at, specs });
  const editedSpecs = structuredClone(specs);
  editedSpecs[0] = { ...editedSpecs[0], body: ['用户编辑｜管理层汇报｜2026 年 9 月'] };
  result = await execute({ kind: 'details.submit', at, specs: editedSpecs });
  result = await execute({ kind: 'details.approve', at });

  await stop(worker);
  worker = start();
  await worker.call('ppt.project.restore', { pipeline: result.pipeline });
  const executeRestored = (action) => worker.call('ppt.project.execute', {
    projectId: 'project-packaged-smoke', action,
  });
  const visualBytes = {};
  const approvedVisuals = [];
  for (const spec of specs) {
    const relativePath = `visuals/${spec.id}-v1.png`;
    const contentsBase64 = (await readFile(join(goldenRoot, relativePath))).toString('base64');
    visualBytes[spec.id] = contentsBase64;
    result = await executeRestored({ kind: 'visual.generate', at, slideId: spec.id });
    if (result.pipeline.project.workflowStatus !== 'blocked') {
      throw new Error(`Packaged Worker did not persist the unavailable visual block for ${spec.id}`);
    }
    result = await executeRestored({ kind: 'visual.replace', at, slideId: spec.id, imageBase64: contentsBase64, altText: `批准视觉 ${spec.id}` });
    result = await executeRestored({ kind: 'visual.approve', at, slideId: spec.id });
    approvedVisuals.push({ slideId: spec.id, relativePath, contentsBase64 });
  }
  result = await executeRestored({ kind: 'deck.export', at, fileName: 'packaged-smoke.pptx', visualBytes });
  const pptx = result.writes.find(({ kind }) => kind === 'pptx');
  if (!pptx) throw new Error('Packaged Worker did not return a PPTX write intent');
  const renderedPages = await Promise.all(specs.map(async (_spec, index) => ({
    fileName: `rendered-${index + 1}.png`,
    contentsBase64: (await readFile(join(goldenRoot, `qa/run-1/rendered-${index + 1}.png`))).toString('base64'),
  })));
  result = await executeRestored({ kind: 'deck.qa', at, preparation: {
    status: 'ready', sofficePath: 'golden-soffice', rendererPath: 'golden-pdftoppm',
    pptxBase64: pptx.contentsBase64,
    pdfBase64: (await readFile(join(goldenRoot, 'qa/run-1/golden-management-report.pdf'))).toString('base64'),
    renderedPages, approvedVisuals, fontAvailability: { 'Hiragino Sans GB': true },
  } });
  const report = result.pipeline.qaReport;
  if (result.pipeline.project.workflowStatus !== 'completed' || report?.status !== 'passed') {
    throw new Error(`Packaged Worker full smoke failed: ${report?.issues?.join('; ') ?? 'missing report'}`);
  }
  if (result.pipeline.revision !== 29 || result.pipeline.tasks.length !== 12) {
    throw new Error(
      `Packaged Worker did not reproduce the production history: revision=${result.pipeline.revision}, tasks=${result.pipeline.tasks.length}`,
    );
  }
  const legitimateCompleted = structuredClone(result.pipeline);
  const forgedTaskHistory = structuredClone(legitimateCompleted);
  const finalVisualTask = forgedTaskHistory.tasks
    .filter(({ kind }) => kind === 'visual_generation')
    .at(-1);
  if (!finalVisualTask || !finalVisualTask.id.includes('-task-25-visual_generation')) {
    throw new Error(`Packaged Worker history lacks the expected revision-25 visual task: ${finalVisualTask?.id}`);
  }
  finalVisualTask.id = finalVisualTask.id.replace(
    '-task-25-visual_generation',
    '-task-27-visual_generation',
  );
  const forgedTaskHistoryResponse = await worker.rawCall('ppt.project.restore', {
    pipeline: forgedTaskHistory,
  });
  if (forgedTaskHistoryResponse.error?.code !== -32602) {
    throw new Error(
      `Packaged Worker accepted an interval-internal visual task revision forgery: ${JSON.stringify(forgedTaskHistoryResponse)}`,
    );
  }
  const completedAfterTaskForgery = await worker.call('ppt.project.snapshot', {
    projectId: legitimateCompleted.project.id,
  });
  if (JSON.stringify(completedAfterTaskForgery) !== JSON.stringify(legitimateCompleted)) {
    throw new Error('Packaged Worker mutated completed state after rejecting visual task revision forgery');
  }
  process.stdout.write(`${JSON.stringify({
    binary,
    architecture: process.arch,
    workflowStatus: result.pipeline.project.workflowStatus,
    restartRestoredRevision: result.pipeline.revision,
    tasks: result.pipeline.tasks.length,
    pages: report.actualPageCount,
    distinctApprovedVisuals: new Set(report.comparisons.map(({ approvedVisualPath }) => approvedVisualPath)).size,
    maxDifferenceScore: Math.max(...report.comparisons.map(({ differenceScore }) => differenceScore ?? 1)),
    forgedRestoreRejectedAtomically: true,
    unknownActionRejectedAtomically: true,
    malformedActionRejectedAtomically: true,
    taskHistoryForgeryRejectedAtomically: true,
    writes: result.writes.map(({ relativePath }) => relativePath),
  }, null, 2)}\n`);
} finally {
  await stop(worker);
}
