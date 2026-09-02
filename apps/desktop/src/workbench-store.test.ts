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
    state = workbenchReducer(state, {
      type: 'select-slide',
      projectId,
      slide: 5,
    });
    state = workbenchReducer(state, {
      type: 'slide-mutation-started',
      projectId,
      token: 1,
      kind: 'approve',
      slide: 5,
    });
    state = workbenchReducer(state, {
      type: 'slide-mutation-resolved',
      projectId,
      token: 1,
      result: {
        status: '第 5 页已批准，进入可编辑转换。',
        nextSlide: 6,
        stage: 'conversion',
        exportReady: true,
      },
    });

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
});
