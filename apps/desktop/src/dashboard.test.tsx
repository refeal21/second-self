/* @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNativePipeline } from '../../worker/src/native-pipeline.js';
import { App } from './App.js';
import { createDemoDesktopAdapter, type DesktopAdapter, type ProjectSummary } from './desktop-adapter.js';

const projects: ProjectSummary[] = [
  { id: 'old-project', name: '旧项目', goal: '旧项目说明', stage: '材料', workflowStatus: 'intake', progress: 10, updatedAt: 'unix:1788406147843' },
  { id: 'target-project', name: '目标项目', goal: '目标项目说明', stage: '大纲审批', workflowStatus: 'outline_review', progress: 35, updatedAt: '2026-09-07T01:49:23.098Z' },
];

function fixture() {
  const demo = createDemoDesktopAdapter();
  const state = { ...structuredClone(demo.initialState), projects: structuredClone(projects) };
  const adapter: DesktopAdapter = {
    ...demo, mode: 'tauri', initialState: { ...state, projects: [], collections: { ...state.collections, projects: 'loading' } },
    loadInitialState: async () => structuredClone(state),
    listProjects: async () => structuredClone(state.projects),
    async loadProjectPipeline(id) {
      const project = state.projects.find((p) => p.id === id);
      if (!project) throw new Error('项目不存在');
      return createNativePipeline({ id, name: project.name, goal: project.goal, createdAt: '2026-09-07T00:00:00.000Z' });
    },
  };
  return { adapter, state };
}

afterEach(() => { cleanup(); window.history.replaceState({}, '', '#/dashboard'); });

describe('recent work dashboard', () => {
  it('does not report a project-loading failure when only Codex connection fails', async () => {
    const { adapter } = fixture();
    adapter.connectAccount = async () => { throw new Error('Codex 无法连接'); };
    render(<App adapter={adapter} />);
    expect(await screen.findByText('Codex 无法连接')).toBeInTheDocument();
    expect(screen.getByText('目标项目')).toBeInTheDocument();
    expect(screen.queryByText(/项目列表加载失败/)).not.toBeInTheDocument();
  });

  it('renders semantic columns, chronological rows, readable times and checkpoint status', async () => {
    const { adapter } = fixture();
    render(<App adapter={adapter} />);
    await screen.findByText('目标项目');
    const table = screen.getByRole('table', { name: '最近工作' });
    expect(within(table).getAllByRole('columnheader')).toHaveLength(6);
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('目标项目');
    expect(rows[0]).toHaveTextContent('待审批');
    expect(rows[1]).toHaveTextContent('待开始');
    expect(table).not.toHaveTextContent('unix:');
    expect(table).not.toHaveTextContent('T01:49');
    expect(rows[0]?.querySelector('time')?.textContent).toMatch(/^2026-09-07 \d{2}:49$/);
  });

  it('opens the clicked row rather than the initial/default project', async () => {
    const user = userEvent.setup();
    const { adapter } = fixture();
    render(<App adapter={adapter} />);
    await user.click(await screen.findByText('目标项目说明'));
    expect(await screen.findByRole('heading', { name: '目标项目' })).toBeInTheDocument();
    expect(window.location.hash).toBe('#/workspace/target-project');
    expect(screen.getByRole('textbox', { name: '本次任务说明' })).toBeInTheDocument();
  });

  it('supports keyboard opening through the task name', async () => {
    const user = userEvent.setup();
    const { adapter } = fixture();
    render(<App adapter={adapter} />);
    const link = await screen.findByRole('link', { name: '目标项目' });
    link.focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('heading', { name: '目标项目' })).toBeInTheDocument();
  });

  it('keeps view-all pointing to the project list, not a default detail', async () => {
    const user = userEvent.setup();
    const { adapter } = fixture();
    render(<App adapter={adapter} />);
    await screen.findByText('目标项目');
    await user.click(screen.getByRole('button', { name: '查看全部工作' }));
    expect(screen.getByRole('heading', { name: '项目列表' })).toBeInTheDocument();
    expect(window.location.hash).toBe('#/projects');
  });

  it('restores the exact project from its detail URL after hydration', async () => {
    window.history.replaceState({}, '', '#/workspace/target-project');
    const { adapter } = fixture();
    render(<App adapter={adapter} />);
    await screen.findByRole('textbox', { name: '本次任务说明' });
    expect(await screen.findByRole('heading', { name: '目标项目' })).toBeInTheDocument();
  });

  it('keeps the project route when the keyboard skip link targets main content', async () => {
    window.history.replaceState({}, '', '#/workspace/target-project');
    const user = userEvent.setup();
    const { adapter } = fixture();
    render(<App adapter={adapter} />);
    await screen.findByRole('textbox', { name: '本次任务说明' });
    await user.click(screen.getByRole('link', { name: '跳到主要内容' }));
    expect(window.location.hash).toBe('#/workspace/target-project');
    expect(document.activeElement).toHaveAttribute('id', 'main-content');
    expect(screen.getByRole('heading', { name: '目标项目' })).toBeInTheDocument();
  });

  it('does not substitute a different project for a missing detail ID', async () => {
    window.history.replaceState({}, '', '#/workspace/missing-project');
    const { adapter } = fixture();
    render(<App adapter={adapter} />);
    expect(await screen.findByRole('heading', { name: '项目工作台不可用' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '旧项目' })).not.toBeInTheDocument();
  });

  it('follows history navigation to the ID in that history entry', async () => {
    const user = userEvent.setup();
    const { adapter } = fixture();
    render(<App adapter={adapter} />);
    await user.click(await screen.findByText('目标项目说明'));
    await screen.findByRole('heading', { name: '目标项目' });
    act(() => {
      window.history.replaceState({}, '', '#/workspace/old-project');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await screen.findByRole('textbox', { name: '本次任务说明' });
    expect(await screen.findByRole('heading', { name: '旧项目' })).toBeInTheDocument();
  });

  it('refreshes latest progress on return without overwriting live connection state', async () => {
    const user = userEvent.setup();
    const { adapter, state } = fixture();
    render(<App adapter={adapter} />);
    await user.click(await screen.findByText('目标项目说明'));
    await screen.findByRole('heading', { name: '目标项目' });
    state.projects[1] = { ...state.projects[1]!, workflowStatus: 'completed', stage: '已完成', progress: 100, updatedAt: '2026-09-07T03:00:00Z' };
    await user.click(screen.getByRole('link', { name: '首页' }));
    const row = (await screen.findByRole('link', { name: '目标项目' })).closest('tr')!;
    expect(within(row).getByText('100%')).toBeInTheDocument();
    expect(within(row).getAllByText('已完成')).toHaveLength(2);
    expect(screen.getByRole('complementary', { name: '活动状态' })).toHaveTextContent('已连接');
  });

  it('shows refresh failure without disguising it as empty and can retry', async () => {
    const user = userEvent.setup();
    const { adapter, state } = fixture();
    adapter.listProjects = vi.fn().mockRejectedValueOnce(new Error('读取失败')).mockResolvedValueOnce([]);
    render(<App adapter={adapter} />);
    await screen.findByText('目标项目');
    await user.click(screen.getByRole('link', { name: '通用任务' }));
    await user.click(screen.getByRole('link', { name: '首页' }));
    expect(await screen.findByText(/项目列表加载失败/)).toBeInTheDocument();
    expect(screen.getByText(state.projects[1]!.name)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '重试加载项目' }));
    expect(await screen.findByText('当前没有项目。')).toBeInTheDocument();
  });

  it('ignores an old refresh when the user already opened another project', async () => {
    const user = userEvent.setup();
    const { adapter } = fixture();
    let complete!: (value: ProjectSummary[]) => void;
    adapter.listProjects = () => new Promise((resolve) => { complete = resolve; });
    render(<App adapter={adapter} />);
    await screen.findByText('目标项目');
    await user.click(screen.getByRole('link', { name: '通用任务' }));
    await user.click(screen.getByRole('link', { name: '首页' }));
    expect(await screen.findByText(/正在刷新项目/)).toBeInTheDocument();
    await user.click(screen.getByText('目标项目说明'));
    await screen.findByRole('heading', { name: '目标项目' });
    await act(async () => complete([]));
    expect(screen.getByRole('heading', { name: '目标项目' })).toBeInTheDocument();
  });
});
