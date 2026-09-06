/* @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App.js';
import { createDemoDesktopAdapter, type ConnectionSummary, type DesktopAdapter } from './desktop-adapter.js';

const connected: ConnectionSummary = {
  account: { status: 'connected', email: 'person@example.com', plan: 'pro' },
  runtime: {
    status: 'connected', detail: '已连接本机 Codex App Server · ChatGPT pro',
    address: 'stdio（本机进程）', model: null, uptime: null, queue: null,
  },
};
const disconnected: ConnectionSummary = {
  account: { status: 'unavailable', email: null, plan: null },
  runtime: {
    status: 'unavailable', detail: 'Codex 连接已中断，请检查连接。',
    address: null, model: null, uptime: null, queue: null,
  },
};

// Only the external adapter is controlled; App navigation, hydration and store are real.
function connectionFixture(next: ConnectionSummary = connected) {
  const demo = createDemoDesktopAdapter();
  const initial = {
    ...structuredClone(demo.initialState), ...structuredClone(disconnected),
    projects: [], approvals: [], memories: [],
  };
  let current = disconnected;
  const listeners = new Set<(value: ConnectionSummary) => void>();
  const publish = (value: ConnectionSummary) => {
    current = value;
    for (const listener of listeners) listener(value);
  };
  const adapter: DesktopAdapter = {
    ...demo, mode: 'tauri', initialState: initial,
    loadInitialState: async () => structuredClone(initial),
    subscribeConnection(listener) {
      listeners.add(listener);
      listener(current);
      return () => { listeners.delete(listener); };
    },
    async connectAccount() { publish(next); return next.account; },
  };
  return { adapter, publish };
}

afterEach(() => { cleanup(); window.history.replaceState({}, '', '#/dashboard'); });

describe('shared Codex connection UI', () => {
  it('replaces the dashboard placeholder after the startup read and keeps settings consistent', async () => {
    const user = userEvent.setup();
    const { adapter } = connectionFixture();
    render(<App adapter={adapter} initialRoute="dashboard" />);

    expect(await screen.findByText('已连接')).toBeInTheDocument();
    expect(screen.getByText('stdio（本机进程）')).toBeInTheDocument();
    expect(screen.queryByText('不可用')).not.toBeInTheDocument();
    expect(screen.getAllByText('未提供')).toHaveLength(3);
    await user.click(screen.getByRole('link', { name: '设置' }));
    expect(screen.getByText('person@example.com · pro')).toBeInTheDocument();
    expect(screen.getByText(connected.runtime.detail)).toBeInTheDocument();
  });

  it('shows a connected service while requiring login before starting tasks', async () => {
    const user = userEvent.setup();
    const { adapter } = connectionFixture({
      runtime: { ...connected.runtime, detail: '服务已连接，等待 ChatGPT 登录。' },
      account: { status: 'logged_out', email: null, plan: null },
    });
    render(<App adapter={adapter} initialRoute="dashboard" />);
    expect(await screen.findByText('已连接')).toBeInTheDocument();
    expect(screen.getByText('服务已连接，等待 ChatGPT 登录。')).toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: '通用任务' }));
    expect(screen.getByText('尚未登录')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /开始任务/ })).toBeDisabled();
    expect(screen.getByText('尚未登录').querySelector('.connection-dot')).toHaveAttribute('data-connected', 'false');
  });

  it('disables tasks on disconnect and refreshes every page after checking again', async () => {
    const user = userEvent.setup();
    const { adapter, publish } = connectionFixture();
    render(<App adapter={adapter} initialRoute="tasks" />);
    expect(await screen.findByText('person@example.com · pro')).toBeInTheDocument();
    act(() => publish(disconnected));
    expect(screen.getByRole('button', { name: /开始任务/ })).toBeDisabled();
    await user.click(screen.getByRole('link', { name: '首页' }));
    const aside = screen.getByRole('complementary', { name: '活动状态' });
    expect(within(aside).getByText('不可用')).toBeInTheDocument();
    expect(within(aside).getByText('不可用').querySelector('.connection-dot')).toHaveAttribute('data-connected', 'false');
    await user.click(screen.getByRole('link', { name: '通用任务' }));
    await user.click(screen.getByRole('button', { name: '检查连接' }));
    expect(screen.getByRole('button', { name: /开始任务/ })).toBeEnabled();
    await user.click(screen.getByRole('link', { name: '首页' }));
    expect(screen.getByText('已连接')).toBeInTheDocument();
    expect(screen.queryByText(disconnected.runtime.detail)).not.toBeInTheDocument();
  });

  it('can still check the account when loading project state fails', async () => {
    const user = userEvent.setup();
    const { adapter } = connectionFixture();
    adapter.loadInitialState = async () => { throw new Error('项目状态暂时无法读取'); };
    render(<App adapter={adapter} initialRoute="tasks" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('项目状态暂时无法读取');
    await user.click(screen.getByRole('button', { name: '检查连接' }));
    expect(await screen.findByText('person@example.com · pro')).toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: '首页' }));
    expect(screen.getByText('已连接')).toBeInTheDocument();
  });
});
