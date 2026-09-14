// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PresalesWorkspacePage } from './workspace.js';
import type { PresalesAdapter, V3Project, V3QueueSnapshot } from './adapter.js';

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
});
