/* @vitest-environment jsdom */

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import {
  createDemoDesktopAdapter,
  type DesktopAdapter,
} from './desktop-adapter.js';

describe('desktop workbench interactions', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '#/dashboard');
  });

  afterEach(() => cleanup());

  it('hydrates the production shell from the adapter durable state', async () => {
    const demo = createDemoDesktopAdapter();
    const adapter = { ...demo, mode: 'tauri' as const } as DesktopAdapter;
    const persisted = structuredClone(adapter.initialState);
    persisted.projects[0] = {
      ...persisted.projects[0]!,
      id: 'persisted-project',
      name: '重启后恢复的项目',
      selectedSlide: 2,
      slides: [
        { page: 1, status: 'approved' },
        { page: 2, status: 'waiting' },
        { page: 3, status: 'pending' },
        { page: 4, status: 'pending' },
        { page: 5, status: 'pending' },
      ],
    };
    adapter.initialState.projects = [];
    adapter.initialState.collections.projects = 'loading';
    adapter.loadInitialState = vi.fn(async () => persisted);

    render(<App adapter={adapter} initialRoute="projects" />);

    expect(
      await screen.findByRole('button', { name: /重启后恢复的项目/ }),
    ).toBeInTheDocument();
    expect(adapter.loadInitialState).toHaveBeenCalledTimes(1);
  });

  it('navigates between dashboard sections with an accessible current item', async () => {
    const user = userEvent.setup();
    render(<App adapter={createDemoDesktopAdapter()} />);

    await user.click(screen.getByRole('link', { name: '审批中心' }));

    expect(
      screen.getByRole('heading', { name: '审批中心' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '审批中心' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('creates a PPT project and opens it in the review workspace', async () => {
    const user = userEvent.setup();
    render(<App adapter={createDemoDesktopAdapter()} />);

    await user.click(screen.getByRole('button', { name: /创建 PPT 项目/ }));
    await user.type(screen.getByLabelText('项目名称'), '产品发布会');
    await user.type(screen.getByLabelText('项目目标'), '向客户介绍新品价值');
    await user.click(screen.getByRole('button', { name: '创建并进入工作台' }));

    expect(
      await screen.findByRole('heading', { name: '产品发布会' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: '视觉审批' }),
    ).toBeInTheDocument();
  });

  it('regenerates a slide and advances after its approval', async () => {
    const user = userEvent.setup();
    render(
      <App adapter={createDemoDesktopAdapter()} initialRoute="workspace" />,
    );

    await user.click(screen.getByRole('button', { name: '重新生成' }));
    expect(await screen.findByText('已生成候选版本')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '批准并生成下一页' }));
    expect(await screen.findByText('已批准，进入第 4 页')).toBeInTheDocument();
  });

  it('records a memory decision instead of leaving the action inert', async () => {
    const user = userEvent.setup();
    render(<App adapter={createDemoDesktopAdapter()} initialRoute="memory" />);

    await user.click(
      screen.getByRole('button', { name: '批准偏好：图表优先' }),
    );

    expect(screen.getByText('已批准')).toBeInTheDocument();
  });

  it('surfaces an adapter error and leaves the project form actionable', async () => {
    const user = userEvent.setup();
    const adapter = createDemoDesktopAdapter({
      createProjectError: 'PPT 服务暂不可用，请稍后重试。',
    });
    render(<App adapter={adapter} initialRoute="projects" />);

    await user.type(screen.getByLabelText('项目名称'), '失败项目');
    await user.type(screen.getByLabelText('项目目标'), '验证失败反馈');
    await user.click(screen.getByRole('button', { name: '创建并进入工作台' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'PPT 服务暂不可用，请稍后重试。',
    );
    expect(
      screen.getByRole('button', { name: '创建并进入工作台' }),
    ).toBeEnabled();
  });

  it('acknowledges a demo export rather than silently ignoring the command', async () => {
    const user = userEvent.setup();
    render(
      <App adapter={createDemoDesktopAdapter()} initialRoute="workspace" />,
    );

    await user.click(screen.getByRole('button', { name: '导出' }));

    expect(await screen.findByRole('status')).toHaveTextContent(
      '演示数据：已准备好“年度经营复盘与增长计划.pptx”导出。',
    );
  });

  it('moves a general task out of approval after the user approves it', async () => {
    const user = userEvent.setup();
    render(<App adapter={createDemoDesktopAdapter()} initialRoute="tasks" />);

    await user.click(
      screen.getByRole('button', { name: /\u5f00\u59cb\u4efb\u52a1/ }),
    );
    expect(await screen.findByText('等待你的批准')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '批准继续' }));

    expect(await screen.findByRole('status')).toHaveTextContent(
      '演示数据：已批准，Codex 正在继续执行。',
    );
    expect(
      screen.queryByRole('button', { name: '批准继续' }),
    ).not.toBeInTheDocument();
    expect(screen.getByText('Codex 正在处理')).toBeInTheDocument();
  });

  it('removes a handled item from the approval center', async () => {
    const user = userEvent.setup();
    render(
      <App adapter={createDemoDesktopAdapter()} initialRoute="approvals" />,
    );

    const item = screen.getByText('智能家居产品发布会');
    const row = item.closest('.approval-board-row');
    expect(row).not.toBeNull();
    await user.click(row!.querySelector<HTMLButtonElement>('.button-primary')!);

    expect(screen.queryByText('智能家居产品发布会')).not.toBeInTheDocument();
    expect(await screen.findByRole('status')).toHaveTextContent(
      '演示数据：已批准已记录。',
    );
  });

  it('saves settings through the adapter and reports the outcome', async () => {
    const user = userEvent.setup();
    render(
      <App adapter={createDemoDesktopAdapter()} initialRoute="settings" />,
    );

    await user.clear(screen.getByLabelText('默认工作区路径'));
    await user.type(screen.getByLabelText('默认工作区路径'), '/tmp/workbench');
    await user.click(screen.getByRole('button', { name: '保存设置' }));

    expect(await screen.findByRole('status')).toHaveTextContent(
      '演示数据：设置已保存在当前浏览器会话。',
    );
  });

  it('switches the compact PPT workspace between workflow, canvas, and review panels', async () => {
    const user = userEvent.setup();
    render(
      <App adapter={createDemoDesktopAdapter()} initialRoute="workspace" />,
    );

    const canvasTab = screen.getByRole('tab', { name: '幻灯片画布' });
    const reviewTab = screen.getByRole('tab', { name: '审批面板' });
    expect(canvasTab).toHaveAttribute('aria-selected', 'true');
    expect(canvasTab).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('tabpanel', { name: '幻灯片画布' })).toHaveAttribute(
      'id',
      'canvas-panel',
    );

    canvasTab.focus();
    await user.keyboard('{ArrowRight}');

    expect(reviewTab).toHaveAttribute('aria-selected', 'true');
    expect(reviewTab).toHaveFocus();
    expect(reviewTab).toHaveAttribute('tabindex', '0');
    expect(canvasTab).toHaveAttribute('aria-selected', 'false');
    expect(canvasTab).toHaveAttribute('tabindex', '-1');
  });

  it('persists approval and memory decisions across route navigation', async () => {
    const user = userEvent.setup();
    render(<App adapter={createDemoDesktopAdapter()} initialRoute="memory" />);

    await user.click(screen.getByRole('button', { name: '批准偏好：图表优先' }));
    await user.click(screen.getByRole('link', { name: '审批中心' }));
    const approval = screen.getByText('智能家居产品发布会').closest('.approval-board-row')!;
    await user.click(approval.querySelector<HTMLButtonElement>('.button-primary')!);
    await user.click(screen.getByRole('link', { name: '首页' }));
    await user.click(screen.getByRole('link', { name: '偏好记忆' }));

    expect(screen.getByText('已批准')).toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: '审批中心' }));
    expect(screen.queryByText('智能家居产品发布会')).not.toBeInTheDocument();
  });

  it('opens the selected project by id and performs a real rename', async () => {
    const user = userEvent.setup();
    render(<App adapter={createDemoDesktopAdapter()} initialRoute="projects" />);

    await user.click(
      screen.getByRole('button', { name: /智能家居产品发布会/ }),
    );
    expect(
      screen.getByRole('heading', { name: '智能家居产品发布会' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/向媒体和渠道伙伴/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '编辑项目名称' }));
    await user.clear(screen.getByLabelText('项目名称'));
    await user.type(screen.getByLabelText('项目名称'), '家庭智能新品发布会');
    await user.click(screen.getByRole('button', { name: '保存名称' }));

    expect(
      await screen.findByRole('heading', { name: '家庭智能新品发布会' }),
    ).toBeInTheDocument();
  });

  it('keeps the final approval on page five and advances to conversion', async () => {
    const user = userEvent.setup();
    render(<App adapter={createDemoDesktopAdapter()} initialRoute="workspace" />);

    await user.click(screen.getByRole('button', { name: '批准并生成下一页' }));
    await screen.findByText('已批准，进入第 4 页');
    await user.click(screen.getByRole('button', { name: '批准并生成下一页' }));
    await screen.findByText('已批准，进入第 5 页');
    await user.click(screen.getByRole('button', { name: '批准并进入转换' }));

    expect(
      await screen.findByText('第 5 页已批准，进入可编辑转换。'),
    ).toBeInTheDocument();
    expect(screen.getByText('05 / 05')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /可编辑转换/ }).closest('li')).toHaveClass(
      'is-current',
    );
  });

  it('disables a PPT mutation while pending and calls the adapter once', async () => {
    const user = userEvent.setup();
    const adapter = createDemoDesktopAdapter({ delays: { approveSlide: 30 } });
    const approve = vi.spyOn(adapter, 'approveSlide');
    render(<App adapter={adapter} initialRoute="workspace" />);
    const button = screen.getByRole('button', { name: '批准并生成下一页' });

    await user.dblClick(button);
    expect(button).toBeDisabled();
    expect(approve).toHaveBeenCalledTimes(1);
    await screen.findByText('已批准，进入第 4 页');
  });

  it('provides a valid skip-link target in the PPT workspace', () => {
    render(<App adapter={createDemoDesktopAdapter()} initialRoute="workspace" />);
    expect(screen.getByText('跳到主要内容')).toHaveAttribute(
      'href',
      '#main-content',
    );
    expect(document.querySelector('main#main-content')).toBeInTheDocument();
  });

  it('does not present demo projects or runtime success in native mode', () => {
    const demo = createDemoDesktopAdapter();
    const nativeLike = {
      ...demo,
      mode: 'tauri',
      initialState: {
        account: { email: null, plan: null, status: 'unavailable' },
        runtime: {
          status: 'unavailable',
          detail: '尚未从本地服务读取',
          model: null,
          address: null,
          uptime: null,
          queue: null,
        },
        projects: [],
        approvals: [],
        memories: [],
        collections: {
          projects: 'unavailable',
          approvals: 'unavailable',
          memories: 'unavailable',
        },
        settings: { workspacePath: '', codexPath: '' },
      },
    } as DesktopAdapter;
    render(<App adapter={nativeLike} />);

    expect(screen.getByText('不可用')).toBeInTheDocument();
    expect(screen.getByText('尚未从本地服务读取')).toBeInTheDocument();
    expect(screen.queryByText('年度经营复盘与增长计划')).not.toBeInTheDocument();
    expect(screen.getByText('项目数据不可用')).toBeInTheDocument();
  });

  it('disables reopen for an unstarted future slide', async () => {
    const user = userEvent.setup();
    const adapter = createDemoDesktopAdapter();
    const reopen = vi.spyOn(adapter, 'reopenSlide');
    render(<App adapter={adapter} initialRoute="workspace" />);

    await user.click(screen.getByRole('button', { name: /05 实施保障/ }));
    const button = screen.getByRole('button', { name: '重新打开' });
    expect(button).toBeDisabled();
    await user.click(button);
    expect(reopen).not.toHaveBeenCalled();
  });

  it('renders and submits answers for every App Server question', async () => {
    const user = userEvent.setup();
    const base = createDemoDesktopAdapter();
    const respondToTaskInput = vi.fn(async () => ({ status: '已提交全部回答。' }));
    const adapter: DesktopAdapter = {
      ...base,
      async startTask(prompt) {
        return {
          id: 'multi-input-task',
          prompt,
          status: 'waiting_for_input',
          transcript: [{ role: 'user', text: prompt }],
          usage: '0 tokens',
          error: null,
          pendingInteraction: {
            requestId: 'input-multi',
            kind: 'user_input',
            params: {
              questions: [
                {
                  id: 'tone',
                  header: '表达风格',
                  question: '使用什么语气？',
                  options: [
                    { label: '简洁', description: '直接给出结论' },
                    { label: '详细', description: '补充解释' },
                  ],
                },
                {
                  id: 'audience',
                  header: '目标受众',
                  question: '主要面向谁？',
                  options: [
                    { label: '管理层', description: '突出经营判断' },
                    { label: '研发团队', description: '突出执行细节' },
                  ],
                },
              ],
            },
          },
        };
      },
      respondToTaskInput,
    };
    render(<App adapter={adapter} initialRoute="tasks" />);
    await user.click(screen.getByRole('button', { name: /开始任务/ }));

    expect(screen.getByRole('group', { name: '表达风格' })).toHaveTextContent(
      '使用什么语气？',
    );
    expect(screen.getByText('直接给出结论')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: '目标受众' })).toHaveTextContent(
      '主要面向谁？',
    );
    await user.click(screen.getByLabelText('简洁'));
    await user.click(screen.getByLabelText('管理层'));
    await user.click(screen.getByRole('button', { name: '提交回答' }));

    expect(respondToTaskInput).toHaveBeenCalledWith('multi-input-task', {
      tone: ['简洁'],
      audience: ['管理层'],
    });
  });

  it('shows unavailable instead of empty-success copy for native collections', async () => {
    const user = userEvent.setup();
    const demo = createDemoDesktopAdapter();
    const nativeLike = {
      ...demo,
      mode: 'tauri',
      initialState: {
        ...demo.initialState,
        projects: [],
        approvals: [],
        memories: [],
        collections: {
          projects: 'unavailable',
          approvals: 'unavailable',
          memories: 'unavailable',
        },
      },
      async loadInitialState() {
        return structuredClone(this.initialState);
      },
    } as DesktopAdapter;
    render(<App adapter={nativeLike} initialRoute="approvals" />);

    expect(screen.getByText('审批数据不可用')).toBeInTheDocument();
    expect(screen.queryByText('所有审批都已处理。')).not.toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: '偏好记忆' }));
    expect(screen.getByText('偏好记忆数据不可用')).toBeInTheDocument();
  });

  it('shows an explicit empty state when the loaded memory collection is empty', () => {
    const demo = createDemoDesktopAdapter();
    const adapter = {
      ...demo,
      initialState: {
        ...demo.initialState,
        memories: [],
        collections: { ...demo.initialState.collections, memories: 'loaded' },
      },
    } as DesktopAdapter;

    render(<App adapter={adapter} initialRoute="memory" />);

    expect(screen.getByText('当前没有偏好记忆。')).toBeInTheDocument();
    expect(screen.queryByText('偏好记忆数据不可用')).not.toBeInTheDocument();
  });

  it('persists settings across route navigation after saving', async () => {
    const user = userEvent.setup();
    const adapter = createDemoDesktopAdapter();
    const save = vi.spyOn(adapter, 'saveSettings');
    render(<App adapter={adapter} initialRoute="settings" />);

    await user.clear(screen.getByLabelText('默认工作区路径'));
    await user.type(screen.getByLabelText('默认工作区路径'), '/tmp/persisted');
    await user.clear(screen.getByLabelText('Codex 可执行路径'));
    await user.type(screen.getByLabelText('Codex 可执行路径'), '/usr/local/bin/codex');
    await user.click(screen.getByRole('button', { name: '保存设置' }));
    expect(save).toHaveBeenCalledWith({
      workspacePath: '/tmp/persisted',
      codexPath: '/usr/local/bin/codex',
    });
    await user.click(screen.getByRole('link', { name: '首页' }));
    await user.click(screen.getByRole('link', { name: '设置' }));

    expect(screen.getByLabelText('默认工作区路径')).toHaveValue('/tmp/persisted');
    expect(screen.getByLabelText('Codex 可执行路径')).toHaveValue(
      '/usr/local/bin/codex',
    );
  });
});
