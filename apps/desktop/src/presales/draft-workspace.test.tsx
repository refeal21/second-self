// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { DraftWorkspace } from './draft-workspace.js';
import type { PresalesAdapter, V3ImportedDraft, V3QueueSnapshot } from './adapter.js';

afterEach(cleanup);
it('shows saved destination context and invokes genuine outline authoring without approving it', async () => {
  const user = userEvent.setup();
  const draft = { schemaVersion: 1, summary: { projectId: 'copy', name: '内容修订', pageCount: 0, revision: 3, createdAt: 'today' }, origin: { sourceProjectId: 'old', sourceRevision: 2, hashAlgorithm: 'sha', snapshotDigest: 'digest' }, importId: 'import', sources: [], brief: '旧简介', analysis: { output: { findings: [], dataPoints: [], sourceMap: [] } }, context: null, preferences: {}, originalOutline: null, palette: { revision: 0, profile: null, locked: false }, comparisonPages: [], authored: { schemaVersion: 1, skill: {}, events: [], checkpoint: null, settings: { brief: '保存的简介', context: { taskBrief: '保存的任务', sourceInstructions: {}, outlineRequirements: '要求' }, palette: { revision: 0, profile: null, locked: false }, paletteOrigin: 'imported' } } } as V3ImportedDraft;
  const queue = { dispatchAvailable: true, capabilities: { generation: true, referenceEditing: false }, settings: { concurrency: 4, paused: false, epoch: 1 }, remoteActive: 0, succeeded: 0, jobs: [] } as V3QueueSnapshot;
  const author = vi.fn(async (input: { operationId: string; attemptId: string }) => ({ operationId: input.operationId, attemptId: input.attemptId, status: 'queued', target: { stage: 'outline', prompt: '真实保存的请求', promptVersion: 'v1', brief: '任务实际保存的简介', context: { taskBrief: '任务实际保存的目标', outlineRequirements: '任务实际保存的要求', sourceInstructions: { source1: '任务实际保存的材料用途' } }, palette: { revision: 1, locked: true, profile: { primaryColor: '#123456', backgroundColor: '#ffffff', textColor: '#202838', accentColors: [], instructions: '', template: null } } } }));
  const api = { author, textHistory: vi.fn(async () => []), load: vi.fn(async () => ({ kind: 'draft', project: draft })), queue: vi.fn(async () => queue) } as unknown as PresalesAdapter;
  render(<DraftWorkspace adapter={api} project={draft} queue={queue} refresh={async () => {}} onDirtyChange={() => {}} />);
  expect(screen.getByRole('textbox', { name: '项目简介' })).toHaveValue('保存的简介');
  await user.click(screen.getByRole('button', { name: '生成大纲与售前计划' }));
  expect(author).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'copy', expectedRevision: 3, stage: 'outline' }));
  expect(screen.getByText(/未自动批准/)).toBeVisible();
  await user.click(screen.getByText('查看实际保存的请求与上下文'));
  expect(screen.getByText('任务实际保存的简介')).toBeVisible();
  expect(screen.getByText('任务实际保存的材料用途')).toBeVisible();
  expect(screen.getByText(/#123456/)).toBeVisible();
});

it('does not offer a second text request after an uncertain authoring response', async () => {
  const user = userEvent.setup();
  const draft = { schemaVersion: 1, summary: { projectId: 'uncertain', name: '修订', pageCount: 0, revision: 1, createdAt: 'today' }, origin: { sourceProjectId: 'old', sourceRevision: 1, hashAlgorithm: 'sha', snapshotDigest: 'digest' }, importId: 'import', sources: [], brief: '简介', analysis: { output: { findings: [], dataPoints: [], sourceMap: [] } }, context: null, preferences: {}, originalOutline: null, palette: { revision: 0, profile: null, locked: false }, comparisonPages: [], authored: { schemaVersion: 1, skill: {}, settings: { brief: '简介', context: { taskBrief: '', sourceInstructions: {}, outlineRequirements: '' }, palette: { revision: 0, profile: null, locked: false }, paletteOrigin: 'imported' }, events: [], checkpoint: null } } as V3ImportedDraft;
  const queue = { dispatchAvailable: true, capabilities: { generation: true, referenceEditing: false }, settings: { concurrency: 4, paused: false, epoch: 1 }, remoteActive: 0, succeeded: 0, jobs: [] } as V3QueueSnapshot;
  const author = vi.fn(async () => { throw new Error('transport disconnected'); });
  const api = { author, textHistory: vi.fn(async () => []), load: vi.fn(async () => ({ kind: 'draft', project: draft })), queue: vi.fn(async () => queue) } as unknown as PresalesAdapter;
  render(<DraftWorkspace adapter={api} project={draft} queue={queue} refresh={async () => {}} onDirtyChange={() => {}} />);
  await user.click(screen.getByRole('button', { name: '生成大纲与售前计划' }));
  expect((await screen.findAllByRole('alert')).some(alert => alert.textContent?.includes('transport disconnected'))).toBe(true);
  expect(screen.getByRole('button', { name: '生成大纲与售前计划' })).toBeDisabled();
  expect(author).toHaveBeenCalledTimes(1);
});

it('explicitly retries the identical text operation identity after an uncertain transport rejection', async () => {
  const user = userEvent.setup();
  const draft = { schemaVersion: 1, summary: { projectId: 'retry-original-id', name: '修订', pageCount: 0, revision: 7, createdAt: 'today' }, origin: { sourceProjectId: 'old', sourceRevision: 1, hashAlgorithm: 'sha', snapshotDigest: 'digest' }, importId: 'import', sources: [], brief: '简介', analysis: { output: { findings: [], dataPoints: [], sourceMap: [] } }, context: null, preferences: {}, originalOutline: null, palette: { revision: 0, profile: null, locked: false }, comparisonPages: [], authored: { schemaVersion: 1, skill: {}, settings: { brief: '简介', context: { taskBrief: '', sourceInstructions: {}, outlineRequirements: '' }, palette: { revision: 0, profile: null, locked: false }, paletteOrigin: 'imported' }, events: [], checkpoint: null } } as V3ImportedDraft;
  const queue = { dispatchAvailable: true, capabilities: { generation: true, referenceEditing: false }, settings: { concurrency: 4, paused: false, epoch: 1 }, remoteActive: 0, succeeded: 0, jobs: [] } as V3QueueSnapshot;
  const author = vi.fn().mockRejectedValueOnce(new Error('transport disconnected')).mockImplementationOnce(async (input: { operationId: string; attemptId: string }) => ({ operationId: input.operationId, attemptId: input.attemptId, status: 'queued', target: { stage: 'outline', prompt: 'captured', promptVersion: 'v1', brief: '', context: { taskBrief: '', sourceInstructions: {}, outlineRequirements: '' }, palette: draft.palette } }));
  const api = { author, textHistory: vi.fn(async () => []), load: vi.fn(async () => ({ kind: 'draft', project: draft })), queue: vi.fn(async () => queue) } as unknown as PresalesAdapter;
  render(<DraftWorkspace adapter={api} project={draft} queue={queue} refresh={async () => {}} onDirtyChange={vi.fn()} />);
  await user.click(screen.getByRole('button', { name: '生成大纲与售前计划' }));
  expect(await screen.findByRole('button', { name: '用原请求标识重试确认' })).toBeVisible();
  await user.click(screen.getByRole('button', { name: '用原请求标识重试确认' }));
  expect(author).toHaveBeenCalledTimes(2);
  expect(author.mock.calls[1]![0]).toEqual(author.mock.calls[0]![0]);
  await waitFor(() => expect(screen.queryByRole('button', { name: '用原请求标识重试确认' })).not.toBeInTheDocument());
});

it('recovers a definite local missing-analysis validation before creating a text operation ID', async () => {
  const user = userEvent.setup();
  const draft = { schemaVersion: 1, summary: { projectId: 'missing-analysis', name: '修订', pageCount: 0, revision: 1, createdAt: 'today' }, origin: { sourceProjectId: 'old', sourceRevision: 1, hashAlgorithm: 'sha', snapshotDigest: 'digest' }, importId: 'import', sources: [], brief: '简介', analysis: null, context: null, preferences: {}, originalOutline: null, palette: { revision: 0, profile: null, locked: false }, comparisonPages: [], authored: { schemaVersion: 1, skill: {}, settings: { brief: '简介', context: { taskBrief: '', sourceInstructions: {}, outlineRequirements: '' }, palette: { revision: 0, profile: null, locked: false }, paletteOrigin: 'imported' }, events: [], checkpoint: null } } as V3ImportedDraft;
  const queue = { dispatchAvailable: true, capabilities: { generation: true, referenceEditing: false }, settings: { concurrency: 4, paused: false, epoch: 1 }, remoteActive: 0, succeeded: 0, jobs: [] } as V3QueueSnapshot;
  const author = vi.fn(async (input: { operationId: string; attemptId: string }) => ({ operationId: input.operationId, attemptId: input.attemptId, status: 'queued', target: { stage: 'outline', prompt: 'saved', promptVersion: 'v1', brief: '', context: { taskBrief: '', sourceInstructions: {}, outlineRequirements: '' }, palette: draft.palette } }));
  const api = { author, textHistory: vi.fn(async () => []) } as unknown as PresalesAdapter;
  const { rerender } = render(<DraftWorkspace adapter={api} project={draft} queue={queue} refresh={async () => {}} onDirtyChange={vi.fn()} />);
  await user.click(screen.getByRole('button', { name: '生成大纲与售前计划' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('可验证的分析');
  expect(author).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: '用原请求标识重试确认' })).not.toBeInTheDocument();
  const corrected = { ...draft, analysis: { output: { findings: [], dataPoints: [], sourceMap: [] } }, summary: { ...draft.summary, revision: 2 } } as V3ImportedDraft;
  rerender(<DraftWorkspace adapter={api} project={corrected} queue={queue} refresh={async () => {}} onDirtyChange={vi.fn()} />);
  await user.click(screen.getByRole('button', { name: '生成大纲与售前计划' }));
  expect(author).toHaveBeenCalledTimes(1);
});

it('uses ordered newer native revision then complete history before releasing an unadmitted text fence', async () => {
  const user = userEvent.setup();
  const draft = { schemaVersion: 1, summary: { projectId: 'ordered-recovery', name: '修订', pageCount: 0, revision: 7, createdAt: 'today' }, origin: { sourceProjectId: 'old', sourceRevision: 1, hashAlgorithm: 'sha', snapshotDigest: 'digest' }, importId: 'import', sources: [], brief: '简介', analysis: { output: { findings: [], dataPoints: [], sourceMap: [] } }, context: null, preferences: {}, originalOutline: null, palette: { revision: 0, profile: null, locked: false }, comparisonPages: [], authored: { schemaVersion: 1, skill: {}, settings: { brief: '简介', context: { taskBrief: '', sourceInstructions: {}, outlineRequirements: '' }, palette: { revision: 0, profile: null, locked: false }, paletteOrigin: 'imported' }, events: [], checkpoint: null } } as V3ImportedDraft;
  const queue = { dispatchAvailable: true, capabilities: { generation: true, referenceEditing: false }, settings: { concurrency: 4, paused: false, epoch: 1 }, remoteActive: 0, succeeded: 0, jobs: [] } as V3QueueSnapshot;
  let current = draft;
  const calls: string[] = [];
  const author = vi.fn().mockRejectedValueOnce(new Error('transport failed')).mockImplementationOnce(async (input: { operationId: string; attemptId: string }) => ({ operationId: input.operationId, attemptId: input.attemptId, status: 'queued', target: { stage: 'outline', prompt: 'saved', promptVersion: 'v1', brief: '', context: { taskBrief: '', sourceInstructions: {}, outlineRequirements: '' }, palette: draft.palette } }));
  const api = { author, load: vi.fn(async () => { calls.push('load'); return { kind: 'draft', project: current }; }), textHistory: vi.fn(async () => { calls.push('history'); return []; }) } as unknown as PresalesAdapter;
  const { rerender } = render(<DraftWorkspace adapter={api} project={draft} queue={queue} refresh={async () => {}} onDirtyChange={vi.fn()} />);
  await user.click(screen.getByRole('button', { name: '生成大纲与售前计划' }));
  await screen.findByRole('button', { name: '用原请求标识重试确认' });
  vi.mocked(api.load).mockRejectedValueOnce(new Error('load unavailable'));
  calls.length = 0;
  await user.click(screen.getByRole('button', { name: '核对并恢复' }));
  expect(calls).toEqual([]);
  expect(screen.getByRole('button', { name: '用原请求标识重试确认' })).toBeVisible();
  calls.length = 0;
  await user.click(screen.getByRole('button', { name: '核对并恢复' }));
  expect(calls).toEqual(['load']);
  expect(screen.getByRole('button', { name: '用原请求标识重试确认' })).toBeVisible();
  expect(screen.getByRole('button', { name: '生成大纲与售前计划' })).toBeDisabled();
  current = { ...draft, summary: { ...draft.summary, revision: 8 } };
  vi.mocked(api.textHistory).mockRejectedValueOnce(new Error('history unavailable'));
  calls.length = 0;
  await user.click(screen.getByRole('button', { name: '核对并恢复' }));
  expect(calls.slice(0, 2)).toEqual(['load']);
  expect(screen.getByRole('button', { name: '用原请求标识重试确认' })).toBeVisible();
  expect(screen.getByRole('button', { name: '生成大纲与售前计划' })).toBeDisabled();
  calls.length = 0;
  await user.click(screen.getByRole('button', { name: '核对并恢复' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: '用原请求标识重试确认' })).not.toBeInTheDocument());
  expect(calls.slice(0, 2)).toEqual(['load', 'history']);
  rerender(<DraftWorkspace adapter={api} project={current} queue={queue} refresh={async () => {}} onDirtyChange={vi.fn()} />);
  await user.click(screen.getByRole('button', { name: '生成大纲与售前计划' }));
  expect(author).toHaveBeenCalledTimes(2);
  expect(author.mock.calls[1]![0]).toMatchObject({ expectedRevision: 8 });
  expect(author.mock.calls[1]![0].operationId).not.toBe(author.mock.calls[0]![0].operationId);
});

it('reconciles a racing original text admission found after the newer-revision read', async () => {
  const user = userEvent.setup();
  const draft = { schemaVersion: 1, summary: { projectId: 'racing-original', name: '修订', pageCount: 0, revision: 7, createdAt: 'today' }, origin: { sourceProjectId: 'old', sourceRevision: 1, hashAlgorithm: 'sha', snapshotDigest: 'digest' }, importId: 'import', sources: [], brief: '简介', analysis: { output: { findings: [], dataPoints: [], sourceMap: [] } }, context: null, preferences: {}, originalOutline: null, palette: { revision: 0, profile: null, locked: false }, comparisonPages: [], authored: { schemaVersion: 1, skill: {}, settings: { brief: '简介', context: { taskBrief: '', sourceInstructions: {}, outlineRequirements: '' }, palette: { revision: 0, profile: null, locked: false }, paletteOrigin: 'imported' }, events: [], checkpoint: null } } as V3ImportedDraft;
  const queue = { dispatchAvailable: true, capabilities: { generation: true, referenceEditing: false }, settings: { concurrency: 4, paused: false, epoch: 1 }, remoteActive: 0, succeeded: 0, jobs: [] } as V3QueueSnapshot;
  const calls: string[] = [];
  let original: { operationId: string; attemptId: string } | null = null;
  const author = vi.fn(async (input: { operationId: string; attemptId: string }) => { original = input; throw new Error('response lost'); });
  const api = { author, load: vi.fn(async () => { calls.push('load'); return { kind: 'draft', project: { ...draft, summary: { ...draft.summary, revision: 8 } } }; }), textHistory: vi.fn(async () => { calls.push('history'); return original && calls.includes('load') ? [{ operationId: original.operationId, attemptId: original.attemptId, status: 'queued', target: { stage: 'outline', prompt: 'saved original', promptVersion: 'v1', brief: '', context: { taskBrief: '', sourceInstructions: {}, outlineRequirements: '' }, palette: draft.palette } }] : []; }) } as unknown as PresalesAdapter;
  render(<DraftWorkspace adapter={api} project={draft} queue={queue} refresh={async () => {}} onDirtyChange={vi.fn()} />);
  await user.click(screen.getByRole('button', { name: '生成大纲与售前计划' }));
  await screen.findByRole('button', { name: '用原请求标识重试确认' });
  calls.length = 0;
  await user.click(screen.getByRole('button', { name: '核对并恢复' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: '用原请求标识重试确认' })).not.toBeInTheDocument());
  expect(calls.slice(0, 2)).toEqual(['load', 'history']);
  expect(screen.getByText(/saved original/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '生成大纲与售前计划' })).toBeDisabled();
  expect(author).toHaveBeenCalledTimes(1);
});
