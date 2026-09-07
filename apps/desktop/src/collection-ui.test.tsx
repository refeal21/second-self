/* @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import {
  createDemoDesktopAdapter,
  type DesktopAdapter,
  type DesktopCollectionSnapshot,
} from './desktop-adapter.js';
import type { ProjectGeneration } from './project-generation.js';
import { createNativePipeline, type NativePptPipeline } from '../../worker/src/native-pipeline.js';

function collectionFixture(initial: DesktopCollectionSnapshot) {
  const demo = createDemoDesktopAdapter();
  const durable = structuredClone(demo.initialState);
  durable.account = { email: null, plan: null, status: 'unavailable' };
  durable.projects = [{
    id: 'project-review', name: '真实审核项目', goal: '审核真实草稿',
    stage: '逐页细化', progress: 45, updatedAt: '刚刚',
  }];
  durable.approvals = [];
  durable.memories = [];
  let collections = structuredClone(initial);
  let generationListener: ((state: ProjectGeneration | null) => void) | null = null;
  const loadCollections = vi.fn(async () => structuredClone(collections));
  const adapter: DesktopAdapter = {
    ...demo,
    mode: 'tauri',
    initialState: durable,
    loadInitialState: vi.fn(async () => structuredClone(durable)),
    listProjects: vi.fn(async () => structuredClone(durable.projects)),
    loadCollections,
    subscribeConnection(listener) {
      listener({
        account: { email: 'live@example.com', plan: 'pro', status: 'connected' },
        runtime: {
          status: 'connected', detail: 'live connection', model: null,
          address: 'stdio（本机进程）', uptime: null, queue: 1,
        },
      });
      return () => {};
    },
    async connectAccount() {
      return { email: 'live@example.com', plan: 'pro', status: 'connected' };
    },
    subscribeProjectGeneration(_projectId, listener) {
      generationListener = listener;
      listener(null);
      return () => { generationListener = null; };
    },
  };
  return {
    adapter,
    loadCollections,
    setCollections(next: DesktopCollectionSnapshot) { collections = structuredClone(next); },
    publishGeneration(next: ProjectGeneration) { generationListener?.(next); },
  };
}

const emptyCollections: DesktopCollectionSnapshot = {
  approvals: [], memories: [],
  availability: { approvals: 'loaded', memories: 'loaded' },
};

function detailReviewPipeline(): NativePptPipeline {
  const pipeline = createNativePipeline({
    id: 'project-review', name: '真实审核项目', goal: '审核真实草稿',
    createdAt: '2026-09-07T02:00:00.000Z',
  });
  pipeline.revision = 4;
  pipeline.project.workflowStatus = 'detail_review';
  pipeline.outline = {
    version: {
      id: 'project-review-outline-v1', projectId: 'project-review', sequence: 1,
      status: 'frozen', createdAt: '2026-09-07T02:10:00.000Z',
      frozenAt: '2026-09-07T02:20:00.000Z',
    },
    value: {
      title: '真实审核项目',
      slides: [{ id: 'slide-1', title: '结论', purpose: '说明结论' }],
    },
  };
  pipeline.slideSpecs = {
    version: {
      id: 'project-review-slide-specs-v1', projectId: 'project-review', sequence: 1,
      status: 'draft', createdAt: '2026-09-07T02:30:00.000Z', frozenAt: null,
    },
    value: [{
      id: 'slide-1', title: '结论', body: ['结论正文'], tables: [], charts: [], shapes: [],
      sourceMap: [], imageGenerationBrief: '结论页视觉',
    }],
  };
  return pipeline;
}

afterEach(() => {
  cleanup();
  window.history.replaceState({}, '', '#/dashboard');
});

describe('fresh approval and memory routes', () => {
  it('renders approval timestamps as semantic local times on dashboard and center', async () => {
    const user = userEvent.setup();
    const fixture = collectionFixture({
      ...emptyCollections,
      approvals: [
        {
          id: 'approval-iso', projectId: 'project-review', title: '很长的真实审核项目名称',
          detail: '全部页面细化待审核', author: 'PPT 工作流', time: '2026-09-07T08:30:00.000Z',
        },
        {
          id: 'approval-unix', projectId: 'project-review', title: '另一个审核项目',
          detail: '整份大纲待审核', author: 'PPT 工作流', time: 'unix:0',
        },
        {
          id: 'approval-invalid', projectId: 'project-review', title: '旧格式审核项目',
          detail: '视觉版本待审核', author: 'PPT 工作流', time: '日期未知',
        },
      ],
    });
    render(<App adapter={fixture.adapter} initialRoute="dashboard" />);

    const dashboard = screen.getByRole('complementary', { name: '活动状态' });
    expect(await within(dashboard).findByText('全部页面细化待审核')).toBeInTheDocument();
    const dashboardTimes = dashboard.querySelectorAll<HTMLTimeElement>('.approval-row time');
    expect([...dashboardTimes].map(({ textContent }) => textContent)).toEqual([
      expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/),
      expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/),
      '—',
    ]);
    expect(dashboardTimes[0]).toHaveAttribute('datetime', '2026-09-07T08:30:00.000Z');
    expect(dashboardTimes[1]).toHaveAttribute('datetime', '1970-01-01T00:00:00.000Z');
    expect(dashboardTimes[2]).not.toHaveAttribute('datetime');
    expect(dashboard).not.toHaveTextContent('2026-09-07T08:30:00.000Z');
    expect(dashboard).not.toHaveTextContent('unix:0');
    expect(dashboard).not.toHaveTextContent('日期未知');

    await user.click(screen.getByRole('button', { name: '查看全部' }));
    const board = await screen.findByRole('heading', { name: '审批中心' });
    const center = board.closest('.standard-page')!;
    const centerTimes = center.querySelectorAll<HTMLTimeElement>('.approval-row time');
    expect([...centerTimes].map(({ textContent }) => textContent)).toEqual(
      [...dashboardTimes].map(({ textContent }) => textContent),
    );
    expect(center).not.toHaveTextContent('2026-09-07T08:30:00.000Z');
    expect(center).not.toHaveTextContent('unix:0');
  });

  it('shows a ready persisted draft on a fresh dashboard launch', async () => {
    const fixture = collectionFixture({
      ...emptyCollections,
      approvals: [{
        id: 'ppt-review:project-review:details:v1', projectId: 'project-review',
        title: '真实审核项目', detail: '全部页面细化待审核', author: 'PPT 工作流', time: '刚刚',
      }],
    });

    render(<App adapter={fixture.adapter} initialRoute="dashboard" />);

    const activity = screen.getByRole('complementary', { name: '活动状态' });
    expect(await within(activity).findByText('全部页面细化待审核')).toBeInTheDocument();
    expect(within(activity).queryByText('当前没有待处理审批。')).not.toBeInTheDocument();
  });

  it('opens an implicit PPT approval in the existing guarded project review UI', async () => {
    const user = userEvent.setup();
    const fixture = collectionFixture({
      ...emptyCollections,
      approvals: [{
        id: 'ppt-review:project-review:details:v1', projectId: 'project-review',
        title: '真实审核项目', detail: '全部页面细化待审核', author: 'PPT 工作流', time: '刚刚',
      }],
    });
    fixture.adapter.loadProjectPipeline = vi.fn(async () => new Promise<never>(() => {}));

    render(<App adapter={fixture.adapter} initialRoute="approvals" />);
    await user.click(await screen.findByRole('link', { name: '前往审核' }));

    expect(window.location.hash).toBe('#/workspace/project-review');
    expect(fixture.adapter.loadProjectPipeline).toHaveBeenCalledWith('project-review');
    expect(screen.getByRole('heading', { name: '真实审核项目' })).toBeInTheDocument();
  });

  it('removes a completed review after returning from the guarded workspace to dashboard', async () => {
    const user = userEvent.setup();
    const pending: DesktopCollectionSnapshot = {
      ...emptyCollections,
      approvals: [{
        id: 'ppt-review:project-review:details:v1', projectId: 'project-review',
        title: '真实审核项目', detail: '全部页面细化待审核', author: 'PPT 工作流', time: '刚刚',
      }],
    };
    const fixture = collectionFixture(pending);
    let pipeline = detailReviewPipeline();
    fixture.adapter.loadProjectPipeline = vi.fn(async () => structuredClone(pipeline));
    fixture.adapter.approveDetails = vi.fn(async () => {
      pipeline = structuredClone(pipeline);
      pipeline.revision += 1;
      pipeline.project.workflowStatus = 'visual_review';
      pipeline.slideSpecs!.version.status = 'frozen';
      pipeline.slideSpecs!.version.frozenAt = '2026-09-07T03:00:00.000Z';
      pipeline.currentSlideId = 'slide-1';
      fixture.setCollections(emptyCollections);
      return structuredClone(pipeline);
    });

    render(<App adapter={fixture.adapter} initialRoute="approvals" />);
    await user.click(await screen.findByRole('link', { name: '前往审核' }));
    await user.click(await screen.findByRole('button', { name: '批准全部细化' }));
    expect(await screen.findByText('全部页面细化已批准并冻结。')).toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: '首页' }));

    const activity = screen.getByRole('complementary', { name: '活动状态' });
    expect(await within(activity).findByText('当前没有待处理审批。')).toBeInTheDocument();
    expect(within(activity).queryByText('全部页面细化待审核')).not.toBeInTheDocument();
  });

  it('refreshes an open dashboard when a persisted draft generation completes', async () => {
    const fixture = collectionFixture(emptyCollections);
    render(<App adapter={fixture.adapter} initialRoute="dashboard" />);
    const activity = screen.getByRole('complementary', { name: '活动状态' });
    expect(await within(activity).findByText('当前没有待处理审批。')).toBeInTheDocument();
    fixture.setCollections({
      ...emptyCollections,
      approvals: [{
        id: 'ppt-review:project-review:details:v2', projectId: 'project-review',
        title: '真实审核项目', detail: '全部页面细化待审核', author: 'PPT 工作流', time: '刚刚',
      }],
    });

    act(() => fixture.publishGeneration({
      projectId: 'project-review', operationId: 'generation-details-2', kind: 'details',
      status: 'completed', startedAt: '2026-09-07T04:00:00.000Z',
      updatedAt: '2026-09-07T04:01:00.000Z', error: null,
      pipeline: detailReviewPipeline(), result: null,
    }));

    expect(await within(activity).findByText('全部页面细化待审核')).toBeInTheDocument();
    expect(fixture.loadCollections).toHaveBeenCalledTimes(2);
  });

  it('reloads a saved proposal on memory route re-entry without replacing the live account', async () => {
    const user = userEvent.setup();
    const fixture = collectionFixture(emptyCollections);
    render(<App adapter={fixture.adapter} initialRoute="memory" />);

    expect(await screen.findByText('当前没有偏好记忆。')).toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: 'PPT 项目' }));
    fixture.setCollections({
      ...emptyCollections,
      memories: [{
        id: 'proposal-saved', title: '保存后的建议', content: '无需再次生成', status: '待决定',
      }],
    });
    await user.click(screen.getByRole('link', { name: '偏好记忆' }));

    expect(await screen.findByText('保存后的建议')).toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: '设置' }));
    expect(screen.getByText('live@example.com · pro')).toBeInTheDocument();
    expect(fixture.adapter.loadInitialState).toHaveBeenCalledTimes(1);
  });

  it('keeps the current task while collection routes refresh', async () => {
    const user = userEvent.setup();
    const fixture = collectionFixture(emptyCollections);
    render(<App adapter={fixture.adapter} initialRoute="tasks" />);
    await user.click(screen.getByRole('button', { name: /开始任务/ }));
    expect(await screen.findByText('等待你的批准')).toBeInTheDocument();

    await user.click(screen.getByRole('link', { name: '偏好记忆' }));
    expect(await screen.findByText('当前没有偏好记忆。')).toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: '通用任务' }));

    expect(screen.getByText('等待你的批准')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '批准继续' })).toBeInTheDocument();
  });

  it('refreshes an already-open memory route when proposal persistence completes', async () => {
    const fixture = collectionFixture(emptyCollections);
    render(<App adapter={fixture.adapter} initialRoute="memory" />);
    expect(await screen.findByText('当前没有偏好记忆。')).toBeInTheDocument();
    fixture.setCollections({
      ...emptyCollections,
      memories: [{
        id: 'proposal-live', title: '刚保存的建议', content: '持久化完成后立即显示', status: '待决定',
      }],
    });

    act(() => fixture.publishGeneration({
      projectId: 'project-review', operationId: 'generation-memory-1', kind: 'memory',
      status: 'completed', startedAt: '2026-09-07T04:00:00.000Z',
      updatedAt: '2026-09-07T04:01:00.000Z', error: null, pipeline: null,
      result: { status: '偏好建议已保存，等待决定。' },
    }));

    expect(await screen.findByText('刚保存的建议')).toBeInTheDocument();
    expect(fixture.loadCollections).toHaveBeenCalledTimes(2);
  });

  it('refreshes the persisted collection after a memory decision', async () => {
    const user = userEvent.setup();
    const fixture = collectionFixture({
      ...emptyCollections,
      memories: [{ id: 'proposal-1', title: '待决定建议', content: '内容', status: '待决定' }],
    });
    render(<App adapter={fixture.adapter} initialRoute="memory" />);
    await user.click(await screen.findByRole('button', { name: '批准偏好：待决定建议' }));

    await vi.waitFor(() => expect(fixture.loadCollections).toHaveBeenCalledTimes(2));
  });
});
