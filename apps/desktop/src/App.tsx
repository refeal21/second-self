import {
  useEffect,
  useReducer,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import {
  createDesktopAdapter,
  type ApprovalSummary,
  type CollectionAvailability,
  type DesktopAdapter,
  type TaskSummary,
} from './desktop-adapter.js';
import {
  createWorkbenchState,
  workbenchReducer,
  type WorkbenchAction,
  type WorkbenchMemory,
  type WorkbenchProject,
  type WorkbenchState,
} from './workbench-store.js';
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
  const [workbench, dispatch] = useReducer(
    workbenchReducer,
    adapter.initialState,
    createWorkbenchState,
  );
  const [task, setTask] = useState<TaskSummary | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const mutationCounter = useRef(0);
  const selectedProject =
    workbench.projects.find(
      (project) => project.id === workbench.selectedProjectId,
    ) ?? null;

  useEffect(() => {
    const onPopState = () => setRoute(routeFromHash() ?? 'dashboard');
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    if (!task) return;
    return adapter.subscribeTask(task.id, setTask);
  }, [adapter, task?.id]);

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
        {selectedProject ? (
          <WorkspacePage
            adapter={adapter}
            project={selectedProject}
            dispatch={dispatch}
            nextMutationToken={() => ++mutationCounter.current}
            navigate={navigate}
            report={report}
          />
        ) : (
          <main id="main-content" className="workspace-unavailable">
            <h1>项目工作台不可用</h1>
            <p>
              {collectionMessage(
                workbench.collections.projects,
                '当前没有可打开的项目。',
                '项目数据',
              )}
            </p>
            <button className="button button-primary" onClick={() => navigate('projects')}>
              返回 PPT 项目
            </button>
          </main>
        )}
      </div>
    ) : (
      <AppShell adapter={adapter} route={route} navigate={navigate}>
        {route === 'dashboard' && (
          <DashboardPage workbench={workbench} navigate={navigate} />
        )}
        {route === 'tasks' && (
          <TasksPage
            adapter={adapter}
            task={task}
            setTask={setTask}
            account={workbench.account}
            dispatch={dispatch}
            report={report}
          />
        )}
        {route === 'projects' && (
          <ProjectsPage
            adapter={adapter}
            projects={workbench.projects}
            availability={workbench.collections.projects}
            dispatch={dispatch}
            navigate={navigate}
            report={report}
          />
        )}
        {route === 'approvals' && (
          <ApprovalsPage
            adapter={adapter}
            items={workbench.approvals}
            availability={workbench.collections.approvals}
            pending={workbench.pendingApprovals}
            dispatch={dispatch}
            nextMutationToken={() => ++mutationCounter.current}
            report={report}
          />
        )}
        {route === 'memory' && (
          <MemoryPage
            adapter={adapter}
            memory={workbench.memories}
            availability={workbench.collections.memories}
            dispatch={dispatch}
            nextMutationToken={() => ++mutationCounter.current}
            report={report}
          />
        )}
        {route === 'settings' && (
          <SettingsPage
            adapter={adapter}
            account={workbench.account}
            runtime={workbench.runtime}
            settings={workbench.settings}
            dispatch={dispatch}
            report={report}
          />
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

function DashboardPage({
  workbench,
  navigate,
}: {
  workbench: WorkbenchState;
  navigate: (route: Route) => void;
}) {
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
            {workbench.projects.map((item) => (
              <div className="work-row" role="row" key={item.id}>
                <div className="work-name">
                  <span className="work-icon file">
                    <Icon name="file" />
                  </span>
                  <span>
                    <strong>{item.name}</strong>
                    <small>{item.goal}</small>
                  </span>
                </div>
                <span>PPT 项目</span>
                <span>{item.stage}</span>
                <span className="text-accent">
                  {item.pendingMutation ? '处理中' : '进行中'}
                </span>
                <span className="progress-cell">
                  <Progress value={item.progress} />
                  <em>{item.progress}%</em>
                </span>
                <span>{item.updatedAt}</span>
              </div>
            ))}
            {!workbench.projects.length && (
              <div className="empty-inline" role="row">
                {collectionMessage(
                  workbench.collections.projects,
                  '当前没有项目。',
                  '项目数据',
                )}
              </div>
            )}
          </div>
          <button
            className="text-action center-action"
            onClick={() => navigate('projects')}
          >
            查看全部工作 <Icon name="arrowRight" />
          </button>
        </section>
      </section>
      <DashboardAside workbench={workbench} navigate={navigate} />
    </div>
  );
}

function DashboardAside({
  workbench,
  navigate,
}: {
  workbench: WorkbenchState;
  navigate: (route: Route) => void;
}) {
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
          {workbench.approvals.map((item) => (
            <ApprovalRow key={item.id} item={item} />
          ))}
          {!workbench.approvals.length && (
            <p className="muted">
              {collectionMessage(
                workbench.collections.approvals,
                '当前没有待处理审批。',
                '审批数据',
              )}
            </p>
          )}
        </div>
      </section>
      <section className="codex-status" aria-labelledby="codex-heading">
        <h2 id="codex-heading">Codex 连接状态</h2>
        <p className={workbench.runtime.status === 'connected' ? 'connected' : 'muted'}>
          <span className="connection-dot" />
          {workbench.runtime.status === 'connected' ? '已连接' : '不可用'}
        </p>
        <p className="muted">{workbench.runtime.detail}</p>
        <button className="text-action" onClick={() => navigate('settings')}>
          查看详情
        </button>
        <dl>
          <div>
            <dt>
              <Icon name="cube" />
              模型
            </dt>
            <dd>{workbench.runtime.model ?? '未提供'}</dd>
          </div>
          <div>
            <dt>
              <Icon name="monitor" />
              服务地址
            </dt>
            <dd>{workbench.runtime.address ?? '未提供'}</dd>
          </div>
          <div>
            <dt>
              <Icon name="clock" />
              运行时间
            </dt>
            <dd>{workbench.runtime.uptime ?? '未提供'}</dd>
          </div>
          <div>
            <dt>
              <Icon name="queue" />
              队列任务
            </dt>
            <dd>{workbench.runtime.queue ?? '未提供'}</dd>
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

function ApprovalRow({ item }: { item: ApprovalSummary }) {
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
  account,
  dispatch,
  report,
}: {
  adapter: DesktopAdapter;
  task: TaskSummary | null;
  setTask: (task: TaskSummary) => void;
  account: WorkbenchState['account'];
  dispatch: (action: WorkbenchAction) => void;
  report: (
    action: () => Promise<{ status?: string; message?: string }>,
  ) => Promise<void>;
}) {
  const [prompt, setPrompt] = useState(
    '请整理本周产品评审的结论，并输出行动清单。',
  );
  const [inputAnswers, setInputAnswers] = useState<Record<string, string[]>>(
    {},
  );
  const [isStarting, setIsStarting] = useState(false);
  const [isResponding, setIsResponding] = useState(false);
  const inputQuestions = task ? parseTaskQuestions(task) : [];
  const hasAllInputAnswers =
    inputQuestions.length > 0 &&
    inputQuestions.every((question) =>
      inputAnswers[question.id]?.some((answer) => answer.trim()),
    );

  useEffect(() => {
    setInputAnswers({});
  }, [task?.pendingInteraction?.requestId]);

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
      dispatch({ type: 'account-updated', account: next });
    } catch (error) {
      await report(async () => {
        throw error;
      });
    }
  };
  const respond = async (decision: 'approve' | 'decline') => {
    if (!task) return;
    setIsResponding(true);
    try {
      const result = await adapter.respondToTask(task.id, decision);
      await report(async () => result);
    } catch (error) {
      await report(async () => {
        throw error;
      });
    } finally {
      setIsResponding(false);
    }
  };
  const answerInput = async () => {
    if (!task?.pendingInteraction || !hasAllInputAnswers) return;
    setIsResponding(true);
    try {
      const answers = Object.fromEntries(
        inputQuestions.map((question) => [
          question.id,
          (inputAnswers[question.id] ?? [])
            .map((answer) => answer.trim())
            .filter(Boolean),
        ]),
      );
      const result = await adapter.respondToTaskInput(task.id, answers);
      setInputAnswers({});
      await report(async () => result);
    } catch (error) {
      await report(async () => {
        throw error;
      });
    } finally {
      setIsResponding(false);
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
            {account.status === 'connected'
              ? `${account.email ?? '已连接'} · ${account.plan ?? 'ChatGPT'}`
              : account.status === 'logged_out'
                ? '尚未登录'
                : '尚未从本地服务读取'}
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
                  : task.status === 'waiting_for_input'
                    ? '等待你的补充信息'
                    : task.status === 'completed'
                      ? '任务已完成'
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
                  disabled={isResponding}
                  onClick={() => void respond('decline')}
                >
                  拒绝
                </button>
                <button
                  className="button button-primary"
                  disabled={isResponding}
                  onClick={() => void respond('approve')}
                >
                  批准继续
                </button>
              </div>
            )}
            {task.status === 'waiting_for_input' && (
              <div className="task-input-response">
                <strong>Codex 需要补充信息</strong>
                {inputQuestions.map((question, questionIndex) => (
                  <fieldset key={question.id}>
                    <legend>{question.header}</legend>
                    <p>{question.question}</p>
                    {question.options.length ? (
                      <div className="task-question-options">
                        {question.options.map((option, optionIndex) => {
                          const optionId = `task-question-${questionIndex}-${optionIndex}`;
                          return (
                          <label key={option.label} htmlFor={optionId}>
                            <input
                              id={optionId}
                              type="radio"
                              aria-label={option.label}
                              name={`task-question-${question.id}`}
                              value={option.label}
                              checked={
                                inputAnswers[question.id]?.[0] === option.label
                              }
                              onChange={() =>
                                setInputAnswers((current) => ({
                                  ...current,
                                  [question.id]: [option.label],
                                }))
                              }
                            />
                            <span>
                              {option.label}
                              {option.description && (
                                <small>{option.description}</small>
                              )}
                            </span>
                          </label>
                          );
                        })}
                      </div>
                    ) : (
                      <label>
                        回答
                        <input
                          value={inputAnswers[question.id]?.[0] ?? ''}
                          onChange={(event) =>
                            setInputAnswers((current) => ({
                              ...current,
                              [question.id]: [event.target.value],
                            }))
                          }
                        />
                      </label>
                    )}
                  </fieldset>
                ))}
                {!inputQuestions.length && (
                  <p role="alert">App Server 未提供可回答的问题。</p>
                )}
                <button
                  className="button button-primary"
                  disabled={isResponding || !hasAllInputAnswers}
                  onClick={() => void answerInput()}
                >
                  提交回答
                </button>
              </div>
            )}
          </div>
          {task.error && <p role="alert">{task.error}</p>}
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
  projects,
  availability,
  dispatch,
  navigate,
  report,
}: {
  adapter: DesktopAdapter;
  projects: WorkbenchProject[];
  availability: CollectionAvailability;
  dispatch: (action: WorkbenchAction) => void;
  navigate: (route: Route) => void;
  report: (
    action: () => Promise<{ status?: string; message?: string }>,
  ) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim() || !goal.trim()) return;
    setIsCreating(true);
    try {
      const created = await adapter.createProject({
        name: name.trim(),
        goal: goal.trim(),
      });
      dispatch({ type: 'project-created', project: created });
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
            <span className="muted">{projects.length} 个进行中</span>
          </div>
          {projects.map((project) => (
            <button
              className="project-row"
              key={project.id}
              onClick={() => {
                dispatch({ type: 'project-selected', projectId: project.id });
                navigate('workspace');
              }}
            >
              <span className="file-avatar"><Icon name="file" /></span>
              <span>
                <strong>{project.name}</strong>
                <small>{project.stage} · 更新于 {project.updatedAt}</small>
              </span>
              <span className="project-progress">
                <Progress value={project.progress} />{project.progress}%
              </span>
              <Icon name="arrowRight" />
            </button>
          ))}
          {!projects.length && (
            <div className="empty-inline">
              {collectionMessage(
                availability,
                '当前没有项目。',
                '项目数据',
              )}
            </div>
          )}
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
              value={goal}
              onChange={(event) => setGoal(event.target.value)}
              placeholder="说明受众、场景与希望传达的信息"
              required
              rows={4}
            />
            <button
              className="button button-primary full-width"
              disabled={isCreating || !name.trim() || !goal.trim()}
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
  dispatch,
  nextMutationToken,
  navigate,
  report,
}: {
  adapter: DesktopAdapter;
  project: WorkbenchProject;
  dispatch: (action: WorkbenchAction) => void;
  nextMutationToken: () => number;
  navigate: (route: Route) => void;
  report: (
    action: () => Promise<{ status?: string; message?: string }>,
  ) => Promise<void>;
}) {
  const [comment, setComment] = useState('');
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState(project.name);
  const [isRenaming, setIsRenaming] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [mobilePanel, setMobilePanel] = useState<
    'workflow' | 'canvas' | 'review'
  >('canvas');
  const currentSlide = project.selectedSlide;
  const currentSlideState = project.slides[currentSlide - 1];
  const currentStageIndex = workspaceStages.findIndex(
    ([id]) => id === project.workflowStage,
  );
  const runSlideMutation = async (kind: 'approve' | 'regenerate') => {
    if (project.pendingMutation) return;
    const token = nextMutationToken();
    const projectId = project.id;
    const slide = currentSlide;
    dispatch({
      type: 'slide-mutation-started',
      projectId,
      token,
      kind,
      slide,
    });
    try {
      const result =
        kind === 'approve'
          ? await adapter.approveSlide(projectId, slide, comment)
          : await adapter.regenerateSlide(projectId, slide, comment);
      dispatch({ type: 'slide-mutation-resolved', projectId, token, result });
    } catch (error) {
      dispatch({
        type: 'slide-mutation-failed',
        projectId,
        token,
        status: toMessage(error),
      });
      await report(async () => {
        throw error;
      });
    }
  };
  const reopen = async () => {
    if (project.pendingMutation) return;
    const token = nextMutationToken();
    const projectId = project.id;
    const slide = currentSlide;
    dispatch({
      type: 'slide-mutation-started',
      projectId,
      token,
      kind: 'reopen',
      slide,
    });
    try {
      const result = await adapter.reopenSlide(projectId, slide);
      dispatch({
        type: 'slide-mutation-resolved',
        projectId,
        token,
        result,
      });
    } catch (error) {
      dispatch({
        type: 'slide-mutation-failed',
        projectId,
        token,
        status: toMessage(error),
      });
      await report(async () => {
        throw error;
      });
    }
  };
  const rename = async (event: FormEvent) => {
    event.preventDefault();
    const name = draftName.trim();
    if (!name || isRenaming) return;
    setIsRenaming(true);
    try {
      const result = await adapter.renameProject(project.id, name);
      dispatch({ type: 'project-renamed', projectId: project.id, name });
      setEditingName(false);
      await report(async () => result);
    } catch (error) {
      await report(async () => {
        throw error;
      });
    } finally {
      setIsRenaming(false);
    }
  };
  const exportPpt = async () => {
    if (isExporting) return;
    setIsExporting(true);
    await report(() => adapter.exportProject(project.id, project.name));
    setIsExporting(false);
  };
  const selectPanel = (panel: 'workflow' | 'canvas' | 'review') => {
    setMobilePanel(panel);
    document.getElementById(`workspace-tab-${panel}`)?.focus();
  };
  const onTabKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    panel: 'workflow' | 'canvas' | 'review',
  ) => {
    const panels = ['workflow', 'canvas', 'review'] as const;
    const index = panels.indexOf(panel);
    const next =
      event.key === 'ArrowRight'
        ? panels[(index + 1) % panels.length]
        : event.key === 'ArrowLeft'
          ? panels[(index - 1 + panels.length) % panels.length]
          : event.key === 'Home'
            ? panels[0]
            : event.key === 'End'
              ? panels.at(-1)
              : null;
    if (!next) return;
    event.preventDefault();
    selectPanel(next);
  };
  return (
    <main id="main-content" className="workspace-shell">
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
          {editingName ? (
            <form className="rename-project" onSubmit={rename}>
              <label htmlFor="workspace-project-name">项目名称</label>
              <input
                id="workspace-project-name"
                value={draftName}
                onChange={(event) => setDraftName(event.target.value)}
                autoFocus
              />
              <button className="button button-primary" disabled={isRenaming || !draftName.trim()}>
                {isRenaming ? '保存中…' : '保存名称'}
              </button>
            </form>
          ) : (
            <h1>
              {project.name}{' '}
              <button
                className="edit-title"
                aria-label="编辑项目名称"
                onClick={() => {
                  setDraftName(project.name);
                  setEditingName(true);
                }}
              >
                <Icon name="edit" />
              </button>
            </h1>
          )}
          <p className="project-goal">项目目标：{project.goal}</p>
          <p>最后更新：{project.updatedAt}</p>
        </div>
        <div className="workspace-actions">
          <span>
            项目状态：<strong className="text-accent">进行中</strong>
          </span>
          <button
            className="button button-secondary"
            disabled={isExporting}
            onClick={() => void exportPpt()}
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
            id={`workspace-tab-${id}`}
            role="tab"
            aria-selected={mobilePanel === id}
            aria-controls={`${id}-panel`}
            tabIndex={mobilePanel === id ? 0 : -1}
            onKeyDown={(event) => onTabKeyDown(event, id)}
            onClick={() => selectPanel(id)}
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
          role="tabpanel"
          aria-labelledby="workspace-tab-workflow"
        >
          <ol>
            {workspaceStages.map(([id, label], index) => (
              <li
                key={id}
                className={
                  project.workflowStage === id
                    ? 'is-current'
                    : index < currentStageIndex
                      ? 'is-complete'
                      : ''
                }
              >
                <button
                  disabled={index > currentStageIndex}
                  onClick={() =>
                    void report(async () => ({
                      status:
                        index < currentStageIndex
                          ? `${label}已完成；当前阶段仍为${workspaceStages[currentStageIndex]?.[1]}。`
                          : `当前阶段：${label}。`,
                    }))
                  }
                >
                  <span className="stage-mark">
                    {index < currentStageIndex ? <Icon name="check" /> : index + 1}
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
                    onClick={() =>
                      dispatch({ type: 'select-slide', projectId: project.id, slide: page })
                    }
                  >
                    <span>{String(page).padStart(2, '0')}</span>
                    {label}
                    <i
                      aria-label={
                        project.slides[index]?.status === 'approved'
                          ? '已批准'
                          : project.slides[index]?.status === 'waiting'
                            ? '等待审批'
                            : '未开始'
                      }
                    />
                  </button>
                );
              },
            )}
          </div>
        </aside>
        <section
          id="canvas-panel"
          className="canvas-area"
          role="tabpanel"
          aria-labelledby="workspace-tab-canvas"
        >
          <div className="canvas-scroll">
            <SlideCanvas slide={currentSlide} />
          </div>
          <div className="canvas-nav">
            <button
              className="button button-secondary"
              disabled={currentSlide === 1}
              onClick={() => dispatch({ type: 'select-slide', projectId: project.id, slide: currentSlide - 1 })}
            >
              <Icon name="arrowLeft" />
              上一页
            </button>
            <span>{String(currentSlide).padStart(2, '0')} / 05</span>
            <button
              className="button button-secondary"
              disabled={currentSlide === 5}
              onClick={() => dispatch({ type: 'select-slide', projectId: project.id, slide: currentSlide + 1 })}
            >
              下一页
              <Icon name="arrowRight" />
            </button>
          </div>
        </section>
        <aside
          id="review-panel"
          className="review-inspector"
          aria-label="审批面板"
          role="tabpanel"
          aria-labelledby="workspace-tab-review"
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
              {project.slideNotice}
            </p>
            <button
              className="text-action"
              disabled={
                Boolean(project.pendingMutation) ||
                currentSlideState?.status !== 'approved'
              }
              onClick={() => void reopen()}
            >
              重新打开
            </button>
          </div>
          <div className="review-actions">
            <button
              className="button button-secondary"
              disabled={Boolean(project.pendingMutation)}
              onClick={() => void runSlideMutation('regenerate')}
            >
              <Icon name="refresh" />
              重新生成
            </button>
            <button
              className="button button-primary"
              disabled={Boolean(project.pendingMutation) || currentSlideState?.status !== 'waiting'}
              onClick={() => void runSlideMutation('approve')}
            >
              {currentSlide === 5 ? '批准并进入转换' : '批准并生成下一页'}
            </button>
          </div>
          <p className="capability-note">
            <Icon name="info" />
            演示模式可完成完整视觉评审；本地服务若缺少图片能力会显示可恢复错误。
          </p>
        </aside>
      </div>
    </main>
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
  adapter,
  items,
  availability,
  pending,
  dispatch,
  nextMutationToken,
  report,
}: {
  adapter: DesktopAdapter;
  items: ApprovalSummary[];
  availability: CollectionAvailability;
  pending: Record<string, number>;
  dispatch: (action: WorkbenchAction) => void;
  nextMutationToken: () => number;
  report: (
    action: () => Promise<{ status?: string; message?: string }>,
  ) => Promise<void>;
}) {
  const decide = async (
    id: string,
    decision: 'approved' | 'rejected',
  ) => {
    if (pending[id] !== undefined) return;
    const token = nextMutationToken();
    dispatch({ type: 'approval-mutation-started', approvalId: id, token });
    try {
      const result = await adapter.decideApproval(id, decision);
      dispatch({ type: 'approval-mutation-resolved', approvalId: id, token });
      await report(async () => result);
    } catch (error) {
      dispatch({ type: 'approval-mutation-failed', approvalId: id, token });
      await report(async () => {
        throw error;
      });
    }
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
          <span className="muted">
            {availability === 'loaded' ? `${items.length} 项` : '未加载'}
          </span>
        </div>
        {availability !== 'loaded' ? (
          <div className="empty-inline" role="status">
            {collectionMessage(availability, '', '审批数据')}
          </div>
        ) : items.length ? (
          items.map((item) => (
            <div className="approval-board-row" key={item.id}>
              <ApprovalRow item={item} />
              <div>
                <button
                  className="button button-secondary"
                  disabled={pending[item.id] !== undefined}
                  onClick={() => void decide(item.id, 'rejected')}
                >
                  驳回
                </button>
                <button
                  className="button button-primary"
                  disabled={pending[item.id] !== undefined}
                  onClick={() => void decide(item.id, 'approved')}
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
  memory,
  availability,
  dispatch,
  nextMutationToken,
  report,
}: {
  adapter: DesktopAdapter;
  memory: WorkbenchMemory[];
  availability: CollectionAvailability;
  dispatch: (action: WorkbenchAction) => void;
  nextMutationToken: () => number;
  report: (
    action: () => Promise<{ status?: string; message?: string }>,
  ) => Promise<void>;
}) {
  const decide = async (id: string, decision: 'approved' | 'rejected') => {
    const item = memory.find((entry) => entry.id === id);
    if (!item || item.pendingToken !== null) return;
    const token = nextMutationToken();
    dispatch({ type: 'memory-mutation-started', memoryId: id, token });
    try {
      const result = await adapter.decideMemory(id, decision);
      dispatch({
        type: 'memory-mutation-resolved',
        memoryId: id,
        token,
        status: result.status,
      });
    } catch (error) {
      dispatch({ type: 'memory-mutation-failed', memoryId: id, token });
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
      {availability !== 'loaded' ? (
        <div className="empty-inline" role="status">
          {collectionMessage(availability, '', '偏好记忆数据')}
        </div>
      ) : memory.length === 0 ? (
        <div className="empty-inline" role="status">
          当前没有偏好记忆。
        </div>
      ) : (
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
                  disabled={item.pendingToken !== null}
                  aria-label={`拒绝偏好：${item.title}`}
                  onClick={() => void decide(item.id, 'rejected')}
                >
                  拒绝
                </button>
                <button
                  className="button button-primary"
                  disabled={item.pendingToken !== null}
                  aria-label={`批准偏好：${item.title}`}
                  onClick={() => void decide(item.id, 'approved')}
                >
                  批准
                </button>
              </div>
            )}
            {item.pendingToken !== null && <span className="muted">正在保存…</span>}
          </article>
        ))}
      </section>
      )}
    </div>
  );
}

function SettingsPage({
  adapter,
  account,
  runtime,
  settings,
  dispatch,
  report,
}: {
  adapter: DesktopAdapter;
  account: WorkbenchState['account'];
  runtime: WorkbenchState['runtime'];
  settings: WorkbenchState['settings'];
  dispatch: (action: WorkbenchAction) => void;
  report: (
    action: () => Promise<{ status?: string; message?: string }>,
  ) => Promise<void>;
}) {
  const [isSaving, setIsSaving] = useState(false);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setIsSaving(true);
    await report(() => adapter.saveSettings(settings));
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
            value={settings.workspacePath}
            onChange={(event) =>
              dispatch({
                type: 'settings-edited',
                settings: { ...settings, workspacePath: event.target.value },
              })
            }
          />
        </section>
        <section>
          <h2>Codex</h2>
          <label htmlFor="codex-path">Codex 可执行路径</label>
          <input
            id="codex-path"
            value={settings.codexPath}
            onChange={(event) =>
              dispatch({
                type: 'settings-edited',
                settings: { ...settings, codexPath: event.target.value },
              })
            }
          />
          <p className="muted">
            应用会优先使用配置路径，其次检测本机可执行文件。
          </p>
        </section>
        <section>
          <h2>账户状态</h2>
          <p className={runtime.status === 'connected' ? 'connected' : 'muted'}>
            <span className="connection-dot" />
            {account.status === 'connected'
              ? `${account.email ?? '账户已连接'} · ${account.plan ?? 'ChatGPT'}`
              : account.status === 'logged_out'
                ? '尚未登录'
                : '账户能力不可用'}
          </p>
          <p className="muted">{runtime.detail}</p>
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

function collectionMessage(
  availability: CollectionAvailability,
  emptyMessage: string,
  label: string,
): string {
  if (availability === 'loading') return `${label}正在加载`;
  if (availability === 'unavailable') return `${label}不可用`;
  return emptyMessage;
}

interface TaskInputQuestion {
  id: string;
  header: string;
  question: string;
  options: Array<{ label: string; description: string }>;
}

function parseTaskQuestions(task: TaskSummary): TaskInputQuestion[] {
  if (task.pendingInteraction?.kind !== 'user_input') return [];
  const params = asRecord(task.pendingInteraction.params);
  if (!Array.isArray(params?.questions)) return [];
  return params.questions.flatMap((value) => {
    const question = asRecord(value);
    if (typeof question?.id !== 'string') return [];
    const text =
      typeof question.question === 'string' ? question.question : '请提供回答';
    const header =
      typeof question.header === 'string' ? question.header : text;
    const options = Array.isArray(question.options)
      ? question.options.flatMap((optionValue) => {
          const option = asRecord(optionValue);
          if (typeof option?.label !== 'string') return [];
          return [
            {
              label: option.label,
              description:
                typeof option.description === 'string'
                  ? option.description
                  : '',
            },
          ];
        })
      : [];
    return [{ id: question.id, header, question: text, options }];
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null;
}
