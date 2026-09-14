// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from './App.js';
import { createDemoDesktopAdapter } from './desktop-adapter.js';
import type { PresalesAdapter } from './presales/adapter.js';

afterEach(() => { cleanup(); window.history.replaceState({}, '', '#/dashboard'); });
it('routes a tagged v3 identity without coercing it into a legacy project row', async () => {
  window.history.replaceState({}, '', '#/workspace/presales-v3/copy');
  const desktop = { ...createDemoDesktopAdapter(), mode: 'tauri' as const, loadInitialState: async () => ({ ...createDemoDesktopAdapter().initialState, projects: [], collections: { projects: 'loaded' as const, approvals: 'loaded' as const, memories: 'loaded' as const } }), listProjects: async () => [] };
  const presales = { load: vi.fn(async () => ({ kind: 'history_only', project: { summary: { projectId: 'copy', name: '历史副本', pageCount: 0, revision: 1, createdAt: 'today' }, origin: { sourceProjectId: 'legacy', sourceRevision: 2, hashAlgorithm: 'sha', snapshotDigest: 'd' }, pages: [], palette: { revision: 0, profile: null, locked: true }, reasons: [], deliverySnapshot: null } })), queue: vi.fn(async () => ({ settings: { concurrency: 4, paused: false, epoch: 1 }, jobs: [], capabilities: { generation: false, referenceEditing: false } })), subscribe: vi.fn(() => () => {}) } as unknown as PresalesAdapter;
  render(<App adapter={desktop} presalesAdapter={presales} />);
  expect(await screen.findByRole('heading', { name: '历史副本' })).toBeVisible();
  expect(presales.load).toHaveBeenCalledWith('copy');
});

it('requires prepare/review/publish confirmation and leaves the legacy row intact', async () => {
  window.history.replaceState({}, '', '#/projects'); const user = userEvent.setup();
  const state = structuredClone(createDemoDesktopAdapter().initialState);
  state.projects = [{ id: 'legacy', name: '原项目', goal: '目标', stage: '材料', progress: 10, updatedAt: 'today' }];
  state.collections.projects = 'loaded';
  const desktop = { ...createDemoDesktopAdapter(), mode: 'tauri' as const, initialState: state, loadInitialState: async () => state, listProjects: async () => state.projects };
  const prepareCopy = vi.fn(async () => ({ preparationId: 'prep', sourceProjectId: 'legacy', sourceRevision: 7, kind: 'history_only', destination: { projectId: 'copy', name: '格式副本', pageCount: 1, revision: 1, createdAt: 'today' }, reasons: ['旧图片缺失'] }));
  const copy = { kind: 'history_only', project: { summary: { projectId: 'copy', name: '格式副本', pageCount: 0, revision: 1, createdAt: 'today' }, origin: { sourceProjectId: 'legacy', sourceRevision: 7, hashAlgorithm: 'sha', snapshotDigest: 'd' }, pages: [], palette: { revision: 0, profile: null, locked: true }, reasons: [], deliverySnapshot: null } };
  const publishCopy = vi.fn(async () => copy);
  const presales = { list: vi.fn(async () => []), load: vi.fn(async () => copy), queue: vi.fn(async () => ({ settings: { concurrency: 4, paused: false, epoch: 1 }, jobs: [], capabilities: { generation: false, referenceEditing: false } })), subscribe: vi.fn(() => () => {}), prepareCopy, publishCopy, discardCopy: vi.fn(async () => {}) } as unknown as PresalesAdapter;
  render(<App adapter={desktop} presalesAdapter={presales} />);
  await user.click(await screen.findByRole('button', { name: '格式副本' }));
  expect(screen.getByRole('dialog', { name: '确认售前副本' })).toHaveTextContent('修订 7');
  expect(publishCopy).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: '确认发布副本' }));
  expect(publishCopy).toHaveBeenCalledWith('prep');
  expect(window.location.hash).toBe('#/workspace/presales-v3/copy');
  expect(state.projects[0]!.name).toBe('原项目');
});
