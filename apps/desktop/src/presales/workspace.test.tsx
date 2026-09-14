// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PresalesWorkspacePage } from './workspace.js';
import type { PresalesAdapter, V3EnqueueInput, V3PageRequest, V3Project, V3QueueSnapshot } from './adapter.js';
import { createPresalesAdapter } from './adapter.js';
import { invoke } from '@tauri-apps/api/core';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const basis = { hashAlgorithm: 'sha', spec: { version: 's', sha256: 's' }, design: { version: 'd', sha256: 'd' }, skill: { version: 'k', sha256: 'k' }, palette: { version: 'p', sha256: 'p' } };
const page = (id: string, ordinal: number, currentVersionId: string | null) => ({ slideId: id, ordinal, spec: { id, title: id, purpose: '说明' }, design: {}, visualBasis: basis, currentVersionId, versions: currentVersionId ? [{ versionId: currentVersionId, sequence: 1, requestId: `req-${id}`, attemptId: 'attempt', basis, image: { assetId: `asset-${id}`, sha256: `hash-${id}` }, provenance: { kind: 'presales' }, createdAt: 'today', missingImage: null }] : [], approval: null, feedback: null, revision: 8, intentRequestId: null, approvals: [], feedbackDrafts: [], references: [] });
const project = { kind: 'frozen', project: { summary: { projectId: 'v3', name: '副本', pageCount: 3, revision: 1, createdAt: 'today' }, origin: { sourceProjectId: 'old', sourceRevision: 4, hashAlgorithm: 'sha', snapshotDigest: 'digest' }, frozenCheckpoint: {}, palette: { revision: 1, profile: null, locked: true }, pages: [page('a', 0, null), page('b', 1, 'b-v1'), page('c', 2, null)], deliverySnapshot: null } } as V3Project;
const queue = { dispatchAvailable: true, settings: { concurrency: 4, paused: false, epoch: 1 }, remoteActive: 1, succeeded: 0, capabilities: { generation: true, referenceEditing: true }, jobs: [{ kind: 'image', requestId: 'a-job', projectId: 'v3', slideId: 'a', status: 'running', sequence: 1, error: null }, { kind: 'image', requestId: 'c-job', projectId: 'v3', slideId: 'c', status: 'queued', sequence: 2, error: null }] } as V3QueueSnapshot;
function adapter() { return { load: vi.fn(async () => project), queue: vi.fn(async () => queue), subscribe: vi.fn(() => () => {}), readImage: vi.fn(async () => ({ mimeType: 'image/png', base64: 'aGVsbG8=' })), approveVersion: vi.fn(async () => ({ approvalId: 'approved', versionId: 'b-v1', imageSha256: 'hash-b', basis, decidedAt: 'today' })), saveFeedback: vi.fn(async input => ({ baseVersionId: input.baseVersionId, text: input.text, revision: 1, updatedAt: 'today' })) } as unknown as PresalesAdapter; }

describe('native presales workspace', () => {
  it('releases a native-withdrawn in-flight admission and ignores its late reply after a newer submission', async () => {
    const user = userEvent.setup(); const api = adapter();
    const state = structuredClone(project);
    if (state.kind !== 'frozen') throw new Error('wrong kind');
    state.project.summary.projectId = 'late-withdrawn';
    vi.mocked(api.load).mockImplementation(async () => structuredClone(state));
    vi.mocked(api.queue).mockResolvedValue({ ...queue, jobs: [] });
    const releases: (() => void)[] = [];
    api.enqueue = vi.fn(async () => { await new Promise<void>(resolve => releases.push(resolve)); throw new Error('late withdrawn reply'); });
    api.reconcileImageAdmission = vi.fn(async (input: V3EnqueueInput) => ({ kind: 'withdrawn' as const, input }));
    render(<PresalesWorkspacePage adapter={api} projectId="late-withdrawn" initialPageId="b" onDirtyChange={vi.fn()} />);
    const submit = async () => {
      await user.click(await screen.findByRole('button', { name: '生成新稿' }));
      await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '确认批量生成' }));
    };
    await submit();
    await user.click(screen.getByRole('button', { name: '重新核对状态' }));
    await user.click(await screen.findByRole('button', { name: '核对并撤回未入队请求' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '生成新稿' })).toBeEnabled());
    await submit();
    expect(api.enqueue).toHaveBeenCalledTimes(2);
    await act(async () => releases[0]!());
    expect(screen.getByRole('button', { name: '生成新稿' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '核对并撤回未入队请求' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '生成新稿' })).toBeEnabled());
    await act(async () => releases[1]!());
    expect(screen.getByRole('button', { name: '生成新稿' })).toBeEnabled();
    expect(screen.queryByText(/late withdrawn reply/)).not.toBeInTheDocument();
    expect(api.enqueue).toHaveBeenCalledTimes(2);
  });
  it.each(['retry', 'withdraw', 'reuse', 'reconcile-reuse'])('recovers image admission with exact stable batch input and native proof: %s', async mode => {
    const user = userEvent.setup(); const api = adapter();
    const state = structuredClone(project);
    if (state.kind !== 'frozen') throw new Error('wrong kind');
    const id = `admission-${mode}`;
    state.project.summary.projectId = id;
    let jobs: V3QueueSnapshot['jobs'] = [];
    vi.mocked(api.load).mockImplementation(async () => structuredClone(state));
    vi.mocked(api.queue).mockImplementation(async () => ({ ...queue, jobs }));
    let original: { projectId: string; batchId: string; pages: V3PageRequest[] };
    api.enqueue = vi.fn(async (projectId, batchId, pages) => {
      if (!original) original = structuredClone({ projectId, batchId, pages });
      if (mode !== 'reuse' && vi.mocked(api.enqueue).mock.calls.length === 1) {
        state.project.pages[1]!.revision = 9;
        state.project.pages[1]!.feedbackDrafts = [{ baseVersionId: null, text: 'Changed after original submit', revision: 1, updatedAt: 'today' }];
        throw new Error('native rejected or reply lost');
      }
      const requestId = mode === 'reuse' ? 'native-existing-job' : pages[0]!.requestId;
      jobs = [{ kind: 'image', requestId, projectId, slideId: 'b', status: 'succeeded', sequence: 1, error: null }];
      return { jobs: [{ requestId, target: { projectId, slideId: 'b' } }], reusedRequestIds: mode === 'reuse' ? [requestId] : [] };
    });
    api.reconcileImageAdmission = vi.fn(async (input: V3EnqueueInput) => {
      if (mode === 'reconcile-reuse') {
        jobs = [{ kind: 'image', requestId: 'resolved-native-job', projectId: id, slideId: 'b', status: 'succeeded', sequence: 1, error: null }];
        return { kind: 'admitted' as const, input, outcome: { jobs: [{ requestId: 'resolved-native-job', target: { projectId: id, slideId: 'b' } }], reusedRequestIds: ['resolved-native-job'] } };
      }
      return { kind: 'withdrawn' as const, input };
    });
    render(<PresalesWorkspacePage adapter={api} projectId={id} initialPageId="b" onDirtyChange={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: '生成新稿' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '确认批量生成' }));
    await waitFor(() => expect(api.enqueue).toHaveBeenCalledTimes(1));
    if (mode === 'retry') {
      await user.click(await screen.findByRole('button', { name: '用原图片请求重试确认' }));
      await waitFor(() => expect(api.enqueue).toHaveBeenCalledTimes(2));
      expect(vi.mocked(api.enqueue).mock.calls[1]).toEqual(vi.mocked(api.enqueue).mock.calls[0]);
    } else if (mode === 'withdraw' || mode === 'reconcile-reuse') {
      await user.click(await screen.findByRole('button', { name: '核对并撤回未入队请求' }));
      await waitFor(() => expect(api.reconcileImageAdmission).toHaveBeenCalledWith(original));
      expect(api.enqueue).toHaveBeenCalledTimes(1);
    }
    await waitFor(() => expect(screen.getByRole('button', { name: '生成新稿' })).toBeEnabled());
    expect(screen.queryByRole('button', { name: '用原图片请求重试确认' })).not.toBeInTheDocument();
  });
  it('adopts and restores an imported null-basis original after a newer candidate, then requests its actual parent image', async () => {
    const user = userEvent.setup(); const api = adapter();
    const state = structuredClone(project);
    if (state.kind !== 'frozen') throw new Error('wrong kind');
    state.project.summary.projectId = 'imported-actions';
    const imported = state.project.pages[1]!;
    const original = imported.versions[0]!;
    original.basis = null;
    original.requestId = null;
    original.attemptId = null;
    original.provenance = { kind: 'legacyImported', originDigest: 'digest', sourceVersionId: 'legacy-original', originalVisual: {}, originalApproval: {} };
    const origin = { referenceId: 'origin-approval', versionId: original.versionId, image: original.image! } as NonNullable<typeof imported.originApproval>;
    imported.originApprovals = [origin];
    imported.versions.push({ ...original, versionId: 'new-candidate', sequence: 2, requestId: 'new-request', attemptId: 'new-attempt', basis, provenance: { kind: 'presales' }, image: { assetId: 'new-image', sha256: 'new-hash' } });
    imported.currentVersionId = 'new-candidate';
    vi.mocked(api.load).mockImplementation(async () => structuredClone(state));
    vi.mocked(api.queue).mockResolvedValue({ ...queue, jobs: [] });
    api.adoptVersion = vi.fn(async () => { imported.currentVersionId = original.versionId; imported.revision++; return imported; });
    api.restoreApproval = vi.fn(async () => { imported.originApproval = origin; imported.revision++; return imported; });
    api.enqueue = vi.fn(async (_id: string, _batch: string, pages: V3PageRequest[]) => ({ jobs: pages.map(page => ({ requestId: page.requestId, target: { projectId: 'imported-actions', slideId: page.slideId } })), reusedRequestIds: [] }));
    render(<PresalesWorkspacePage adapter={api} projectId="imported-actions" initialPageId="b" onDirtyChange={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: /查看原项目对照 修订 1/ }));
    await user.click(screen.getByRole('button', { name: '选择用于交付' }));
    await waitFor(() => expect(api.adoptVersion).toHaveBeenCalledWith({ projectId: 'imported-actions', slideId: 'b', versionId: 'b-v1', expectedRevision: 8 }));
    await waitFor(() => expect(screen.getByRole('button', { name: '恢复此前批准' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: '恢复此前批准' }));
    await waitFor(() => expect(api.restoreApproval).toHaveBeenCalledWith({ projectId: 'imported-actions', slideId: 'b', versionId: 'b-v1', expectedRevision: 9 }));
    await waitFor(() => expect(screen.getByText(/查看原项目对照 修订 1 · 当前交付/)).toBeVisible());
    expect(api.approveVersion).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '编辑此版本' }));
    await waitFor(() => expect(api.enqueue).toHaveBeenCalledWith('imported-actions', expect.any(String), [expect.objectContaining({ slideId: 'b', parentVersionId: 'b-v1', expectedRevision: 10 })]));
    expect(original.basis).toBeNull();
  });
  it('renders the exact native snapshot unsupported outcome through the real adapter and keeps PNG/history available', async () => {
    const user = userEvent.setup(); const api = adapter();
    const native = { snapshotId: 'delivery-v3-18', projectId: 'v3', revision: 18, createdAt: 'today', pages: [{ slideId: 'b', versionId: 'b-v2', image: { assetId: 'asset-b-v2', sha256: 'hash-b-v2' }, approvalId: 'approval-v2' }] };
    vi.mocked(invoke).mockResolvedValueOnce(native);
    api.delivery = createPresalesAdapter().delivery;
    render(<PresalesWorkspacePage adapter={api} projectId="v3" initialPageId="b" onDirtyChange={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: '导出可编辑 PPTX' }));
    const panel = screen.getByRole('region', { name: '版本交付' });
    await waitFor(() => expect(panel).toHaveTextContent('delivery-v3-18'));
    expect(panel).toHaveTextContent('b：b-v2');
    expect(panel).toHaveTextContent('暂不支持可编辑转换');
    expect(panel).toHaveTextContent('未生成 PPTX，未运行 QA');
    expect(panel).toHaveTextContent('历史快照未保存冻结内容证据');
    expect(invoke).toHaveBeenCalledWith('presales_v3_delivery', { projectId: 'v3' });
    expect(screen.getByRole('textbox', { name: '此版本反馈' })).toBeEnabled();
    await waitFor(() => expect(api.readImage).toHaveBeenCalledWith({ projectId: 'v3', slideId: 'b', versionId: 'b-v1', assetId: 'asset-b', sha256: 'hash-b' }));
  });
  it('evaluates delivery through native selection and keeps history usable when approval is invalidated', async () => {
    const user = userEvent.setup(); const api = adapter();
    const delivery = vi.fn(async () => { throw new Error('every page needs exactly one effective approval authority'); });
    Object.assign(api, { delivery });
    render(<PresalesWorkspacePage adapter={api} projectId="v3" initialPageId="b" onDirtyChange={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: '导出可编辑 PPTX' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('every page needs exactly one effective approval authority');
    expect(delivery).toHaveBeenCalledWith('v3');
    expect(screen.getByRole('checkbox', { name: /内容与页面规格一致/ })).toBeEnabled();
    expect(screen.getByRole('textbox', { name: '此版本反馈' })).toBeEnabled();
  });
  it('keeps B review usable while A runs and C queues; approval carries exact CAS and two checks', async () => {
    const user = userEvent.setup(); const api = adapter();
    render(<PresalesWorkspacePage adapter={api} projectId="v3" onDirtyChange={() => {}} />);
    await user.click(await screen.findByRole('button', { name: /第 2 页 b/ }));
    await user.click(screen.getByRole('checkbox', { name: /内容与页面规格一致/ }));
    await user.click(screen.getByRole('checkbox', { name: /视觉与设计方案一致/ }));
    await user.click(screen.getByRole('button', { name: '批准此版本' }));
    await waitFor(() => expect(api.approveVersion).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'v3', slideId: 'b', versionId: 'b-v1', imageSha256: 'hash-b', basis, expectedRevision: 8, contentChecked: true, visualChecked: true })));
  });
  it('keeps exact-version feedback text after a native save conflict', async () => {
    const user = userEvent.setup(); const api = adapter(); vi.mocked(api.saveFeedback).mockRejectedValueOnce(new Error('revision conflict'));
    render(<PresalesWorkspacePage adapter={api} projectId="v3" onDirtyChange={() => {}} />);
    await user.click(await screen.findByRole('button', { name: /第 2 页 b/ }));
    await user.type(screen.getByRole('textbox', { name: '此版本反馈' }), '加大图表');
    await user.click(screen.getByRole('button', { name: '保存反馈' }));
    expect((await screen.findAllByRole('alert')).some(alert => alert.textContent?.includes('revision conflict'))).toBe(true);
    expect(screen.getByRole('textbox', { name: '此版本反馈' })).toHaveValue('加大图表');
  });
  it('saves pre-version page feedback while that page has a running generation', async () => {
    const user = userEvent.setup(); const api = adapter();
    render(<PresalesWorkspacePage adapter={api} projectId="v3" onDirtyChange={() => {}} />);
    const field = await screen.findByRole('textbox', { name: '下一次生成说明' });
    expect(screen.getByRole('heading', { name: '第 1 页 · 下一次生成说明' })).toBeVisible();
    expect(screen.getByRole('heading', { name: '第 1 页参考图' })).toBeVisible();
    await user.type(field, '注意留白');
    await user.click(screen.getByRole('button', { name: '保存下一次生成说明' }));
    await waitFor(() => expect(api.saveFeedback).toHaveBeenCalledWith({ projectId: 'v3', slideId: 'a', baseVersionId: null, expectedRevision: 0, text: '注意留白' }));
  });
  it('shows a native reference-picker failure without an unhandled UI rejection', async () => {
    const api = adapter();
    api.pickReference = vi.fn(async () => { throw new Error('picker unavailable'); });
    render(<PresalesWorkspacePage adapter={api} projectId="v3" onDirtyChange={vi.fn()} />);
    await userEvent.click(await screen.findByRole('button', { name: '选择风格参考' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('picker unavailable');
  });
  it('sends saved null-base feedback for a fresh request after the running page gains a version', async () => {
    const user = userEvent.setup(); const api = adapter();
    const projectState = structuredClone(project) as V3Project;
    let queueState = structuredClone(queue) as V3QueueSnapshot;
    let notify = () => {};
    vi.mocked(api.load).mockImplementation(async () => projectState);
    vi.mocked(api.queue).mockImplementation(async () => queueState);
    api.subscribe = vi.fn(listener => { notify = () => listener(2); return () => {}; });
    vi.mocked(api.saveFeedback).mockImplementation(async input => {
      if (projectState.kind !== 'frozen') throw new Error('wrong kind');
      projectState.project.pages[0]!.feedbackDrafts = [{ baseVersionId: null, revision: 1, text: input.text, updatedAt: 'today' }];
      return { baseVersionId: null, revision: 1, text: input.text, updatedAt: 'today' };
    });
    api.enqueue = vi.fn(async (_projectId, _batchId, pages: V3PageRequest[]) => ({ jobs: pages.map(item => ({ requestId: item.requestId, target: { projectId: 'v3', slideId: item.slideId } })), reusedRequestIds: [] }));
    render(<PresalesWorkspacePage adapter={api} projectId="v3" onDirtyChange={vi.fn()} />);
    await user.type(await screen.findByRole('textbox', { name: '下一次生成说明' }), '保留这一页的留白');
    await user.click(screen.getByRole('button', { name: '保存下一次生成说明' }));
    await waitFor(() => expect(api.saveFeedback).toHaveBeenCalledTimes(1));
    if (projectState.kind !== 'frozen') throw new Error('wrong kind');
    const first = projectState.project.pages[0]!;
    first.currentVersionId = 'a-v1';
    first.versions = [{ versionId: 'a-v1', sequence: 1, requestId: 'a-job', attemptId: 'attempt', basis, image: { assetId: 'asset-a-v1', sha256: 'hash-a-v1' }, provenance: { kind: 'presales' }, createdAt: 'today', missingImage: null }];
    first.revision = 9;
    queueState = { ...queueState, jobs: queueState.jobs.map(job => job.slideId === 'a' ? { ...job, status: 'succeeded' } : job) };
    await act(async () => { notify(); });
    await user.click(await screen.findByRole('button', { name: '生成新稿' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '确认批量生成' }));
    await waitFor(() => expect(api.enqueue).toHaveBeenCalledWith('v3', expect.any(String), [expect.objectContaining({ slideId: 'a', parentVersionId: null, feedback: '保留这一页的留白' })]));
  });
  it('keeps an uncertain request fenced across route return until the exact native job is read', async () => {
    const user = userEvent.setup(); const api = adapter();
    const projectState = structuredClone(project) as V3Project;
    if (projectState.kind !== 'frozen') throw new Error('wrong kind');
    projectState.project.summary.projectId = 'route-uncertain-v3';
    let queueState = { ...structuredClone(queue), jobs: [] } as V3QueueSnapshot;
    let attemptedId = '';
    let notify = () => {};
    vi.mocked(api.load).mockImplementation(async () => projectState);
    vi.mocked(api.queue).mockImplementation(async () => queueState);
    api.subscribe = vi.fn(listener => { notify = () => listener(2); return () => {}; });
    api.enqueue = vi.fn(async (_projectId, _batchId, pages) => { attemptedId = pages[0]!.requestId; throw new Error('transport lost'); });
    const mounted = render(<PresalesWorkspacePage adapter={api} projectId="route-uncertain-v3" onDirtyChange={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: /第 2 页 b/ }));
    await user.click(screen.getByRole('button', { name: '生成新稿' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '确认批量生成' }));
    await waitFor(() => expect(attemptedId).not.toBe(''));
    mounted.unmount();
    render(<PresalesWorkspacePage adapter={api} projectId="route-uncertain-v3" initialPageId="b" onDirtyChange={vi.fn()} />);
    expect(await screen.findByRole('button', { name: '生成新稿' })).toBeDisabled();
    queueState = { ...queueState, jobs: [{ kind: 'image', requestId: 'unrelated', projectId: 'route-uncertain-v3', slideId: 'b', status: 'succeeded', sequence: 9, error: null }] };
    await act(async () => { notify(); });
    expect(screen.getByRole('button', { name: '生成新稿' })).toBeDisabled();
    queueState = { ...queueState, jobs: [
      { ...queueState.jobs[0]!, requestId: attemptedId, status: 'failed', sequence: 9, error: 'failed before image publication' },
      { ...queueState.jobs[0]!, requestId: 'later-B', status: 'succeeded', sequence: 10, error: null },
    ] };
    await act(async () => { notify(); });
    await waitFor(() => expect(screen.getByRole('button', { name: '生成新稿' })).toBeEnabled());
    expect(api.enqueue).toHaveBeenCalledTimes(1);
  });
  it('recovers from a definite host validation failure before native enqueue is invoked', async () => {
    const user = userEvent.setup(); const api = adapter();
    const projectState = structuredClone(project) as V3Project;
    let loadedRef: V3Project | null = null;
    let notify = () => {};
    vi.mocked(api.load).mockImplementation(async () => { loadedRef = structuredClone(projectState); return loadedRef; });
    vi.mocked(api.queue).mockImplementation(async () => ({ ...queue, jobs: [] }));
    api.subscribe = vi.fn(listener => { notify = () => listener(2); return () => {}; });
    api.enqueue = vi.fn();
    render(<PresalesWorkspacePage adapter={api} projectId="v3" initialPageId="b" onDirtyChange={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: '生成新稿' }));
    if (!loadedRef || (loadedRef as V3Project).kind !== 'frozen') throw new Error('missing loaded project');
    (loadedRef as Extract<V3Project, { kind: 'frozen' }>).project.pages[1]!.visualBasis = null;
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '确认批量生成' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('提交前校验未通过');
    expect(api.enqueue).not.toHaveBeenCalled();
    await act(async () => { notify(); });
    await waitFor(() => expect(screen.getByRole('button', { name: '生成新稿' })).toBeEnabled());
  });
});
