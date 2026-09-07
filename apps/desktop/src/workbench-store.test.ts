import { describe, expect, it } from 'vitest';
import { createDemoDesktopAdapter } from './desktop-adapter.js';
import { createWorkbenchState, workbenchReducer } from './workbench-store.js';

function demoState() {
  return createWorkbenchState(createDemoDesktopAdapter().initialState);
}

describe('single workbench project and slide store', () => {
  it('approves page five without creating page six and enters conversion', () => {
    let state = demoState();
    const projectId = state.selectedProjectId!;
    for (const page of [3, 4, 5]) {
      state = workbenchReducer(state, {
        type: 'slide-mutation-started',
        projectId,
        token: page,
        kind: 'approve',
        slide: page,
      });
      state = workbenchReducer(state, {
        type: 'slide-mutation-resolved',
        projectId,
        token: page,
        result: {
          status:
            page === 5
              ? '第 5 页已批准，进入可编辑转换。'
              : `已批准，进入第 ${page + 1} 页`,
          nextSlide: page + 1,
          stage: page === 5 ? 'conversion' : undefined,
          exportReady: page === 5,
        },
      });
    }

    const project = state.projects.find((item) => item.id === projectId)!;
    expect(project.selectedSlide).toBe(5);
    expect(project.slides).toHaveLength(5);
    expect(project.slides[4]?.status).toBe('approved');
    expect(project.workflowStage).toBe('conversion');
    expect(project.exportReady).toBe(true);
  });

  it('reopening an earlier page clears impossible later completion', () => {
    let state = demoState();
    const projectId = state.selectedProjectId!;
    state = workbenchReducer(state, {
      type: 'reopen-slide',
      projectId,
      slide: 2,
      status: '第 2 页已重新打开，等待修改。',
    });

    const project = state.projects.find((item) => item.id === projectId)!;
    expect(project.workflowStage).toBe('visual');
    expect(project.exportReady).toBe(false);
    expect(project.slides.map((slide) => slide.status)).toEqual([
      'approved',
      'waiting',
      'pending',
      'pending',
      'pending',
    ]);
  });

  it('rejects reopening a pending future page without changing any status', () => {
    let state = demoState();
    const projectId = state.selectedProjectId!;
    const before = state.projects[0]!;
    state = workbenchReducer(state, {
      type: 'slide-mutation-started',
      projectId,
      token: 30,
      kind: 'reopen',
      slide: 5,
    });
    state = workbenchReducer(state, {
      type: 'slide-mutation-resolved',
      projectId,
      token: 30,
      result: { status: '不应生效' },
    });

    expect(state.projects[0]).toEqual(before);
  });

  it('never infers prior approvals while reopening or approving', () => {
    let state = demoState();
    const projectId = state.selectedProjectId!;
    state = {
      ...state,
      projects: state.projects.map((project) =>
        project.id === projectId
          ? {
              ...project,
              selectedSlide: 2,
              slides: project.slides.map((slide) => ({
                ...slide,
                status:
                  slide.page === 2
                    ? ('approved' as const)
                    : ('pending' as const),
              })),
            }
          : project,
      ),
    };
    state = workbenchReducer(state, {
      type: 'reopen-slide',
      projectId,
      slide: 2,
      status: '重新打开',
    });
    expect(state.projects[0]?.slides.map((slide) => slide.status)).toEqual([
      'pending',
      'waiting',
      'pending',
      'pending',
      'pending',
    ]);

    const beforeSkip = state.projects[0]!;
    state = workbenchReducer(state, {
      type: 'slide-mutation-started',
      projectId,
      token: 31,
      kind: 'approve',
      slide: 4,
    });
    state = workbenchReducer(state, {
      type: 'slide-mutation-resolved',
      projectId,
      token: 31,
      result: { status: '跳页', nextSlide: 5 },
    });
    expect(state.projects[0]).toEqual(beforeSkip);
  });

  it('ignores stale PPT and memory mutation responses', () => {
    let state = demoState();
    const projectId = state.selectedProjectId!;
    state = workbenchReducer(state, {
      type: 'slide-mutation-started',
      projectId,
      token: 10,
      kind: 'regenerate',
      slide: 3,
    });
    state = workbenchReducer(state, {
      type: 'slide-mutation-started',
      projectId,
      token: 11,
      kind: 'regenerate',
      slide: 3,
    });
    state = workbenchReducer(state, {
      type: 'slide-mutation-resolved',
      projectId,
      token: 10,
      result: { status: '过期结果', selectedSlide: 3 },
    });
    expect(state.projects[0]?.slideNotice).not.toBe('过期结果');

    state = workbenchReducer(state, {
      type: 'memory-mutation-started',
      memoryId: 'memory-chart',
      token: 20,
    });
    state = workbenchReducer(state, {
      type: 'memory-mutation-started',
      memoryId: 'memory-chart',
      token: 21,
    });
    state = workbenchReducer(state, {
      type: 'memory-mutation-resolved',
      memoryId: 'memory-chart',
      token: 20,
      status: '已拒绝',
    });
    expect(state.memories[0]?.status).toBe('待决定');
  });

  it('keeps project goal and selects the requested project id', () => {
    let state = demoState();
    state = workbenchReducer(state, {
      type: 'project-created',
      project: {
        id: 'ppt-new',
        name: '新品计划',
        goal: '给渠道伙伴解释上市节奏',
        stage: '材料',
        progress: 10,
        updatedAt: '刚刚',
      },
    });
    expect(state.selectedProjectId).toBe('ppt-new');
    expect(state.projects.find((item) => item.id === 'ppt-new')?.goal).toBe(
      '给渠道伙伴解释上市节奏',
    );

    state = workbenchReducer(state, {
      type: 'project-selected',
      projectId: 'ppt-demo-002',
    });
    expect(state.selectedProjectId).toBe('ppt-demo-002');
  });

  it('refreshes persisted collections without replacing live account or task-adjacent state', () => {
    const state = demoState();
    const live = {
      ...state,
      account: { email: 'live@example.com', plan: 'pro', status: 'connected' as const },
      runtime: { ...state.runtime, detail: 'live app server', queue: 2 },
      settings: { ...state.settings, workspacePath: '/live/workspace' },
      selectedProjectId: 'ppt-demo-002',
      pendingApprovals: { 'approval-live': 91 },
    };

    const refreshed = workbenchReducer(live, {
      type: 'collections-loaded',
      collections: {
        approvals: [{
          id: 'ppt-review:project-live:details:v1', projectId: 'project-live',
          title: '新审批', detail: '全部页面细化待审核', author: 'PPT 工作流', time: '刚刚',
        }],
        memories: [{ id: 'memory-new', title: '新偏好', content: '保存后的建议', status: '待决定' }],
        availability: { approvals: 'loaded', memories: 'loaded' },
      },
    });

    expect(refreshed.account).toEqual(live.account);
    expect(refreshed.runtime).toEqual(live.runtime);
    expect(refreshed.projects).toEqual(live.projects);
    expect(refreshed.selectedProjectId).toBe('ppt-demo-002');
    expect(refreshed.pendingApprovals).toEqual({ 'approval-live': 91 });
    expect(refreshed.settings).toEqual(live.settings);
    expect(refreshed.approvals.map(({ id }) => id)).toEqual([
      'ppt-review:project-live:details:v1',
    ]);
    expect(refreshed.memories[0]).toMatchObject({
      id: 'memory-new', status: '待决定', pendingToken: null,
    });
  });
});
