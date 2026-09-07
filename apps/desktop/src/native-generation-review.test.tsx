/* @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNativePipeline, type NativePptPipeline } from '../../worker/src/native-pipeline.js';
import { createDemoDesktopAdapter, type DesktopAdapter } from './desktop-adapter.js';
import { ProjectGenerationRegistry } from './project-generation.js';
import { NativeWorkspacePage } from './native-workspace.js';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function detailPipeline(projectId: string, revision = 1, completed = false): NativePptPipeline {
  const pipeline = createNativePipeline({ id: projectId, name: `项目 ${projectId}`, goal: '管理层决策',
    createdAt: '2026-09-07T00:00:00.000Z' });
  pipeline.revision = revision;
  pipeline.project.workflowStatus = 'detail_review';
  pipeline.outline = { version: { id: `${projectId}-outline-v1`, projectId, sequence: 1,
    status: 'frozen', createdAt: pipeline.project.createdAt, frozenAt: pipeline.project.createdAt },
  value: { title: '经营复盘', slides: [{ id: 'slide-1', title: '封面', purpose: '开场', sourceIds: [] }] } };
  pipeline.approvals = [{ id: `${projectId}-outline-approval`, projectId,
    versionId: pipeline.outline.version.id, stage: 'outline_review', status: 'approved',
    decidedAt: pipeline.project.createdAt }];
  if (completed) pipeline.slideSpecs = { version: { id: `${projectId}-details-v1`, projectId,
    sequence: 1, status: 'draft', createdAt: pipeline.project.createdAt, frozenAt: null }, value: [{
      id: 'slide-1', title: '封面', body: ['关键结论'], tables: [], charts: [], shapes: [], sourceMap: [],
      imageGenerationBrief: '简洁封面',
    }] };
  return pipeline;
}

function harness(projectIds = ['project-a']) {
  const saved = new Map(projectIds.map((id) => [id, detailPipeline(id)]));
  const registry = new ProjectGenerationRegistry();
  const attempts = new Map<string, ReturnType<typeof deferred<NativePptPipeline>>[]>();
  const memoryAttempts = new Map<string, ReturnType<typeof deferred<{ status: string }>>[]>();
  const generateDetails = vi.fn((projectId: string) => {
    const job = deferred<NativePptPipeline>();
    attempts.set(projectId, [...attempts.get(projectId) ?? [], job]);
    return registry.run(projectId, 'details', () => job.promise);
  });
  const proposeProjectMemory = vi.fn((projectId: string) => {
    const job = deferred<{ status: string }>();
    memoryAttempts.set(projectId, [...memoryAttempts.get(projectId) ?? [], job]);
    return registry.run(projectId, 'memory', () => job.promise);
  });
  const adapter = { ...createDemoDesktopAdapter(), mode: 'tauri' as const,
    loadProjectPipeline: vi.fn(async (projectId: string) => structuredClone(saved.get(projectId)!)),
    getProjectGeneration: (projectId: string) => registry.get(projectId),
    subscribeProjectGeneration: (projectId: string, listener: Parameters<ProjectGenerationRegistry['subscribe']>[1]) =>
      registry.subscribe(projectId, listener), generateDetails, proposeProjectMemory,
  } as DesktopAdapter;
  const mount = (projectId = projectIds[0]!) => render(<NativeWorkspacePage adapter={adapter}
    projectId={projectId} projectName={`项目 ${projectId}`} projectGoal="管理层决策" onBack={() => {}} />);
  const finish = (projectId = projectIds[0]!, attempt = 0) => {
    const next = detailPipeline(projectId, 2 + attempt, true); saved.set(projectId, next);
    attempts.get(projectId)![attempt]!.resolve(structuredClone(next));
    return next;
  };
  return { adapter, registry, attempts, memoryAttempts, mount, finish, saved };
}

describe('native generation lifecycle review', () => {
  it('keeps details generation visibly running and disabled after leaving and remounting', async () => {
    const test = harness();
    const first = test.mount();
    fireEvent.click(await screen.findByRole('button', { name: '生成逐页细化' }));
    expect(screen.getByRole('button', { name: '正在生成逐页细化…' })).toBeDisabled();
    first.unmount();
    test.mount();
    expect(await screen.findByRole('status')).toHaveTextContent('正在生成逐页细化');
    expect(screen.getByRole('button', { name: '正在生成逐页细化…' })).toBeDisabled();
    expect(test.adapter.generateDetails).toHaveBeenCalledOnce();
  });

  it('applies a completed pipeline while mounted and when completion happened off-page', async () => {
    const test = harness();
    const first = test.mount();
    fireEvent.click(await screen.findByRole('button', { name: '生成逐页细化' }));
    test.finish();
    const details = await screen.findByRole('textbox', { name: '逐页细化 JSON' }) as HTMLTextAreaElement;
    await waitFor(() => expect(details.value).toContain('关键结论'));
    first.unmount();

    const second = test.mount();
    await screen.findByRole('textbox', { name: '逐页细化 JSON' });
    second.unmount();
    const offPage = test.registry.run('project-a', 'details', async () => detailPipeline('project-a', 3, true));
    await offPage;
    test.mount();
    expect(await screen.findByText('检查点 r3')).toBeVisible();
  });

  it('shows an off-page failure and only retries after an explicit click', async () => {
    const test = harness();
    const first = test.mount();
    fireEvent.click(await screen.findByRole('button', { name: '生成逐页细化' }));
    first.unmount();
    test.attempts.get('project-a')![0]!.reject(new Error('模型服务暂时不可用'));
    await waitFor(() => expect(test.registry.get('project-a')?.status).toBe('failed'));
    test.mount();
    expect(await screen.findByRole('alert')).toHaveTextContent('模型服务暂时不可用');
    expect(test.adapter.generateDetails).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: '重试生成逐页细化' }));
    expect(test.adapter.generateDetails).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: '正在生成逐页细化…' })).toBeDisabled();
  });

  it.each([
    ['analysis', 'intake', '正在分析材料…'],
    ['outline', 'source_analysis', '正在生成整份大纲…'],
  ] as const)('shows the %s running state on its action button', async (kind, status, label) => {
    const test = harness();
    const current = detailPipeline('project-a');
    current.project.workflowStatus = status;
    current.sources = [{ id: 'source-1', fileName: '材料.pdf', mediaType: 'application/pdf',
      relativePath: 'sources/材料.pdf', sha256: 'a'.repeat(64), byteLength: 1 }];
    if (status === 'source_analysis') current.analysis = { requestId: 'analysis-1',
      artifactRelativePath: 'sources/analysis.json', sha256: 'b'.repeat(64), output: {
        findings: [], dataPoints: [], sourceMap: [],
      } };
    test.saved.set('project-a', current);
    const job = deferred<NativePptPipeline>();
    void test.registry.run('project-a', kind, () => job.promise);
    test.mount();
    expect(await screen.findByRole('button', { name: label })).toBeDisabled();
  });

  it.each([
    ['analysis', 'intake', '重试分析材料'],
    ['outline', 'source_analysis', '重试生成整份大纲'],
  ] as const)('shows the %s retry label only for a matching failed stage', async (kind, status, label) => {
    const test = harness();
    const current = detailPipeline('project-a');
    current.project.workflowStatus = status;
    current.sources = [{ id: 'source-1', fileName: '材料.pdf', mediaType: 'application/pdf',
      relativePath: 'sources/材料.pdf', sha256: 'a'.repeat(64), byteLength: 1 }];
    if (status === 'source_analysis') current.analysis = { requestId: 'analysis-1',
      artifactRelativePath: 'sources/analysis.json', sha256: 'b'.repeat(64), output: {
        findings: [], dataPoints: [], sourceMap: [],
      } };
    test.saved.set('project-a', current);
    await expect(test.registry.run('project-a', kind, async () => { throw new Error('失败原因'); }))
      .rejects.toThrow('失败原因');
    test.mount();
    expect(await screen.findByRole('button', { name: label })).toBeEnabled();
  });

  it('clears a prior failure when an external retry starts', async () => {
    const test = harness();
    await expect(test.registry.run('project-a', 'details', async () => { throw new Error('旧失败'); }))
      .rejects.toThrow('旧失败');
    test.mount();
    expect(await screen.findByRole('alert')).toHaveTextContent('旧失败');
    const retry = deferred<NativePptPipeline>();
    void test.registry.run('project-a', 'details', () => retry.promise);
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: '正在生成逐页细化…' })).toBeDisabled();
  });

  it('does not show a failed prior stage after loading a newer stage', async () => {
    const test = harness();
    const current = detailPipeline('project-a', 4);
    current.project.workflowStatus = 'source_analysis';
    test.saved.set('project-a', current);
    await expect(test.registry.run('project-a', 'analysis', async () => { throw new Error('旧分析失败'); }))
      .rejects.toThrow('旧分析失败');
    test.mount();
    expect(await screen.findByRole('button', { name: '生成整份大纲' })).toBeVisible();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('does not let a late initial load overwrite a newer generation revision', async () => {
    const test = harness();
    const lateLoad = deferred<NativePptPipeline>();
    vi.mocked(test.adapter.loadProjectPipeline).mockReturnValueOnce(lateLoad.promise);
    test.mount();
    const completed = detailPipeline('project-a', 5, true);
    await test.registry.run('project-a', 'details', async () => completed);
    expect(await screen.findByText('检查点 r5')).toBeVisible();
    lateLoad.resolve(detailPipeline('project-a', 1));
    await waitFor(() => expect(screen.getByText('检查点 r5')).toBeVisible());
    expect(screen.getByRole('textbox', { name: '逐页细化 JSON' })).toBeVisible();
  });

  it('does not disable mutations in another project', async () => {
    const test = harness(['project-a', 'project-b']);
    const a = test.mount('project-a');
    fireEvent.click(await screen.findByRole('button', { name: '生成逐页细化' }));
    a.unmount();
    test.mount('project-b');
    expect(await screen.findByRole('button', { name: '生成逐页细化' })).toBeEnabled();
  });

  it('replays a running memory proposal after navigation and reports its persisted result', async () => {
    const test = harness();
    const first = test.mount();
    fireEvent.click(await screen.findByRole('button', { name: '请 AI 提议可复用偏好' }));
    expect(screen.getByRole('button', { name: '正在提议可复用偏好…' })).toBeDisabled();
    first.unmount();

    test.mount();
    expect(await screen.findByRole('status')).toHaveTextContent('正在提议可复用偏好');
    expect(test.adapter.proposeProjectMemory).toHaveBeenCalledOnce();
    test.memoryAttempts.get('project-a')![0]!.resolve({ status: '偏好建议已持久化' });
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('偏好建议已持久化'));
  });

  it('replays memory persistence failure and retries only after an explicit click', async () => {
    const test = harness();
    const first = test.mount();
    fireEvent.click(await screen.findByRole('button', { name: '请 AI 提议可复用偏好' }));
    first.unmount();
    test.memoryAttempts.get('project-a')![0]!.reject(new Error('偏好建议写入失败'));
    await waitFor(() => expect(test.registry.get('project-a')?.status).toBe('failed'));

    test.mount();
    expect(await screen.findByRole('alert')).toHaveTextContent('偏好建议写入失败');
    expect(test.adapter.proposeProjectMemory).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: '重试提议可复用偏好' }));
    expect(test.adapter.proposeProjectMemory).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: '正在提议可复用偏好…' })).toBeDisabled();
  });

  it('does not confuse entering detail_review with having reviewable slide details', async () => {
    const test = harness();
    const first = test.mount();
    expect(await screen.findByText(/逐页细化审核：未就绪/)).toHaveTextContent(
      'detail_review 仅表示已进入该阶段，不代表细化内容已生成',
    );
    first.unmount();
    test.saved.set('project-a', detailPipeline('project-a', 2, true));
    test.mount();
    expect(await screen.findByText('逐页细化审核：已就绪')).toBeVisible();
  });
});
