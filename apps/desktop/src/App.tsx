import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import {
  createDesktopAdapter,
  type DesktopAdapter,
  type ProjectSummary,
  type TaskSummary,
} from './desktop-adapter.js';
import './styles.css';

type Route =
  | 'dashboard'
  | 'tasks'
  | 'projects'
  | 'workspace'
  | 'approvals'
  | 'memory'
  | 'settings';
type Notice = { kind: 'status' | 'error'; text: string } | null;

const navItems: Array<{
  route: Exclude<Route, 'workspace'>;
  label: string;
  icon: IconName;
}> = [
  { route: 'dashboard', label: '首页', icon: 'home' },
  { route: 'tasks', label: '通用任务', icon: 'layers' },
  { route: 'projects', label: 'PPT 项目', icon: 'file' },
  { route: 'approvals', label: '审批中心', icon: 'checkSquare' },
  { route: 'memory', label: '偏好记忆', icon: 'brain' },
  { route: 'settings', label: '设置', icon: 'settings' },
];

const workspaceStages = [
  ['intake', '材料'],
  ['analysis', '材料分析'],
  ['outline', '大纲审批'],
  ['detail', '逐页细化'],
  ['visual', '视觉审批'],
  ['conversion', '可编辑转换'],
  ['qa', '质量检查'],
] as const;

const recentWork = [
  {
    icon: 'sparkle' as const,
    name: '市场调研分析报告',
    subtitle: '生成 2024 年智能硬件行业市场调研分析',
    type: '通用任务',
    stage: '生成结果',
    status: '进行中',
    progress: 65,
    updatedAt: '今天 09:18',
  },
  {
    icon: 'file' as const,
    name: '智能家居产品发布会',
    subtitle: '新品发布会演示文稿',
    type: 'PPT 项目',
    stage: '内容生成',
    status: '进行中',
    progress: 42,
    updatedAt: '昨天 16:43',
  },
  {
    icon: 'file' as const,
    name: '年度工作总结汇报',
    subtitle: '2024 年度工作总结与 2025 年计划',
    type: 'PPT 项目',
    stage: '设计排版',
    status: '排版中',
    progress: 78,
    updatedAt: '昨天 11:07',
  },
];

const approvalItems = [
  {
    id: 'approval-1',
    title: '智能家居产品发布会',
    detail: '内容大纲待审批',
    author: '张三',
    time: '10 分钟前',
  },
  {
    id: 'approval-2',
    title: '年度工作总结汇报',
    detail: '最终稿待审批',
    author: '李四',
    time: '2 小时前',
  },
  {
    id: 'approval-3',
    title: '市场推广方案',
    detail: '内容修改待审批',
    author: '王五',
    time: '昨天 18:32',
  },
];

const defaultProject: ProjectSummary = {
  id: 'ppt-demo-001',
  name: '年度经营复盘与增长计划',
  stage: '视觉审批',
  progress: 60,
  updatedAt: '今天 14:29',
};

export function App({
  adapter = createDesktopAdapter(),
  initialRoute,
}: {
  adapter?: DesktopAdapter;
  initialRoute?: Route;
}) {
  const [route, setRoute] = useState<Route>(
    () => initialRoute ?? routeFromHash() ?? 'dashboard',
  );
  const [project, setProject] = useState<ProjectSummary>(defaultProject);
  const [task, setTask] = useState<TaskSummary | null>(null);
  const [notice, setNotice] = useState<Notice>(null);

  useEffect(() => {
    const onPopState = () => setRoute(routeFromHash() ?? 'dashboard');
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const navigate = (next: Route) => {
    setNotice(null);
    setRoute(next);
    window.history.pushState({ route: next }, '', `#/${next}`);
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  };

  const report = async (
    action: () => Promise<{ status?: string; message?: string }>,
  ) => {
    setNotice(null);
    try {
      const result = await action();
      const text = result.status ?? result.message;
      if (text) setNotice({ kind: 'status', text });
    } catch (error) {
      setNotice({ kind: 'error', text: toMessage(error) });
    }
  };

  const page =
    route === 'workspace' ? (
      <div className="workspace-app">
        <Sidebar adapter={adapter} route="projects" navigate={navigate} />
        <WorkspacePage
          adapter={adapter}
          project={project}
          navigate={navigate}
          report={report}
        />
      </div>
    ) : (
      <AppShell adapter={adapter} route={route} navigate={navigate}>
        {route === 'dashboard' && <DashboardPage navigate={navigate} />}
        {route === 'tasks' && (
          <TasksPage
            adapter={adapter}
            task={task}
            setTask={setTask}
            report={report}
          />
        )}
        {route === 'projects' && (
          <ProjectsPage
            adapter={adapter}
            project={project}
            setProject={setProject}
            navigate={navigate}
            report={report}
          />
        )}
        {route === 'approvals' && <ApprovalsPage report={report} />}
        {route === 'memory' && <MemoryPage adapter={adapter} report={report} />}
        {route === 'settings' && (
          <SettingsPage adapter={adapter} report={report} />
        )}
      </AppShell>
    );

  return (
    <>
      <a className="skip-link" href="#main-content">
        跳到主要内容
      </a>
      <div className="desktop-window">
        {page}
        {notice && (
          <div
            className={`app-notice ${notice.kind === 'error' ? 'is-error' : ''}`}
            role={notice.kind === 'error' ? 'alert' : 'status'}
            aria-live="polite"
          >
            {notice.text}
          </div>
        )}
      </div>
    </>
  );
}

function AppShell({
  adapter,
  route,
  navigate,
  children,
}: {
  adapter: DesktopAdapter;
  route: Route;
  navigate: (route: Route) => void;
  children: ReactNode;
}) {
  return (
    <div className="app-shell">
      <Sidebar adapter={adapter} route={route} navigate={navigate} />
      <main id="main-content" className="app-main">
        {children}
      </main>
    </div>
  );
}

function Sidebar({
  adapter,
  route,
  navigate,
}: {
  adapter: DesktopAdapter;
  route: Route;
  navigate: (route: Route) => void;
}) {
  return (
    <aside className="primary-sidebar" aria-label="主导航">
      <div className="mac-controls" aria-hidden="true">
        <i />
        <i />
        <i />
      </div>
      <div className="brand">
        <span className="brand-mark">
          <Icon name="logo" />
        </span>
        <span>分身工作台</span>
      </div>
      <nav className="primary-nav" aria-label="工作台页面">
        {navItems.map((item) => (
          <a
            href={`#/${item.route}`}
            key={item.route}
            className={route === item.route ? 'is-active' : ''}
            aria-label={item.label}
            aria-current={route === item.route ? 'page' : undefined}
            onClick={(event) => {
              event.preventDefault();
              navigate(item.route);
            }}
          >
            <Icon name={item.icon} />
            <span>{item.label}</span>
          </a>
        ))}
      </nav>
      <div className="sidebar-bottom">
        <span className="connection-dot" aria-hidden="true" />
        <span>{adapter.mode === 'demo' ? '演示数据' : '本地服务'}</span>
      </div>
    </aside>
  );
}

function DashboardPage({ navigate }: { navigate: (route: Route) => void }) {
  return (
    <div className="dashboard-layout">
      <section className="dashboard-content">
        <header className="dashboard-hero">
          <h1>早上好，今天从哪里开始？</h1>
          <button
            className="button button-primary"
            onClick={() => navigate('tasks')}
          >
            <Icon name="plus" />
            新建 AI 任务
          </button>
        </header>
        <section
          className="page-section quick-starts"
          aria-labelledby="quick-start-heading"
        >
          <h2 id="quick-start-heading">快速开始</h2>
          <button className="quick-row" onClick={() => navigate('tasks')}>
            <span className="quick-icon">
              <Icon name="sparkle" />
            </span>
            <span>
              <strong>新建 AI 任务</strong>
              <small>从空白开始，让 Codex 帮你完成各类通用任务</small>
            </span>
            <Icon name="arrowRight" />
          </button>
          <button className="quick-row" onClick={() => navigate('projects')}>
            <span className="quick-icon">
              <Icon name="file" />
            </span>
            <span>
              <strong>创建 PPT 项目</strong>
              <small>智能生成结构化演示文稿，支持模板与内容生成</small>
            </span>
            <Icon name="arrowRight" />
          </button>
        </section>
        <section
          className="page-section recent-section"
          aria-labelledby="recent-heading"
        >
          <h2 id="recent-heading">最近工作</h2>
          <div className="work-table" role="table" aria-label="最近工作">
            <div className="work-head" role="row">
              <span>名称</span>
              <span>类型</span>
              <span>当前阶段</span>
              <span>状态</span>
              <span>进度</span>
              <span>更新时间</span>
            </div>
            {recentWork.map((item) => (
              <div className="work-row" role="row" key={item.name}>
                <div className="work-name">
                  <span className={`work-icon ${item.icon}`}>
                    <Icon name={item.icon} />
                  </span>
                  <span>
                    <strong>{item.name}</strong>
                    <small>{item.subtitle}</small>
                  </span>
                </div>
                <span>{item.type}</span>
                <span>{item.stage}</span>
                <span className="text-accent">{item.status}</span>
                <span className="progress-cell">
                  <Progress value={item.progress} />
                  <em>{item.progress}%</em>
                </span>
                <span>{item.updatedAt}</span>
              </div>
            ))}
          </div>
          <button
            className="text-action center-action"
            onClick={() => navigate('projects')}
          >
            查看全部工作 <Icon name="arrowRight" />
          </button>
        </section>
      </section>
      <DashboardAside navigate={navigate} />
    </div>
  );
}

function DashboardAside({ navigate }: { navigate: (route: Route) => void }) {
  return (
    <aside className="dashboard-aside" aria-label="活动状态">
      <section aria-labelledby="pending-heading">
        <div className="section-heading">
          <h2 id="pending-heading">待处理审批</h2>
          <button className="text-action" onClick={() => navigate('approvals')}>
            查看全部
          </button>
        </div>
        <div className="pending-list">
          {approvalItems.map((item) => (
            <ApprovalRow key={item.id} item={item} />
          ))}
        </div>
      </section>
      <section className="codex-status" aria-labelledby="codex-heading">
        <h2 id="codex-heading">Codex 连接状态</h2>
        <p className="connected">
          <span className="connection-dot" />
          已连接
        </p>
        <p className="muted">Codex 本地服务运行中</p>
        <button className="text-action" onClick={() => navigate('settings')}>
          查看详情
        </button>
        <dl>
          <div>
            <dt>
              <Icon name="cube" />
              模型
            </dt>
            <dd>codex-1.0-local</dd>
          </div>
          <div>
            <dt>
              <Icon name="monitor" />
              服务地址
            </dt>
            <dd>http://127.0.0.1:8080</dd>
          </div>
          <div>
            <dt>
              <Icon name="clock" />
              运行时间
            </dt>
            <dd>2 天 4 小时</dd>
          </div>
          <div>
            <dt>
              <Icon name="queue" />
              队列任务
            </dt>
            <dd>2</dd>
          </div>
        </dl>
        <button
          className="button button-secondary full-width"
          onClick={() => navigate('settings')}
        >
          连接设置
        </button>
      </section>
    </aside>
  );
}

function ApprovalRow({ item }: { item: (typeof approvalItems)[number] }) {
  return (
    <div className="approval-row">
      <Icon name="file" />
      <div>
        <strong>{item.title}</strong>
        <span>{item.detail}</span>
        <small>发起人：{item.author}</small>
      </div>
      <time>{item.time}</time>
    </div>
  );
}

function TasksPage({
  adapter,
  task,
  setTask,
  report,
}: {
  adapter: DesktopAdapter;
  task: TaskSummary | null;
  setTask: (task: TaskSummary) => void;
  report: (
    action: () => Promise<{ status?: string; message?: string }>,
  ) => Promise<void>;
}) {
  const [prompt, setPrompt] = useState(
    '请整理本周产品评审的结论，并输出行动清单。',
  );
  const [account, setAccount] = useState('未检测');
  const [isStarting, setIsStarting] = useState(false);

  const start = async (event: FormEvent) => {
    event.preventDefault();
    if (!prompt.trim()) return;
    setIsStarting(true);
    try {
      const next = await adapter.startTask(prompt.trim());
      setTask(next);
    } catch (error) {
      await report(async () => {
        throw error;
      });
    } finally {
      setIsStarting(false);
    }
  };
  const connect = async () => {
    try {
      const next = await adapter.connectAccount();
      setAccount(
        next.status === 'connected'
          ? `${next.email ?? '已连接'} · ${next.plan ?? 'ChatGPT'}`
          : '尚未登录',
      );
    } catch (error) {
      await report(async () => {
        throw error;
      });
    }
  };
  const respond = async (decision: 'approve' | 'decline') => {
    if (!task) return;
    try {
      const result = await adapter.respondToTask(decision);
      setTask({
        ...task,
        status: decision === 'approve' ? 'running' : 'failed',
        transcript: [
          ...task.transcript,
          { role: 'assistant', text: result.status },
        ],
      });
      await report(async () => result);
    } catch (error) {
      await report(async () => {
        throw error;
      });
    }
  };

  return (
    <div className="standard-page task-page">
      <PageHeader
        title="通用任务"
        description="连接本地 Codex App Server，创建并跟踪通用 AI 任务。"
      />
      <div className="task-grid">
        <section className="task-composer">
          <h2>新建 AI 任务</h2>
          <form onSubmit={start}>
            <label htmlFor="task-prompt">任务说明</label>
            <textarea
              id="task-prompt"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              rows={5}
            />
            <div className="form-actions">
              <span className="muted">工作目录：当前项目</span>
              <button
                className="button button-primary"
                disabled={isStarting || !prompt.trim()}
              >
                {isStarting ? '正在创建…' : '开始任务'}
                <Icon name="arrowRight" />
              </button>
            </div>
          </form>
        </section>
        <aside className="connection-panel">
          <h2>Codex 账户</h2>
          <p className="connected">
            <span className="connection-dot" />
            {account}
          </p>
          <button
            className="button button-secondary"
            onClick={() => void connect()}
          >
            检查连接
          </button>
          <button
            className="text-action"
            onClick={() => void report(() => adapter.startLogin())}
          >
            登录或重新登录
          </button>
        </aside>
      </div>
      {task ? (
        <section className="task-run" aria-labelledby="task-run-heading">
          <div className="section-heading">
            <div>
              <h2 id="task-run-heading">任务进行中</h2>
              <p className="muted">
                {task.status === 'waiting_for_approval'
                  ? '等待你的批准'
                  : task.status === 'failed'
                    ? '任务已停止'
                    : 'Codex 正在处理'}
              </p>
            </div>
            <span className="status-label">
              {task.status.replaceAll('_', ' ')}
            </span>
          </div>
          <div className="transcript" aria-live="polite">
            {task.transcript.map((entry, index) => (
              <p
                className={`transcript-${entry.role}`}
                key={`${entry.role}-${index}`}
              >
                <span>{entry.role === 'user' ? '你' : 'Codex'}</span>
                {entry.text}
              </p>
            ))}
          </div>
          <div className="task-footer">
            <span>
              <Icon name="clock" />
              使用量 {task.usage}
            </span>
            {task.status === 'waiting_for_approval' && (
              <div>
                <button
                  className="button button-secondary"
                  onClick={() => void respond('decline')}
                >
                  拒绝
                </button>
                <button
                  className="button button-primary"
                  onClick={() => void respond('approve')}
                >
                  批准继续
                </button>
              </div>
            )}
          </div>
        </section>
      ) : (
        <section className="empty-state">
          <Icon name="sparkle" />
          <h2>任务结果会显示在这里</h2>
          <p>
            启动任务后，可查看流式对话、批准请求、用户输入、用量和错误状态。
          </p>
        </section>
      )}
    </div>
  );
}

function ProjectsPage({
  adapter,
  project,
  setProject,
  navigate,
  report,
}: {
  adapter: DesktopAdapter;
  project: ProjectSummary;
  setProject: (project: ProjectSummary) => void;
  navigate: (route: Route) => void;
  report: (
    action: () => Promise<{ status?: string; message?: string }>,
  ) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    setIsCreating(true);
    try {
      const created = await adapter.createProject(name.trim());
      setProject(created);
      navigate('workspace');
    } catch (error) {
      await report(async () => {
        throw error;
      });
    } finally {
      setIsCreating(false);
    }
  };
  return (
    <div className="standard-page projects-page">
      <PageHeader
        title="PPT 项目"
        description="从材料、结构到视觉审批，在一个可追踪的项目流中完成演示文稿。"
      />
      <div className="projects-grid">
        <section className="project-list">
          <div className="section-heading">
            <h2>项目列表</h2>
            <span className="muted">2 个进行中</span>
          </div>
          <button className="project-row" onClick={() => navigate('workspace')}>
            <span className="file-avatar">
              <Icon name="file" />
            </span>
            <span>
              <strong>{project.name}</strong>
              <small>
                {project.stage} · 更新于 {project.updatedAt}
              </small>
            </span>
            <span className="project-progress">
              <Progress value={project.progress} />
              {project.progress}%
            </span>
            <Icon name="arrowRight" />
          </button>
          <button className="project-row" onClick={() => navigate('workspace')}>
            <span className="file-avatar">
              <Icon name="file" />
            </span>
            <span>
              <strong>智能家居产品发布会</strong>
              <small>内容生成 · 更新于 昨天 16:43</small>
            </span>
            <span className="project-progress">
              <Progress value={42} />
              42%
            </span>
            <Icon name="arrowRight" />
          </button>
        </section>
        <section className="project-create">
          <h2>创建 PPT 项目</h2>
          <form onSubmit={create}>
            <label htmlFor="project-name">项目名称</label>
            <input
              id="project-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="例如：Q4 产品发布会"
            />
            <label htmlFor="project-goal">项目目标</label>
            <textarea
              id="project-goal"
              placeholder="说明受众、场景与希望传达的信息"
              rows={4}
            />
            <button
              className="button button-primary full-width"
              disabled={isCreating || !name.trim()}
            >
              {isCreating ? '正在创建…' : '创建并进入工作台'}
              <Icon name="arrowRight" />
            </button>
          </form>
        </section>
      </div>
    </div>
  );
}

function WorkspacePage({
  adapter,
  project,
  navigate,
  report,
}: {
  adapter: DesktopAdapter;
  project: ProjectSummary;
  navigate: (route: Route) => void;
  report: (
    action: () => Promise<{ status?: string; message?: string }>,
  ) => Promise<void>;
}) {
  const [selectedSlide, setSelectedSlide] = useState(3);
  const [comment, setComment] = useState('');
  const [slideStatus, setSlideStatus] = useState('等待审批');
  const [stage, setStage] = useState('visual');
  const [mobilePanel, setMobilePanel] = useState<
    'workflow' | 'canvas' | 'review'
  >('canvas');
  const action = async (
    operation: () => Promise<{
      status: string;
      selectedSlide?: number;
      nextSlide?: number;
    }>,
  ) => {
    try {
      const result = await operation();
      setSlideStatus(result.status);
      if (result.selectedSlide) setSelectedSlide(result.selectedSlide);
      if (result.nextSlide) setSelectedSlide(result.nextSlide);
    } catch (error) {
      await report(async () => {
        throw error;
      });
    }
  };
  const currentSlide = Math.min(selectedSlide, 5);
  return (
    <div className="workspace-shell">
      <header className="workspace-header">
        <div>
          <button
            className="icon-button"
            aria-label="返回 PPT 项目"
            onClick={() => navigate('projects')}
          >
            <Icon name="arrowLeft" />
          </button>
          <nav aria-label="面包屑">
            <button onClick={() => navigate('projects')}>PPT 项目</button>
            <span>/</span>
            <strong>{project.name}</strong>
          </nav>
          <h1>
            {project.name}{' '}
            <button
              className="edit-title"
              aria-label="编辑项目名称"
              onClick={() => setSlideStatus('项目名称编辑将在本地版本中保存。')}
            >
              <Icon name="edit" />
            </button>
          </h1>
          <p>
            创建时间：2025-05-12 10:23 <span /> 最后更新：2025-05-16 14:32
          </p>
        </div>
        <div className="workspace-actions">
          <span>
            项目状态：<strong className="text-accent">进行中</strong>
          </span>
          <button
            className="button button-secondary"
            onClick={() =>
              void report(() => adapter.exportProject(project.id, project.name))
            }
          >
            <Icon name="export" />
            导出
          </button>
        </div>
      </header>
      <div
        className="mobile-panel-tabs"
        role="tablist"
        aria-label="紧凑工作台面板"
      >
        {(
          [
            ['workflow', '工作流'],
            ['canvas', '幻灯片画布'],
            ['review', '审批面板'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={mobilePanel === id}
            aria-controls={`${id}-panel`}
            onClick={() => setMobilePanel(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className={`workspace-layout mobile-panel-${mobilePanel}`}>
        <aside
          id="workflow-panel"
          className="workflow-rail"
          aria-label="PPT 工作流"
        >
          <ol>
            {workspaceStages.map(([id, label], index) => (
              <li
                key={id}
                className={
                  stage === id ? 'is-current' : index < 4 ? 'is-complete' : ''
                }
              >
                <button
                  onClick={() => {
                    setStage(id);
                    setSlideStatus(`已切换到${label}。`);
                  }}
                >
                  <span className="stage-mark">
                    {index < 4 ? <Icon name="check" /> : index + 1}
                  </span>
                  {label}
                </button>
              </li>
            ))}
          </ol>
          <div className="slide-list" aria-label="幻灯片列表">
            {['封面页', '经营复盘', '业务分析', '增长计划', '实施保障'].map(
              (label, index) => {
                const page = index + 1;
                return (
                  <button
                    key={label}
                    className={page === currentSlide ? 'is-selected' : ''}
                    onClick={() => setSelectedSlide(page)}
                  >
                    <span>{String(page).padStart(2, '0')}</span>
                    {label}
                    <i
                      aria-label={
                        page < 3 ? '已批准' : page === 3 ? '等待审批' : '未开始'
                      }
                    />
                  </button>
                );
              },
            )}
          </div>
        </aside>
        <main id="canvas-panel" className="canvas-area">
          <div className="canvas-scroll">
            <SlideCanvas slide={currentSlide} />
          </div>
          <div className="canvas-nav">
            <button
              className="button button-secondary"
              disabled={currentSlide === 1}
              onClick={() => setSelectedSlide(Math.max(1, currentSlide - 1))}
            >
              <Icon name="arrowLeft" />
              上一页
            </button>
            <span>{String(currentSlide).padStart(2, '0')} / 05</span>
            <button
              className="button button-secondary"
              disabled={currentSlide === 5}
              onClick={() => setSelectedSlide(Math.min(5, currentSlide + 1))}
            >
              下一页
              <Icon name="arrowRight" />
            </button>
          </div>
        </main>
        <aside
          id="review-panel"
          className="review-inspector"
          aria-label="审批面板"
        >
          <header>
            <Icon name="eye" />
            <h2>视觉审批</h2>
          </header>
          <section>
            <h3>AI 生成进度</h3>
            <ol className="timeline">
              <li className="done">
                页面布局生成完成 <time>14:28:31</time>
              </li>
              <li className="done">
                图表数据可视化完成 <time>14:28:41</time>
              </li>
              <li className="done">
                视觉样式应用完成 <time>14:29:02</time>
              </li>
              <li className="current">
                综合检查 <time>14:29:18</time>
              </li>
              <li>待审批</li>
            </ol>
          </section>
          <section>
            <h3>参考来源</h3>
            <ul className="source-list">
              <li>
                <Icon name="file" />
                经营复盘与增长计划_数据汇总.xlsx
              </li>
              <li>
                <Icon name="file" />
                2024 年度经营报告.pdf
              </li>
              <li>
                <Icon name="file" />
                行业趋势分析报告.pdf
              </li>
            </ul>
          </section>
          <section>
            <label htmlFor="review-comment">审批意见</label>
            <textarea
              id="review-comment"
              value={comment}
              onChange={(event) => setComment(event.target.value)}
              maxLength={500}
              placeholder="请输入意见（选填）"
              rows={4}
            />
            <small className="char-count">{comment.length} / 500</small>
          </section>
          <div className="review-state-row">
            <p className="review-state" aria-live="polite">
              {slideStatus}
            </p>
            <button
              className="text-action"
              onClick={() =>
                void action(() => adapter.reopenSlide(project.id, currentSlide))
              }
            >
              重新打开
            </button>
          </div>
          <div className="review-actions">
            <button
              className="button button-secondary"
              onClick={() =>
                void action(() =>
                  adapter.regenerateSlide(project.id, currentSlide, comment),
                )
              }
            >
              <Icon name="refresh" />
              重新生成
            </button>
            <button
              className="button button-primary"
              onClick={() =>
                void action(() =>
                  adapter.approveSlide(project.id, currentSlide, comment),
                )
              }
            >
              批准并生成下一页
            </button>
          </div>
          <p className="capability-note">
            <Icon name="info" />
            演示模式可完成完整视觉评审；本地服务若缺少图片能力会显示可恢复错误。
          </p>
        </aside>
      </div>
    </div>
  );
}

function SlideCanvas({ slide }: { slide: number }) {
  const titles = [
    '年度经营复盘与增长计划',
    '经营成果回顾',
    '核心业务表现',
    '增长计划',
    '实施保障',
  ];
  return (
    <article className="slide-canvas" aria-label={`第 ${slide} 页预览`}>
      <div className="slide-title">
        <span>0{slide}</span>
        <small>{slide === 3 ? '业务分析' : '年度经营复盘'}</small>
        <h2>{titles[slide - 1]}</h2>
        <p>
          {slide === 3
            ? '收入稳健增长，利润结构持续优化'
            : '基于经验证的材料与结构化演示规范'}
        </p>
      </div>
      {slide === 3 ? (
        <BusinessSlide />
      ) : (
        <div className="slide-placeholder">
          <Icon name="file" />
          <strong>{titles[slide - 1]}</strong>
          <span>当前页面已准备好进入视觉审批</span>
        </div>
      )}
      <footer>0{slide}</footer>
    </article>
  );
}

function BusinessSlide() {
  return (
    <>
      <div className="metric-row">
        <Metric
          label="营业收入（亿元）"
          value="128.7"
          delta="同比增长 18.6% ↑"
        />
        <Metric
          label="归母净利润（亿元）"
          value="16.3"
          delta="同比增长 23.4% ↑"
        />
        <Metric label="毛利率" value="32.7%" delta="同比提升 2.1pp ↑" />
      </div>
      <div className="business-bottom">
        <section>
          <h3>业务亮点</h3>
          {['主营业务稳步增长', '盈利能力持续提升', '客户结构优化'].map(
            (item) => (
              <div className="insight" key={item}>
                <span>
                  <Icon name="sparkle" />
                </span>
                <div>
                  <strong>{item}</strong>
                  <p>核心业务收入同比增长，关键经营指标持续改善。</p>
                </div>
              </div>
            ),
          )}
        </section>
        <section className="chart">
          <h3>营业收入趋势（亿元）</h3>
          <div className="chart-bars">
            <svg
              className="chart-line"
              viewBox="0 0 240 100"
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              <polyline points="28,66 90,38 151,72 212,37" />
              <circle cx="28" cy="66" r="3" />
              <circle cx="90" cy="38" r="3" />
              <circle cx="151" cy="72" r="3" />
              <circle cx="212" cy="37" r="3" />
            </svg>
            {[78.4, 91.6, 108.5, 128.7].map((value, index) => (
              <div key={value}>
                <i style={{ height: `${value / 1.55}%` }} />
                <b>{value}</b>
                <span>{2021 + index}</span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </>
  );
}

function Metric({
  label,
  value,
  delta,
}: {
  label: string;
  value: string;
  delta: string;
}) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{delta}</small>
    </div>
  );
}

function ApprovalsPage({
  report,
}: {
  report: (
    action: () => Promise<{ status?: string; message?: string }>,
  ) => Promise<void>;
}) {
  const [items, setItems] = useState(approvalItems);
  const decide = (id: string, label: string) => {
    setItems((current) => current.filter((item) => item.id !== id));
    void report(async () => ({ status: `${label}已记录。` }));
  };
  return (
    <div className="standard-page">
      <PageHeader
        title="审批中心"
        description="集中处理需要确认的内容、视觉版本与执行请求。"
      />
      <section className="approval-board">
        <div className="section-heading">
          <h2>待处理审批</h2>
          <span className="muted">{items.length} 项</span>
        </div>
        {items.length ? (
          items.map((item) => (
            <div className="approval-board-row" key={item.id}>
              <ApprovalRow item={item} />
              <div>
                <button
                  className="button button-secondary"
                  onClick={() => decide(item.id, '已驳回')}
                >
                  驳回
                </button>
                <button
                  className="button button-primary"
                  onClick={() => decide(item.id, '已批准')}
                >
                  批准
                </button>
              </div>
            </div>
          ))
        ) : (
          <div className="empty-inline">所有审批都已处理。</div>
        )}
      </section>
    </div>
  );
}

function MemoryPage({
  adapter,
  report,
}: {
  adapter: DesktopAdapter;
  report: (
    action: () => Promise<{ status?: string; message?: string }>,
  ) => Promise<void>;
}) {
  const [memory, setMemory] = useState([
    {
      id: 'memory-chart',
      title: '图表优先',
      content: '在经营复盘类 PPT 中，优先使用趋势图和对比图呈现关键数据。',
      status: '待决定',
    },
    {
      id: 'memory-tone',
      title: '中文简洁表述',
      content: '报告文本采用简洁、直接的中文表达，并保留关键事实来源。',
      status: '待决定',
    },
  ]);
  const decide = async (id: string, decision: 'approved' | 'rejected') => {
    try {
      const result = await adapter.decideMemory(id, decision);
      setMemory((current) =>
        current.map((item) =>
          item.id === id ? { ...item, status: result.status } : item,
        ),
      );
    } catch (error) {
      await report(async () => {
        throw error;
      });
    }
  };
  return (
    <div className="standard-page">
      <PageHeader
        title="偏好记忆"
        description="仅在你批准后，系统才会把新的工作偏好保存为可复用记忆。"
      />
      <section className="memory-list">
        {memory.map((item) => (
          <article className="memory-row" key={item.id}>
            <div>
              <span className="memory-icon">
                <Icon name="brain" />
              </span>
              <div>
                <h2>{item.title}</h2>
                <p>{item.content}</p>
                <small>{item.status}</small>
              </div>
            </div>
            {item.status === '待决定' && (
              <div className="memory-actions">
                <button
                  className="button button-secondary"
                  aria-label={`拒绝偏好：${item.title}`}
                  onClick={() => void decide(item.id, 'rejected')}
                >
                  拒绝
                </button>
                <button
                  className="button button-primary"
                  aria-label={`批准偏好：${item.title}`}
                  onClick={() => void decide(item.id, 'approved')}
                >
                  批准
                </button>
              </div>
            )}
          </article>
        ))}
      </section>
    </div>
  );
}

function SettingsPage({
  adapter,
  report,
}: {
  adapter: DesktopAdapter;
  report: (
    action: () => Promise<{ status?: string; message?: string }>,
  ) => Promise<void>;
}) {
  const [workspacePath, setWorkspacePath] = useState(
    '/Users/demo/Documents/Workspaces',
  );
  const [codexPath, setCodexPath] = useState('自动检测');
  const [isSaving, setIsSaving] = useState(false);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setIsSaving(true);
    await report(() => adapter.saveSettings({ workspacePath, codexPath }));
    setIsSaving(false);
  };
  return (
    <div className="standard-page settings-page">
      <PageHeader
        title="设置"
        description="管理工作区位置、Codex 路径与账户状态。"
      />
      <form className="settings-form" onSubmit={save}>
        <section>
          <h2>工作区</h2>
          <label htmlFor="workspace-path">默认工作区路径</label>
          <input
            id="workspace-path"
            value={workspacePath}
            onChange={(event) => setWorkspacePath(event.target.value)}
          />
        </section>
        <section>
          <h2>Codex</h2>
          <label htmlFor="codex-path">Codex 可执行路径</label>
          <input
            id="codex-path"
            value={codexPath}
            onChange={(event) => setCodexPath(event.target.value)}
          />
          <p className="muted">
            应用会优先使用配置路径，其次检测本机可执行文件。
          </p>
        </section>
        <section>
          <h2>账户状态</h2>
          <p className="connected">
            <span className="connection-dot" />
            本地连接可用
          </p>
          <p className="muted">账号查询与登录通过 Codex App Server 完成。</p>
        </section>
        <button className="button button-primary" disabled={isSaving}>
          {isSaving ? '正在保存…' : '保存设置'}
        </button>
      </form>
    </div>
  );
}

function PageHeader({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <header className="page-header">
      <h1>{title}</h1>
      <p>{description}</p>
    </header>
  );
}

function Progress({ value }: { value: number }) {
  return (
    <span className="progress" aria-label={`进度 ${value}%`}>
      <i style={{ width: `${value}%` }} />
    </span>
  );
}

type IconName =
  | 'logo'
  | 'home'
  | 'layers'
  | 'file'
  | 'checkSquare'
  | 'brain'
  | 'settings'
  | 'sparkle'
  | 'arrowRight'
  | 'plus'
  | 'cube'
  | 'monitor'
  | 'clock'
  | 'queue'
  | 'check'
  | 'arrowLeft'
  | 'edit'
  | 'export'
  | 'eye'
  | 'refresh'
  | 'info';

function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, ReactNode> = {
    logo: (
      <path d="m12 3 8.2 4.7-2 9.3L12 21l-6.2-4L3.8 7.7 12 3Zm0 0v7l6.2 7M12 10 5.8 17" />
    ),
    home: (
      <path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1V10Z" />
    ),
    layers: <path d="m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5" />,
    file: (
      <path d="M6 3h8l4 4v14H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm8 0v5h5M8 12h8M8 16h6" />
    ),
    checkSquare: (
      <path d="M9 11.5 11 14l4-5M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" />
    ),
    brain: (
      <path d="M9 4a3 3 0 0 0-5 2 3 3 0 0 0 0 5 3 3 0 0 0 1 5 3 3 0 0 0 4 4m2-16a3 3 0 0 1 5 2 3 3 0 0 1 0 5 3 3 0 0 1-1 5 3 3 0 0 1-4 4M12 4v16M8 8h4m0 4H8m4 4h4" />
    ),
    settings: (
      <path d="M12 15.2A3.2 3.2 0 1 0 12 8.8a3.2 3.2 0 0 0 0 6.4ZM19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.1 2.1-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-3v-.2a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1-2.1-2.1.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.6-1H5.3v-3h.2a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1 2.1-2.1.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.6v-.2h3v.2a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1 2.1 2.1-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v3h-.2a1.7 1.7 0 0 0-1.6 1Z" />
    ),
    sparkle: (
      <path d="m12 2 1.7 6.3L20 10l-6.3 1.7L12 18l-1.7-6.3L4 10l6.3-1.7L12 2Zm7 12 .9 3.1L23 18l-3.1.9L19 22l-.9-3.1L15 18l3.1-.9L19 14Z" />
    ),
    arrowRight: <path d="M5 12h14m-6-6 6 6-6 6" />,
    plus: <path d="M12 5v14M5 12h14" />,
    cube: (
      <path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Zm0 9 8-4.5M12 12 4 7.5M12 12v9" />
    ),
    monitor: <path d="M4 5h16v11H4V5Zm4 15h8m-4-4v4" />,
    clock: <path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-14v5l3 2" />,
    queue: <path d="M4 6h16M4 12h16M4 18h16M6 4v4m6-4v4m6-4v4" />,
    check: <path d="m5 12 4 4L19 6" />,
    arrowLeft: <path d="M19 12H5m6 6-6-6 6-6" />,
    edit: (
      <path d="m4 20 4.2-1 10-10a2 2 0 0 0-2.8-2.8l-10 10L4 20Zm9.5-12.5L16.3 10" />
    ),
    export: <path d="M12 3v12m0-12 4 4m-4-4L8 7M5 13v7h14v-7" />,
    eye: (
      <path d="M2.5 12s3.3-6 9.5-6 9.5 6 9.5 6-3.3 6-9.5 6-9.5-6-9.5-6Zm9.5 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
    ),
    refresh: <path d="M20 11a8 8 0 1 0 1 4M20 5v6h-6" />,
    info: <path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-10v5m0-8v.1" />,
  };
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths[name]}
    </svg>
  );
}

function routeFromHash(): Route | null {
  const candidate = window.location.hash.replace(/^#\//, '') as Route;
  return [
    'dashboard',
    'tasks',
    'projects',
    'workspace',
    'approvals',
    'memory',
    'settings',
  ].includes(candidate)
    ? candidate
    : null;
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : '操作未完成，请稍后重试。';
}
