import { describe, expect, it, vi } from 'vitest';
import { createNativePipeline } from '../../worker/src/native-pipeline.js';
import {
  ProjectEditRegistry,
  type ProjectDetailsSaveIdentity,
  type ProjectEditIdentity,
} from './project-edits.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function pipeline(projectId = 'p1') {
  return createNativePipeline({ id: projectId, name: '测试项目', goal: '产生演示文稿', createdAt: 'now' });
}

const detailSave = (payloadKey = 'specs-v1', expectedRevision = 7): ProjectDetailsSaveIdentity => ({
  kind: 'details.save', expectedRevision, payloadKey,
});

describe('project edit registry lifetime', () => {
  it('replays running and completed persisted state across subscriptions', async () => {
    const registry = new ProjectEditRegistry();
    const persisted = deferred<ReturnType<typeof pipeline>>();
    const firstListener = vi.fn();
    const stop = registry.subscribe('p1', firstListener);

    const result = registry.run('p1', detailSave(), () => persisted.promise);
    expect(firstListener).toHaveBeenLastCalledWith(expect.objectContaining({
      projectId: 'p1', kind: 'details.save', identity: detailSave(), status: 'running', pipeline: null,
    }));

    stop();
    const remounted = vi.fn();
    registry.subscribe('p1', remounted);
    expect(remounted).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'running' }));

    persisted.resolve(pipeline());
    await result;
    expect(remounted).toHaveBeenLastCalledWith(expect.objectContaining({
      status: 'completed', error: null, pipeline: pipeline(),
    }));

    const later = vi.fn();
    registry.subscribe('p1', later);
    expect(later).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'completed', pipeline: pipeline() }));
  });

  it('deduplicates only an exact identity and invokes its operation once', async () => {
    const registry = new ProjectEditRegistry();
    const persisted = deferred<ReturnType<typeof pipeline>>();
    const operation = vi.fn(() => persisted.promise);

    const first = registry.run('p1', detailSave(), operation);
    const duplicate = registry.run('p1', detailSave(), operation);

    expect(duplicate).toBe(first);
    await Promise.resolve();
    expect(operation).toHaveBeenCalledOnce();
    persisted.resolve(pipeline());
    await first;
  });

  it.each([
    ['different payload', detailSave('specs-v2')],
    ['different baseline', detailSave('specs-v1', 8)],
    ['different action', { kind: 'details.approve', expectedRevision: 7 } satisfies ProjectEditIdentity],
  ])('rejects a %s while another edit is active', async (_label, competing) => {
    const registry = new ProjectEditRegistry();
    const persisted = deferred<ReturnType<typeof pipeline>>();
    const active = registry.run('p1', detailSave(), () => persisted.promise);
    const wrong = vi.fn(async () => pipeline());

    await expect(registry.run('p1', competing, wrong)).rejects.toThrow('编辑操作');
    expect(wrong).not.toHaveBeenCalled();
    persisted.resolve(pipeline());
    await active;
  });

  it('holds the same-project lock through persistence and completion notification', async () => {
    const registry = new ProjectEditRegistry();
    const persisted = deferred<ReturnType<typeof pipeline>>();
    let duringCompletion: Promise<ReturnType<typeof pipeline>> | undefined;
    registry.subscribe('p1', (state) => {
      if (state?.status === 'completed') {
        duringCompletion = registry.run(
          'p1',
          { kind: 'outline.revision.cancel', expectedRevision: 8, revisionId: 'revision-1', baseOutlineVersionId: 'outline-1' },
          async () => pipeline(),
        );
        void duringCompletion.catch(() => undefined);
      }
    });

    const active = registry.run('p1', detailSave(), () => persisted.promise);
    expect(registry.get('p1')?.status).toBe('running');
    persisted.resolve(pipeline());
    await active;

    await expect(duringCompletion).rejects.toThrow('编辑操作');
    await expect(registry.run('p1', detailSave('specs-v2', 8), async () => pipeline())).resolves.toEqual(pipeline());
  });

  it('allows separate projects to edit independently', async () => {
    const registry = new ProjectEditRegistry();
    const firstProject = deferred<ReturnType<typeof pipeline>>();
    const p1 = registry.run('p1', detailSave(), () => firstProject.promise);

    await expect(registry.run('p2', detailSave(), async () => pipeline('p2'))).resolves.toEqual(pipeline('p2'));
    expect(registry.get('p1')?.status).toBe('running');
    expect(registry.get('p2')?.status).toBe('completed');
    firstProject.resolve(pipeline());
    await p1;
  });

  it('replays rejection without a saved result and permits an explicit retry', async () => {
    const registry = new ProjectEditRegistry();
    const original = new Error('原生保存失败');
    const failed = registry.run('p1', detailSave(), async () => { throw original; });

    await expect(failed).rejects.toBe(original);
    const failedId = registry.get('p1')!.operationId;
    expect(registry.get('p1')).toMatchObject({ status: 'failed', error: '原生保存失败', pipeline: null });
    const remounted = vi.fn();
    registry.subscribe('p1', remounted);
    expect(remounted).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'failed', pipeline: null }));

    await expect(registry.run('p1', detailSave(), async () => pipeline())).resolves.toEqual(pipeline());
    expect(registry.get('p1')).toMatchObject({ status: 'completed', error: null, pipeline: pipeline() });
    expect(registry.get('p1')!.operationId).not.toBe(failedId);
  });

  it('protects internal state from mutations to inputs and returned snapshots', async () => {
    const registry = new ProjectEditRegistry();
    const identity = detailSave();
    const result = pipeline();
    await registry.run('p1', identity, async () => result);

    identity.payloadKey = 'mutated-input';
    result.project.name = 'mutated-result';
    const snapshot = registry.get('p1')!;
    snapshot.identity.expectedRevision = 99;
    snapshot.pipeline!.project.name = 'mutated-snapshot';

    expect(registry.get('p1')).toMatchObject({
      identity: detailSave(), pipeline: { project: { name: '测试项目' } },
    });
  });

  it('isolates subscriber exceptions without falsifying committed success', async () => {
    const registry = new ProjectEditRegistry();
    registry.subscribe('p1', () => { throw new Error('UI subscriber failed'); });
    registry.subscribe('p1', (state) => { if (state) state.status = 'failed'; });
    const healthy = vi.fn();
    registry.subscribe('p1', healthy);

    await expect(registry.run('p1', detailSave(), async () => pipeline())).resolves.toEqual(pipeline());
    expect(healthy).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'completed', pipeline: pipeline() }));
    expect(registry.get('p1')).toMatchObject({ status: 'completed', pipeline: pipeline() });
  });
});
