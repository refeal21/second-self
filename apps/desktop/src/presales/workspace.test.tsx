// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PresalesWorkspacePage } from './workspace.js';
import type { PresalesAdapter, V3PageRequest, V3Project, V3QueueSnapshot } from './adapter.js';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const basis = { hashAlgorithm: 'sha', spec: { version: 's', sha256: 's' }, design: { version: 'd', sha256: 'd' }, skill: { version: 'k', sha256: 'k' }, palette: { version: 'p', sha256: 'p' } };
const page = (id: string, ordinal: number, currentVersionId: string | null) => ({ slideId: id, ordinal, spec: { id, title: id, purpose: '说明' }, design: {}, visualBasis: basis, currentVersionId, versions: currentVersionId ? [{ versionId: currentVersionId, sequence: 1, requestId: `req-${id}`, attemptId: 'attempt', basis, image: { assetId: `asset-${id}`, sha256: `hash-${id}` }, provenance: { kind: 'presales' }, createdAt: 'today', missingImage: null }] : [], approval: null, feedback: null, revision: 8, intentRequestId: null, approvals: [], feedbackDrafts: [], references: [] });
const project = { kind: 'frozen', project: { summary: { projectId: 'v3', name: '副本', pageCount: 3, revision: 1, createdAt: 'today' }, origin: { sourceProjectId: 'old', sourceRevision: 4, hashAlgorithm: 'sha', snapshotDigest: 'digest' }, frozenCheckpoint: {}, palette: { revision: 1, profile: null, locked: true }, pages: [page('a', 1, null), page('b', 2, 'b-v1'), page('c', 3, null)], deliverySnapshot: null } } as V3Project;
const queue = { dispatchAvailable: true, settings: { concurrency: 4, paused: false, epoch: 1 }, remoteActive: 1, succeeded: 0, capabilities: { generation: true, referenceEditing: true }, jobs: [{ kind: 'image', requestId: 'a-job', projectId: 'v3', slideId: 'a', status: 'running', sequence: 1, error: null }, { kind: 'image', requestId: 'c-job', projectId: 'v3', slideId: 'c', status: 'queued', sequence: 2, error: null }] } as V3QueueSnapshot;
function adapter() { return { load: vi.fn(async () => project), queue: vi.fn(async () => queue), subscribe: vi.fn(() => () => {}), readImage: vi.fn(async () => ({ mimeType: 'image/png', base64: 'aGVsbG8=' })), approveVersion: vi.fn(async () => ({ approvalId: 'approved', versionId: 'b-v1', imageSha256: 'hash-b', basis, decidedAt: 'today' })), saveFeedback: vi.fn(async input => ({ baseVersionId: input.baseVersionId, text: input.text, revision: 1, updatedAt: 'today' })) } as unknown as PresalesAdapter; }

describe('native presales workspace', () => {
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
    queueState = { ...queueState, jobs: [{ ...queueState.jobs[0]!, requestId: attemptedId }] };
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
