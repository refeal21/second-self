// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { DraftWorkspace } from './draft-workspace.js';
import type { PresalesAdapter, V3ImportedDraft, V3QueueSnapshot } from './adapter.js';

afterEach(cleanup);
it('shows saved destination context and invokes genuine outline authoring without approving it', async () => {
  const user = userEvent.setup();
  const draft = { schemaVersion: 1, summary: { projectId: 'copy', name: '内容修订', pageCount: 0, revision: 3, createdAt: 'today' }, origin: { sourceProjectId: 'old', sourceRevision: 2, hashAlgorithm: 'sha', snapshotDigest: 'digest' }, importId: 'import', sources: [], brief: '旧简介', analysis: { output: { findings: [], dataPoints: [], sourceMap: [] } }, context: null, preferences: {}, originalOutline: null, palette: { revision: 0, profile: null, locked: false }, comparisonPages: [], authored: { schemaVersion: 1, skill: {}, events: [], checkpoint: null, settings: { brief: '保存的简介', context: { taskBrief: '保存的任务', sourceInstructions: {}, outlineRequirements: '要求' }, palette: { revision: 0, profile: null, locked: false }, paletteOrigin: 'imported' } } } as V3ImportedDraft;
  const queue = { dispatchAvailable: true, capabilities: { generation: true, referenceEditing: false }, settings: { concurrency: 4, paused: false, epoch: 1 }, remoteActive: 0, succeeded: 0, jobs: [] } as V3QueueSnapshot;
  const author = vi.fn(async (input: { operationId: string }) => ({ operationId: input.operationId, status: 'queued', target: { stage: 'outline', prompt: '真实保存的请求', promptVersion: 'v1', brief: '任务实际保存的简介', context: { taskBrief: '任务实际保存的目标', outlineRequirements: '任务实际保存的要求', sourceInstructions: { source1: '任务实际保存的材料用途' } }, palette: { revision: 1, locked: true, profile: { primaryColor: '#123456', backgroundColor: '#ffffff', textColor: '#202838', accentColors: [], instructions: '', template: null } } } }));
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
  const draft = { schemaVersion: 1, summary: { projectId: 'uncertain', name: '修订', pageCount: 0, revision: 1, createdAt: 'today' }, origin: { sourceProjectId: 'old', sourceRevision: 1, hashAlgorithm: 'sha', snapshotDigest: 'digest' }, importId: 'import', sources: [], brief: '简介', analysis: null, context: null, preferences: {}, originalOutline: null, palette: { revision: 0, profile: null, locked: false }, comparisonPages: [], authored: { schemaVersion: 1, skill: {}, settings: { brief: '简介', context: { taskBrief: '', sourceInstructions: {}, outlineRequirements: '' }, palette: { revision: 0, profile: null, locked: false }, paletteOrigin: 'imported' }, events: [], checkpoint: null } } as V3ImportedDraft;
  const queue = { dispatchAvailable: true, capabilities: { generation: true, referenceEditing: false }, settings: { concurrency: 4, paused: false, epoch: 1 }, remoteActive: 0, succeeded: 0, jobs: [] } as V3QueueSnapshot;
  const author = vi.fn(async () => { throw new Error('transport disconnected'); });
  const api = { author, textHistory: vi.fn(async () => []), load: vi.fn(async () => ({ kind: 'draft', project: draft })), queue: vi.fn(async () => queue) } as unknown as PresalesAdapter;
  render(<DraftWorkspace adapter={api} project={draft} queue={queue} refresh={async () => {}} onDirtyChange={() => {}} />);
  await user.click(screen.getByRole('button', { name: '生成大纲与售前计划' }));
  expect((await screen.findAllByRole('alert')).some(alert => alert.textContent?.includes('transport disconnected'))).toBe(true);
  expect(screen.getByRole('button', { name: '生成大纲与售前计划' })).toBeDisabled();
  expect(author).toHaveBeenCalledTimes(1);
});
