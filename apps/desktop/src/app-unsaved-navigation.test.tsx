/* @vitest-environment jsdom */

import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNativePipeline } from '../../worker/src/native-pipeline.js';
import { App } from './App.js';
import {
  createDemoDesktopAdapter,
  type DesktopAdapter,
} from './desktop-adapter.js';

const projectId = 'native-guard-project';
const projectUrl = `#/workspace/${projectId}`;
const discardMessage = '大纲、逐页细化、结构修订或生成说明尚未保存。离开将丢弃这些修改，是否继续？';

function nativeAdapter(): DesktopAdapter {
  const demo = createDemoDesktopAdapter();
  const state = structuredClone(demo.initialState);
  state.projects = [{
    id: projectId,
    name: '受保护项目',
    goal: '验证未保存导航保护',
    stage: '材料',
    workflowStatus: 'intake',
    progress: 10,
    updatedAt: '2026-09-07T00:00:00.000Z',
  }];
  state.collections.projects = 'loaded';

  return {
    ...demo,
    mode: 'tauri',
    initialState: structuredClone(state),
    loadInitialState: async () => structuredClone(state),
    listProjects: async () => structuredClone(state.projects),
    loadProjectPipeline: async () => createNativePipeline({
      id: projectId,
      name: '受保护项目',
      goal: '验证未保存导航保护',
      createdAt: '2026-09-07T00:00:00.000Z',
    }),
  };
}

async function renderDirtyWorkspace() {
  const user = userEvent.setup();
  render(<App adapter={nativeAdapter()} />);
  const draft = await screen.findByRole('textbox', { name: '本次任务说明' });
  await user.type(draft, '尚未保存的草稿');
  return { user, draft };
}

describe('native workspace unsaved navigation protection', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', projectUrl);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    window.history.replaceState({}, '', '#/dashboard');
  });

  it('keeps the exact workspace URL, page, and draft when sidebar navigation is canceled', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { user, draft } = await renderDirtyWorkspace();

    await user.click(screen.getByRole('link', { name: '通用任务' }));

    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm).toHaveBeenCalledWith(discardMessage);
    expect(window.location.hash).toBe(projectUrl);
    expect(screen.getByRole('heading', { name: '受保护项目' })).toBeInTheDocument();
    expect(draft).toHaveValue('尚未保存的草稿');
  });

  it('leaves through the sidebar after confirmation', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { user } = await renderDirtyWorkspace();

    await user.click(screen.getByRole('link', { name: '通用任务' }));

    expect(confirm).toHaveBeenCalledOnce();
    expect(await screen.findByRole('heading', { name: '通用任务' })).toBeInTheDocument();
    expect(window.location.hash).toBe('#/tasks');
  });

  it('uses the same single guard for the workspace return action', async () => {
    const confirm = vi.spyOn(window, 'confirm')
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    const { user, draft } = await renderDirtyWorkspace();

    await user.click(screen.getByRole('button', { name: '返回 PPT 项目' }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(window.location.hash).toBe(projectUrl);
    expect(draft).toHaveValue('尚未保存的草稿');

    await user.click(screen.getByRole('button', { name: '返回 PPT 项目' }));
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(await screen.findByRole('heading', { name: '项目列表' })).toBeInTheDocument();
    expect(window.location.hash).toBe('#/projects');
  });

  it('cancels a paired history/hash event once and restores the exact project route', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { draft } = await renderDirtyWorkspace();

    act(() => {
      window.history.replaceState({}, '', '#/approvals');
      window.dispatchEvent(new PopStateEvent('popstate'));
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });

    expect(confirm).toHaveBeenCalledOnce();
    expect(window.location.hash).toBe(projectUrl);
    expect(screen.getByRole('heading', { name: '受保护项目' })).toBeInTheDocument();
    expect(draft).toHaveValue('尚未保存的草稿');
  });

  it('accepts a paired history/hash event once and clears the dirty guard', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await renderDirtyWorkspace();

    act(() => {
      window.history.replaceState({}, '', '#/approvals');
      window.dispatchEvent(new PopStateEvent('popstate'));
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });

    expect(confirm).toHaveBeenCalledOnce();
    expect(await screen.findByRole('heading', { name: '审批中心' })).toBeInTheDocument();
    expect(window.location.hash).toBe('#/approvals');

    act(() => {
      window.history.replaceState({}, '', '#/tasks');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(confirm).toHaveBeenCalledOnce();
    expect(await screen.findByRole('heading', { name: '通用任务' })).toBeInTheDocument();
  });

  it('prevents standard beforeunload only while the native workspace is dirty', async () => {
    const cleanEvent = new Event('beforeunload', { cancelable: true });
    render(<App adapter={nativeAdapter()} />);
    await screen.findByRole('textbox', { name: '本次任务说明' });

    window.dispatchEvent(cleanEvent);
    expect(cleanEvent.defaultPrevented).toBe(false);

    await userEvent.type(
      screen.getByRole('textbox', { name: '本次任务说明' }),
      '尚未保存的草稿',
    );
    const dirtyEvent = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(dirtyEvent);
    expect(dirtyEvent.defaultPrevented).toBe(true);
  });

  it('keeps clean sidebar navigation prompt-free', async () => {
    const confirm = vi.spyOn(window, 'confirm');
    const user = userEvent.setup();
    render(<App adapter={nativeAdapter()} />);
    await screen.findByRole('textbox', { name: '本次任务说明' });

    await user.click(screen.getByRole('link', { name: '通用任务' }));

    expect(confirm).not.toHaveBeenCalled();
    expect(await screen.findByRole('heading', { name: '通用任务' })).toBeInTheDocument();
  });
});
