/* @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import { createDemoDesktopAdapter } from './desktop-adapter.js';
import { derivePendingPptApprovals } from './collection-read-model.js';
import { detailTestHarness } from './native-detail-test-support.js';

afterEach(() => { cleanup(); vi.restoreAllMocks(); window.history.replaceState({}, '', '#/dashboard'); });
async function setup() {
  const h = await detailTestHarness();
  const initialState = structuredClone(createDemoDesktopAdapter().initialState);
  initialState.projects = [{ id: h.id, name: '合成复盘', goal: '验证人工编辑', stage: '逐页细化', workflowStatus: 'detail_review', progress: 40, updatedAt: '2026-09-01T00:04:00.000Z' }];
  initialState.approvals = derivePendingPptApprovals([h.getStored()]); initialState.memories = [];
  Object.assign(h.adapter, { initialState,
    loadInitialState: async () => structuredClone(initialState),
    listProjects: async () => structuredClone(initialState.projects),
    loadCollections: async () => ({ approvals: derivePendingPptApprovals([h.getStored()]), memories: [], availability: { approvals: 'loaded', memories: 'loaded' } }),
  });
  window.history.replaceState({}, '', `#/workspace/${h.id}`);
  render(<App adapter={h.adapter} />);
  await screen.findByRole('textbox', { name: '第 1 页正文第 1 段' });
  return h;
}
describe('App detail navigation and persisted approval routing', () => {
  it('protects dirty detail input on sidebar, history and standard unload', async () => {
    const h = await setup(); const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    fireEvent.change(screen.getByRole('textbox', { name: '第 1 页正文第 1 段' }), { target: { value: '不能丢失的正文' } });
    fireEvent.click(screen.getByRole('link', { name: '审批中心' }));
    expect(window.location.hash).toBe(`#/workspace/${h.id}`);
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('逐页细化'));
    act(() => { window.history.replaceState({}, '', '#/approvals'); window.dispatchEvent(new PopStateEvent('popstate')); });
    expect(window.location.hash).toBe(`#/workspace/${h.id}`);
    expect(screen.getByRole('textbox', { name: '第 1 页正文第 1 段' })).toHaveValue('不能丢失的正文');
    const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); expect(event.defaultPrevented).toBe(true);
  });
  it('refreshes approval center when a structure save finishes after leaving its workspace', async () => {
    const h = await setup(); let finish!: () => void;
    h.controls.holdCommit = new Promise<void>((resolve) => { finish = resolve; });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.change(within(screen.getByRole('region', { name: '审核全部页面细化' })).getByRole('textbox', { name: '第 1 页标题' }), { target: { value: '新标题' } });
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
    await waitFor(() => expect(h.commits).toHaveLength(1));
    fireEvent.click(screen.getByRole('link', { name: '审批中心' }));
    expect(await screen.findByRole('heading', { name: '审批中心' })).toBeInTheDocument();
    await act(async () => { finish(); });
    expect(await screen.findByText('大纲结构修订待确认')).toBeInTheDocument();
    expect(screen.queryByText('全部页面细化待审核')).not.toBeInTheDocument();
    expect(h.getStored().approvals).toHaveLength(1);
  });
});
