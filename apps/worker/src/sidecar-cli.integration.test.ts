import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createDistinctApprovedVisual,
  goldenOutline,
  goldenSlideSpecs,
  goldenSourceAnalysis,
} from './golden-project.js';
import type { NativePipelineResult, NativePptPipeline } from './native-pipeline.js';

const children: ChildProcessWithoutNullStreams[] = [];

afterEach(async () => {
  await Promise.all(
    children.splice(0).map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }),
  );
}, 20_000);

function startWorker(testMode = false) {
  const cli = fileURLToPath(new URL('./sidecar-cli.ts', import.meta.url));
  const child = spawn(process.execPath, ['--import', 'tsx', cli], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ...(testMode ? { DIGITAL_TWIN_SIDECAR_TEST_MODE: '1' } : {}),
    },
  });
  children.push(child);
  const lines = createInterface({ input: child.stdout });
  const iterator = lines[Symbol.asyncIterator]();
  return {
    child,
    async request(value: string) {
      child.stdin.write(`${value}\n`);
      const next = await iterator.next();
      if (next.done) throw new Error('worker stdout closed');
      return JSON.parse(next.value) as Record<string, unknown>;
    },
  };
}

describe('worker sidecar process integration', () => {
  it('survives malformed and unknown requests before serving a valid request', async () => {
    const worker = startWorker();
    expect(await worker.request('{bad')).toMatchObject({
      error: { code: -32700 },
    });
    expect(
      await worker.request(
        JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'unknown' }),
      ),
    ).toMatchObject({ error: { code: -32601 } });
    expect(
      await worker.request(
        JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'system.health' }),
      ),
    ).toMatchObject({ result: { status: 'ready' } });
  });

  it('can be restarted after a controlled crash', async () => {
    const first = startWorker(true);
    first.child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'test.crash' })}\n`,
    );
    const [code] = (await once(first.child, 'exit')) as [number];
    expect(code).toBe(86);

    const restarted = startWorker();
    expect(
      await restarted.request(
        JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'system.health' }),
      ),
    ).toMatchObject({ result: { status: 'ready' } });
  });

  it('restores and finishes the five-page production pipeline through newline JSON-RPC', async () => {
    let requestId = 10;
    const call = async <T>(worker: ReturnType<typeof startWorker>, method: string, params: unknown): Promise<T> => {
      const response = await worker.request(JSON.stringify({ jsonrpc: '2.0', id: requestId++, method, params }));
      if (response.error) throw new Error(JSON.stringify(response.error));
      return response.result as T;
    };
    const createdAt = '2026-09-03T03:00:00.000Z';
    const first = startWorker();
    const created = await call<NativePipelineResult>(first, 'ppt.project.create', {
      id: 'project-sidecar-golden', name: '五页经营复盘', goal: '管理层决策', createdAt,
      preferenceSnapshot: [],
    });
    created.pipeline.sources = ['report', 'kpis', 'market', 'style'].map((name, index) => ({
      id: `source-${name}`, fileName: `${name}.bin`, mediaType: 'application/octet-stream',
      relativePath: `sources/source-${name}.bin`, sha256: String(index + 1).repeat(64), byteLength: 1,
    }));
    created.pipeline.revision = 1 + created.pipeline.sources.length;
    await call(first, 'ppt.project.restore', { pipeline: created.pipeline });
    const execute = async (worker: ReturnType<typeof startWorker>, action: Record<string, unknown>) =>
      call<NativePipelineResult>(worker, 'ppt.project.execute', { projectId: 'project-sidecar-golden', action });
    let result = await execute(first, {
      kind: 'analysis.commit', at: createdAt, requestId: 'analysis-sidecar', output: goldenSourceAnalysis(),
    });
    result = await execute(first, { kind: 'outline.submit', at: createdAt, outline: goldenOutline() });
    const editedOutline = structuredClone(goldenOutline());
    editedOutline.slides[0]!.title = '用户编辑：2026 年经营复盘与增长计划';
    result = await execute(first, { kind: 'outline.submit', at: createdAt, outline: editedOutline });
    result = await execute(first, { kind: 'outline.approve', at: createdAt });
    result = await execute(first, { kind: 'details.submit', at: createdAt, specs: goldenSlideSpecs() });
    const editedSpecs = goldenSlideSpecs().map((spec) => structuredClone(spec));
    editedSpecs[0] = { ...editedSpecs[0]!, body: ['用户编辑｜管理层汇报｜2026 年 9 月'] };
    result = await execute(first, { kind: 'details.submit', at: createdAt, specs: editedSpecs });
    result = await execute(first, { kind: 'details.approve', at: createdAt });
    expect(result.pipeline.currentSlideId).toBe('slide-cover');

    first.child.kill('SIGKILL');
    await once(first.child, 'exit');
    const restarted = startWorker();
    await call<NativePptPipeline>(restarted, 'ppt.project.restore', { pipeline: result.pipeline });
    const background = new Uint8Array(await readFile(resolve('../../fixtures/golden-project/sources/market-background.png')));
    const visualBytes: Record<string, string> = {};
    const approvedVisuals: Array<{ slideId: string; relativePath: string; contentsBase64: string }> = [];
    for (const [index, spec] of goldenSlideSpecs().entries()) {
      const contentsBase64 = Buffer.from(createDistinctApprovedVisual(background, index)).toString('base64');
      visualBytes[spec.id] = contentsBase64;
      result = await execute(restarted, {
        kind: 'visual.generate', at: createdAt, slideId: spec.id,
      });
      expect(result.pipeline.project.workflowStatus).toBe('blocked');
      result = await execute(restarted, {
        kind: 'visual.replace', at: createdAt, slideId: spec.id,
        imageBase64: contentsBase64, altText: `独立批准视觉 ${index + 1}`,
      });
      result = await execute(restarted, { kind: 'visual.approve', at: createdAt, slideId: spec.id });
      const visual = result.pipeline.visuals[spec.id]!.at(-1)!;
      approvedVisuals.push({ slideId: spec.id, relativePath: visual.relativePath, contentsBase64 });
    }
    result = await execute(restarted, {
      kind: 'deck.export', at: createdAt, fileName: 'sidecar-golden.pptx', visualBytes,
    });
    const pptx = result.writes.find(({ kind }) => kind === 'pptx')!;
    result = await execute(restarted, {
      kind: 'deck.qa', at: createdAt, preparation: {
        status: 'ready', sofficePath: '/mock/soffice', rendererPath: '/mock/pdftoppm',
        pptxBase64: pptx.contentsBase64, pdfBase64: Buffer.from('%PDF-mock').toString('base64'),
        renderedPages: approvedVisuals.map(({ contentsBase64 }, index) => ({
          fileName: `rendered-${index + 1}.png`, contentsBase64,
        })),
        approvedVisuals, fontAvailability: { 'Hiragino Sans GB': true },
      },
    });
    expect(result.pipeline.project.workflowStatus).toBe('completed');
    expect(result.pipeline.qaReport).toMatchObject({ status: 'passed', actualPageCount: 5 });
    expect(new Set(result.pipeline.qaReport!.comparisons.map(({ approvedVisualPath }) => approvedVisualPath)).size).toBe(5);
    expect(result.pipeline).toMatchObject({ revision: 29 });
    expect(result.pipeline.tasks).toHaveLength(12);

    const legitimateCompleted = structuredClone(result.pipeline);
    const missingAllTasks = structuredClone(legitimateCompleted);
    missingAllTasks.tasks = [];
    missingAllTasks.revision = 999;
    const forgedRevision = structuredClone(legitimateCompleted);
    forgedRevision.revision = 999;
    const forgedTaskRevision = structuredClone(legitimateCompleted);
    forgedTaskRevision.revision = 999;
    forgedTaskRevision.tasks.at(-1)!.id = forgedTaskRevision.tasks.at(-1)!.id.replace(
      /-task-\d+-qa$/,
      '-task-999-qa',
    );
    const missingRequiredTask = structuredClone(legitimateCompleted);
    missingRequiredTask.tasks = missingRequiredTask.tasks.slice(1).map((task) => ({
      ...task,
      id: task.id.replace(/-task-(\d+)-/, (_match, revision: string) =>
        `-task-${Number(revision) - 1}-`),
    }));
    missingRequiredTask.revision -= 1;

    const visualTasks = legitimateCompleted.tasks
      .filter(({ kind }) => kind === 'visual_generation');
    const visualTaskOrderingForgeries = visualTasks
      .map((visualTask) => {
        const forged = structuredClone(legitimateCompleted);
        const task = forged.tasks.find(({ id }) => id === visualTask.id)!;
        task.id = task.id.replace(/-task-(\d+)-/, (_match, revision: string) =>
          `-task-${Number(revision) + 1}-`);
        return forged;
      });
    const exactFinalApprovalForgery = structuredClone(legitimateCompleted);
    exactFinalApprovalForgery.tasks.find(({ id }) => id === visualTasks.at(-1)!.id)!.id =
      exactFinalApprovalForgery.tasks.find(({ id }) => id === visualTasks.at(-1)!.id)!.id
        .replace('-task-25-', '-task-27-');
    const approvalSlotPermutation = structuredClone(legitimateCompleted);
    for (const task of approvalSlotPermutation.tasks.filter(({ kind }) => kind === 'visual_generation')) {
      task.id = task.id.replace(/-task-(\d+)-/, (_match, revision: string) =>
        `-task-${Number(revision) + 2}-`);
    }
    const forgedQaRound = structuredClone(legitimateCompleted);
    forgedQaRound.qaReport!.round = 2;
    forgedQaRound.qaReport!.jsonReportPath = 'qa/qa-round-2.json';
    forgedQaRound.qaReport!.textReportPath = 'qa/qa-round-2.txt';

    for (const forgedCompleted of [
      missingAllTasks,
      forgedRevision,
      forgedTaskRevision,
      missingRequiredTask,
      ...visualTaskOrderingForgeries,
      exactFinalApprovalForgery,
      approvalSlotPermutation,
      forgedQaRound,
    ]) {
      const rejected = await restarted.request(JSON.stringify({
        jsonrpc: '2.0', id: requestId++, method: 'ppt.project.restore',
        params: { pipeline: forgedCompleted },
      }));
      expect(rejected).toMatchObject({ error: { code: -32602 } });
      const preserved = await call<NativePptPipeline>(restarted, 'ppt.project.snapshot', {
        projectId: legitimateCompleted.project.id,
      });
      expect(preserved).toEqual(legitimateCompleted);
    }
  });
});
