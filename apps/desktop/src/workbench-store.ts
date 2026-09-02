import type {
  AccountSummary,
  ApprovalResult,
  ApprovalSummary,
  DesktopInitialState,
  MemorySummary,
  ProjectSummary,
  RegenerateResult,
  RuntimeSummary,
} from './desktop-adapter.js';

export type WorkflowStage =
  | 'intake'
  | 'analysis'
  | 'outline'
  | 'detail'
  | 'visual'
  | 'conversion'
  | 'qa';
export type SlideStatus = 'approved' | 'waiting' | 'pending';

export interface WorkbenchProject extends ProjectSummary {
  workflowStage: WorkflowStage;
  selectedSlide: number;
  slides: Array<{ page: number; status: SlideStatus }>;
  exportReady: boolean;
  slideNotice: string;
  pendingMutation: {
    token: number;
    kind: 'approve' | 'regenerate' | 'reopen';
    slide: number;
  } | null;
}

export interface WorkbenchMemory extends MemorySummary {
  pendingToken: number | null;
}

export interface WorkbenchState {
  account: AccountSummary;
  runtime: RuntimeSummary;
  projects: WorkbenchProject[];
  selectedProjectId: string | null;
  approvals: ApprovalSummary[];
  pendingApprovals: Record<string, number>;
  memories: WorkbenchMemory[];
}

type SlideMutationResult = RegenerateResult | ApprovalResult | { status: string };

export type WorkbenchAction =
  | { type: 'account-updated'; account: AccountSummary }
  | { type: 'project-selected'; projectId: string }
  | { type: 'project-created'; project: ProjectSummary }
  | { type: 'project-renamed'; projectId: string; name: string }
  | { type: 'select-slide'; projectId: string; slide: number }
  | {
      type: 'slide-mutation-started';
      projectId: string;
      token: number;
      kind: 'approve' | 'regenerate' | 'reopen';
      slide: number;
    }
  | {
      type: 'slide-mutation-resolved';
      projectId: string;
      token: number;
      result: SlideMutationResult;
    }
  | {
      type: 'slide-mutation-failed';
      projectId: string;
      token: number;
      status: string;
    }
  | { type: 'reopen-slide'; projectId: string; slide: number; status: string }
  | { type: 'approval-mutation-started'; approvalId: string; token: number }
  | {
      type: 'approval-mutation-resolved';
      approvalId: string;
      token: number;
    }
  | { type: 'approval-mutation-failed'; approvalId: string; token: number }
  | { type: 'memory-mutation-started'; memoryId: string; token: number }
  | {
      type: 'memory-mutation-resolved';
      memoryId: string;
      token: number;
      status: string;
    }
  | { type: 'memory-mutation-failed'; memoryId: string; token: number };

export function createWorkbenchState(initial: DesktopInitialState): WorkbenchState {
  return {
    account: structuredClone(initial.account),
    runtime: structuredClone(initial.runtime),
    projects: initial.projects.map(toWorkbenchProject),
    selectedProjectId: initial.projects[0]?.id ?? null,
    approvals: structuredClone(initial.approvals),
    pendingApprovals: {},
    memories: initial.memories.map((memory) => ({
      ...structuredClone(memory),
      pendingToken: null,
    })),
  };
}

export function workbenchReducer(
  state: WorkbenchState,
  action: WorkbenchAction,
): WorkbenchState {
  switch (action.type) {
    case 'account-updated':
      return { ...state, account: action.account };
    case 'project-selected':
      return state.projects.some((project) => project.id === action.projectId)
        ? { ...state, selectedProjectId: action.projectId }
        : state;
    case 'project-created': {
      const project = toWorkbenchProject(action.project);
      return {
        ...state,
        projects: [project, ...state.projects],
        selectedProjectId: project.id,
      };
    }
    case 'project-renamed':
      return updateProject(state, action.projectId, (project) => ({
        ...project,
        name: action.name,
        updatedAt: '刚刚',
      }));
    case 'select-slide':
      return updateProject(state, action.projectId, (project) => ({
        ...project,
        selectedSlide: clampSlide(action.slide),
      }));
    case 'slide-mutation-started':
      return updateProject(state, action.projectId, (project) => ({
        ...project,
        pendingMutation: {
          token: action.token,
          kind: action.kind,
          slide: clampSlide(action.slide),
        },
      }));
    case 'slide-mutation-resolved':
      return updateProject(state, action.projectId, (project) => {
        const pending = project.pendingMutation;
        if (pending?.token !== action.token) return project;
        if (pending.kind === 'regenerate') {
          return {
            ...project,
            selectedSlide: clampSlide(
              'selectedSlide' in action.result
                ? action.result.selectedSlide
                : pending.slide,
            ),
            slideNotice: action.result.status,
            pendingMutation: null,
          };
        }
        if (pending.kind === 'reopen') {
          return reopenProject(project, pending.slide, action.result.status);
        }
        const page = pending.slide;
        const isLast = page === 5;
        const slides = project.slides.map((slide) => {
          if (slide.page <= page) return { ...slide, status: 'approved' as const };
          if (!isLast && slide.page === page + 1)
            return { ...slide, status: 'waiting' as const };
          return { ...slide, status: 'pending' as const };
        });
        return {
          ...project,
          slides,
          selectedSlide: isLast ? 5 : page + 1,
          workflowStage: isLast ? 'conversion' : 'visual',
          stage: isLast ? '可编辑转换' : '视觉审批',
          progress: isLast ? Math.max(project.progress, 78) : project.progress,
          exportReady:
            isLast ||
            ('exportReady' in action.result && action.result.exportReady === true),
          slideNotice: action.result.status,
          pendingMutation: null,
        };
      });
    case 'slide-mutation-failed':
      return updateProject(state, action.projectId, (project) =>
        project.pendingMutation?.token === action.token
          ? { ...project, slideNotice: action.status, pendingMutation: null }
          : project,
      );
    case 'reopen-slide':
      return updateProject(state, action.projectId, (project) =>
        reopenProject(project, action.slide, action.status),
      );
    case 'approval-mutation-started':
      return {
        ...state,
        pendingApprovals: {
          ...state.pendingApprovals,
          [action.approvalId]: action.token,
        },
      };
    case 'approval-mutation-resolved': {
      if (state.pendingApprovals[action.approvalId] !== action.token) return state;
      const pendingApprovals = { ...state.pendingApprovals };
      delete pendingApprovals[action.approvalId];
      return {
        ...state,
        approvals: state.approvals.filter((item) => item.id !== action.approvalId),
        pendingApprovals,
      };
    }
    case 'approval-mutation-failed': {
      if (state.pendingApprovals[action.approvalId] !== action.token) return state;
      const pendingApprovals = { ...state.pendingApprovals };
      delete pendingApprovals[action.approvalId];
      return { ...state, pendingApprovals };
    }
    case 'memory-mutation-started':
      return {
        ...state,
        memories: state.memories.map((memory) =>
          memory.id === action.memoryId
            ? { ...memory, pendingToken: action.token }
            : memory,
        ),
      };
    case 'memory-mutation-resolved':
      return {
        ...state,
        memories: state.memories.map((memory) =>
          memory.id === action.memoryId && memory.pendingToken === action.token
            ? { ...memory, status: action.status, pendingToken: null }
            : memory,
        ),
      };
    case 'memory-mutation-failed':
      return {
        ...state,
        memories: state.memories.map((memory) =>
          memory.id === action.memoryId && memory.pendingToken === action.token
            ? { ...memory, pendingToken: null }
            : memory,
        ),
      };
  }
}

function updateProject(
  state: WorkbenchState,
  projectId: string,
  update: (project: WorkbenchProject) => WorkbenchProject,
): WorkbenchState {
  return {
    ...state,
    projects: state.projects.map((project) =>
      project.id === projectId ? update(project) : project,
    ),
  };
}

function toWorkbenchProject(project: ProjectSummary): WorkbenchProject {
  const visual = project.stage === '视觉审批';
  return {
    ...structuredClone(project),
    workflowStage: stageId(project.stage),
    selectedSlide: visual ? 3 : 1,
    slides: Array.from({ length: 5 }, (_, index) => ({
      page: index + 1,
      status: visual
        ? index < 2
          ? 'approved'
          : index === 2
            ? 'waiting'
            : 'pending'
        : index === 0
          ? 'waiting'
          : 'pending',
    })),
    exportReady: false,
    slideNotice: visual ? '等待审批' : '等待材料处理',
    pendingMutation: null,
  };
}

function stageId(stage: string): WorkflowStage {
  const mapping: Record<string, WorkflowStage> = {
    材料: 'intake',
    材料分析: 'analysis',
    大纲审批: 'outline',
    逐页细化: 'detail',
    内容生成: 'detail',
    视觉审批: 'visual',
    可编辑转换: 'conversion',
    质量检查: 'qa',
  };
  return mapping[stage] ?? 'intake';
}

function clampSlide(slide: number): number {
  return Math.max(1, Math.min(5, Math.trunc(slide)));
}

function reopenProject(
  project: WorkbenchProject,
  slide: number,
  status: string,
): WorkbenchProject {
  const page = clampSlide(slide);
  return {
    ...project,
    selectedSlide: page,
    workflowStage: 'visual',
    stage: '视觉审批',
    exportReady: false,
    slideNotice: status,
    pendingMutation: null,
    slides: project.slides.map((item) => ({
      ...item,
      status:
        item.page < page
          ? 'approved'
          : item.page === page
            ? 'waiting'
            : 'pending',
    })),
  };
}
