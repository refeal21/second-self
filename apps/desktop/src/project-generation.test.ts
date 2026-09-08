import { describe, expect, it, vi } from 'vitest';
import { createNativePipeline } from '../../worker/src/native-pipeline.js';
import { ProjectGenerationRegistry } from './project-generation.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const pipeline = () => createNativePipeline({ id: 'p1', name: '测试', goal: '测试', createdAt: 'now' });

describe('project generation lifetime', () => {
  it('publishes and retains visual-generation progress through completion', async () => {
    const registry = new ProjectGenerationRegistry();
    const visual = deferred<ReturnType<typeof pipeline>>();
    const generated = registry.run('p1', 'visual', () => visual.promise);
    const operationId = registry.get('p1')!.operationId;
    const listener = vi.fn();
    registry.subscribe('p1', listener);

    registry.updateProgress('p1', 'ImageGen 正在生成视觉候选…', operationId);
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({
      kind: 'visual', status: 'running', progress: 'ImageGen 正在生成视觉候选…',
    }));

    visual.resolve(pipeline());
    await generated;
    expect(registry.get('p1')).toMatchObject({
      kind: 'visual', status: 'completed', progress: 'ImageGen 正在生成视觉候选…',
    });
  });

  it('ignores progress from a completed or stale visual operation', async () => {
    const registry = new ProjectGenerationRegistry();
    await registry.run('p1', 'visual', async () => pipeline());
    const completed = registry.get('p1')!;
    registry.updateProgress('p1', 'late completed callback', completed.operationId);
    expect(registry.get('p1')).toEqual(completed);

    const retry = deferred<ReturnType<typeof pipeline>>();
    const generated = registry.run('p1', 'visual', () => retry.promise);
    registry.updateProgress('p1', 'stale callback', completed.operationId);
    expect(registry.get('p1')!.progress).toBeUndefined();
    retry.resolve(pipeline());
    await generated;
  });

  it('deduplicates the same visual identity but rejects a different current slide', async () => {
    const registry = new ProjectGenerationRegistry();
    const visual = deferred<ReturnType<typeof pipeline>>();
    const operation = vi.fn(() => visual.promise);
    const mismatched = vi.fn(async () => pipeline());
    const first = registry.run('p1', 'visual', operation, 'slide-a');

    expect(registry.run('p1', 'visual', operation, 'slide-a')).toBe(first);
    await expect(registry.run('p1', 'visual', mismatched, 'slide-b')).rejects.toThrow(/当前页|slide/i);
    expect(mismatched).not.toHaveBeenCalled();
    visual.resolve(pipeline());
    await first;
    expect(operation).toHaveBeenCalledOnce();
  });

  it('publishes the captured visual checkpoint and ignores stale context writers', async () => {
    const registry = new ProjectGenerationRegistry();
    const visual = deferred<ReturnType<typeof pipeline>>();
    const generated = registry.run('p1', 'visual', () => visual.promise, 'slide-a');
    const operationId = registry.get('p1')!.operationId;

    registry.updateVisualContext('p1', { slideId: 'slide-a', baseRevision: 7 }, operationId);
    expect(registry.get('p1')?.visualContext).toEqual({ slideId: 'slide-a', baseRevision: 7 });
    registry.updateVisualContext('p1', { slideId: 'slide-a', baseRevision: 99 }, 'stale-operation');
    expect(registry.get('p1')?.visualContext).toEqual({ slideId: 'slide-a', baseRevision: 7 });

    visual.resolve(pipeline());
    await generated;
    expect(registry.get('p1')?.visualContext).toEqual({ slideId: 'slide-a', baseRevision: 7 });
  });

  it('locks synchronously, replays running state on return, and shares one operation until persistence completes', async () => {
    const registry = new ProjectGenerationRegistry();
    const saved = deferred<ReturnType<typeof pipeline>>();
    const operation = vi.fn(() => saved.promise);
    const first = registry.run('p1', 'details', operation);
    const duplicate = registry.run('p1', 'details', operation);
    expect(duplicate).toBe(first);
    expect(registry.get('p1')).toMatchObject({ kind: 'details', status: 'running', pipeline: null });
    const listener = vi.fn();
    const stop = registry.subscribe('p1', listener);
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'running' }));
    await Promise.resolve();
    expect(operation).toHaveBeenCalledTimes(1);
    saved.resolve(pipeline());
    await first;
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'completed', pipeline: pipeline() }));
    stop();
    const returned = vi.fn();
    registry.subscribe('p1', returned);
    expect(returned).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'completed' }));
  });

  it('retains failures for remount and retries only on an explicit new call', async () => {
    const registry = new ProjectGenerationRegistry();
    const job = deferred<ReturnType<typeof pipeline>>();
    const first = registry.run('p1', 'outline', () => job.promise);
    const failed = expect(first).rejects.toThrow('保存失败');
    const firstId = registry.get('p1')!.operationId;
    job.reject(new Error('保存失败'));
    await failed;
    const listener = vi.fn();
    registry.subscribe('p1', listener);
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'failed', error: '保存失败' }));
    const retried = registry.run('p1', 'outline', async () => pipeline());
    expect(registry.get('p1')).toMatchObject({ status: 'running', error: null });
    expect(registry.get('p1')!.operationId).not.toBe(firstId);
    await retried;
    expect(registry.get('p1')!.status).toBe('completed');
  });

  it('rejects another stage while active without blocking other projects', async () => {
    const registry = new ProjectGenerationRegistry();
    const pending = deferred<ReturnType<typeof pipeline>>();
    const active = registry.run('p1', 'analysis', () => pending.promise);
    const wrong = vi.fn(async () => pipeline());
    await expect(registry.run('p1', 'outline', wrong)).rejects.toThrow('生成任务');
    expect(wrong).not.toHaveBeenCalled();
    await registry.run('p2', 'analysis', async () => pipeline());
    expect(registry.get('p1')!.status).toBe('running');
    expect(registry.get('p2')!.status).toBe('completed');
    pending.resolve(pipeline());
    await active;
  });

  it('isolates observer errors and snapshot mutation from the operation and other observers', async () => {
    const registry = new ProjectGenerationRegistry();
    registry.subscribe('p1', () => { throw new Error('UI error'); });
    registry.subscribe('p1', (state) => { if (state) state.status = 'failed'; });
    const listener = vi.fn();
    registry.subscribe('p1', listener);
    expect(listener).toHaveBeenLastCalledWith(null);
    await registry.run('p1', 'analysis', async () => pipeline());
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'completed' }));
    registry.get('p1')!.pipeline!.project.name = 'mutated';
    expect(registry.get('p1')!.pipeline!.project.name).toBe('测试');
  });

  it('installs the lock before notifying subscribers (including reentrant calls)', async () => {
    const registry = new ProjectGenerationRegistry();
    const operation = vi.fn(async () => pipeline());
    let nested: Promise<ReturnType<typeof pipeline>> | undefined;
    registry.subscribe('p1', (state) => {
      if (state?.status === 'running') nested = registry.run('p1', 'details', operation);
    });
    const first = registry.run('p1', 'details', operation);
    expect(nested).toBe(first);
    await first;
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('keeps a memory proposal single-flight until its persisted result is available', async () => {
    const registry = new ProjectGenerationRegistry();
    const persisted = deferred<{ status: string }>();
    const operation = vi.fn(() => persisted.promise);

    const first = registry.run('p1', 'memory', operation);
    const duplicate = registry.run('p1', 'memory', operation);

    expect(duplicate).toBe(first);
    expect(registry.get('p1')).toMatchObject({
      kind: 'memory', status: 'running', pipeline: null, result: null,
    });
    await Promise.resolve();
    expect(operation).toHaveBeenCalledOnce();

    persisted.resolve({ status: '偏好建议已持久化' });
    await expect(first).resolves.toEqual({ status: '偏好建议已持久化' });
    expect(registry.get('p1')).toMatchObject({
      kind: 'memory', status: 'completed', pipeline: null,
      result: { status: '偏好建议已持久化' },
    });
  });

  it('replays memory persistence failures and starts a new attempt only on explicit retry', async () => {
    const registry = new ProjectGenerationRegistry();
    const operation = vi.fn()
      .mockRejectedValueOnce(new Error('偏好建议写入失败'))
      .mockResolvedValueOnce({ status: '重试后已保存' });

    await expect(registry.run('p1', 'memory', operation)).rejects.toThrow('偏好建议写入失败');
    const failedId = registry.get('p1')!.operationId;
    const returned = vi.fn();
    registry.subscribe('p1', returned);
    expect(returned).toHaveBeenLastCalledWith(expect.objectContaining({
      kind: 'memory', status: 'failed', error: '偏好建议写入失败', result: null,
    }));
    expect(operation).toHaveBeenCalledOnce();

    await expect(registry.run('p1', 'memory', operation)).resolves.toEqual({ status: '重试后已保存' });
    expect(operation).toHaveBeenCalledTimes(2);
    expect(registry.get('p1')).toMatchObject({ kind: 'memory', status: 'completed' });
    expect(registry.get('p1')!.operationId).not.toBe(failedId);
  });
});
