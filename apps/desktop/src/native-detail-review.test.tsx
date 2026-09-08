/* @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NativeWorkspacePage } from './native-workspace.js';
import { detailTestHarness } from './native-detail-test-support.js';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
async function setup() {
  const h = await detailTestHarness(); const onBack = vi.fn(); const onDirtyChange = vi.fn();
  const mount = (standalone = false) => render(<NativeWorkspacePage adapter={h.adapter} projectId={h.id} projectName="合成复盘" projectGoal="验证人工编辑" onBack={onBack} onDirtyChange={standalone ? undefined : onDirtyChange} />);
  return { ...h, mount, onBack, onDirtyChange };
}
describe('document detail review integration', () => {
  it('keeps an off-page edit failure visible after the initial persisted load', async () => {
    const h = await setup(); h.controls.failCommit = true; const before = h.getStored();
    await expect(h.adapter.saveDetails(h.id, before.slideSpecs!.value, before.revision)).rejects.toThrow('磁盘暂时不可用');
    h.mount(); await screen.findByRole('textbox', { name: '第 1 页正文第 1 段' });
    expect(screen.getByRole('alert')).toHaveTextContent('磁盘暂时不可用');
  });
  it('replays a running save through remount without a second write', async () => {
    const h = await setup(); let finish!: () => void;
    h.controls.holdCommit = new Promise<void>((resolve) => { finish = resolve; });
    const view = h.mount();
    fireEvent.change(await screen.findByRole('textbox', { name: '第 1 页正文第 1 段' }), { target: { value: '跨页面保存正文' } });
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
    await waitFor(() => expect(h.commits).toHaveLength(1)); view.unmount(); h.mount();
    expect(await screen.findByRole('textbox', { name: '第 1 页正文第 1 段' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '批准全部细化' })).toBeDisabled();
    await act(async () => { finish(); });
    await waitFor(() => expect(screen.getByRole('textbox', { name: '第 1 页正文第 1 段' })).toHaveValue('跨页面保存正文'));
    expect(h.commits).toEqual([5]);
  });
  it('reconciles uncertain commits after remount without allowing another approval', async () => {
    const h = await setup(); const view = h.mount(); h.controls.loseResponse = true; h.controls.failReconcile = true;
    fireEvent.change(await screen.findByRole('textbox', { name: '第 1 页正文第 1 段' }), { target: { value: '响应丢失的已存正文' } });
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
    expect(await screen.findByRole('button', { name: '核实并重试原操作' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '批准全部细化' })).toBeDisabled();
    view.unmount(); h.mount();
    await waitFor(() => expect(screen.getByRole('button', { name: '核实并重试原操作' })).toBeEnabled());
    h.controls.failLoad = false;
    fireEvent.click(screen.getByRole('button', { name: '核实并重试原操作' }));
    expect(await screen.findByRole('textbox', { name: '第 1 页正文第 1 段' })).toHaveValue('响应丢失的已存正文');
    expect(h.commits).toEqual([5]); expect(h.getStored().approvals).toHaveLength(1);
  });
  it('restores pending structure on cold load and cancels its content only after confirmation', async () => {
    const h = await setup(); const before = h.getStored();
    const value = { outline: structuredClone(before.outline!.value), specs: structuredClone(before.slideSpecs!.value) };
    value.outline.slides = [...value.outline.slides].reverse(); value.specs = [...value.specs].reverse(); value.specs[0]!.body = ['结构修订中的正文'];
    await h.adapter.saveOutlineRevision(h.id, { id: 'revision-cancel', baseOutlineVersionId: before.outline!.version.id,
      ...value, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, before.revision);
    h.mount();
    expect(await screen.findByRole('textbox', { name: '第 1 页正文第 1 段' })).toHaveValue('结构修订中的正文');
    fireEvent.click(screen.getByRole('button', { name: '放弃结构修订' }));
    expect(h.getStored().outlineRevisionDraft).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '确认放弃结构与内容修改' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '批准全部细化' })).toBeEnabled());
    expect(h.getStored().slideSpecs).toEqual(before.slideSpecs); expect(h.getStored().approvals).toEqual(before.approvals);
    expect(h.getStored().revisionHistory?.[0]?.status).toBe('cancelled');
    expect(screen.getByText('结构修订历史（只读）')).toBeInTheDocument();
  });
  it('preserves stale input and requires explicit discard before loading a newer checkpoint', async () => {
    const h = await setup(); h.mount();
    fireEvent.change(await screen.findByRole('textbox', { name: '第 1 页正文第 1 段' }), { target: { value: '我的未保存正文' } });
    const before = h.getStored(); const otherSpecs = structuredClone(before.slideSpecs!.value); otherSpecs[0]!.body = ['其他操作的正文'];
    // Simulates a background editor delivering a newer persisted checkpoint.
    await act(async () => { await h.adapter.saveDetails(h.id, otherSpecs, before.revision); });
    expect(screen.getByRole('textbox', { name: '第 1 页正文第 1 段' })).toHaveValue('我的未保存正文');
    expect(screen.getByRole('button', { name: '保存修改' })).toBeDisabled();
    const discard = screen.getByRole('button', { name: '放弃修改并载入最新版本' });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false); fireEvent.click(discard);
    expect(screen.getByRole('textbox', { name: '第 1 页正文第 1 段' })).toHaveValue('我的未保存正文');
    confirm.mockReturnValue(true); fireEvent.click(discard);
    await waitFor(() => expect(screen.getByRole('textbox', { name: '第 1 页正文第 1 段' })).toHaveValue('其他操作的正文'));
  });
  it('offers conflict recovery when the native baseline changes without a UI notification', async () => {
    const h = await setup(); h.mount();
    fireEvent.change(await screen.findByRole('textbox', { name: '第 1 页正文第 1 段' }), { target: { value: '我的陈旧正文' } });
    // Keep the externally saved pipeline valid using another isolated strict runtime.
    const other = await detailTestHarness(); const next = await other.adapter.saveDetails(other.id, other.getStored().slideSpecs!.value, 5);
    h.setStored(next);
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
    expect(await screen.findByRole('button', { name: '放弃修改并载入最新版本' })).toBeEnabled();
    expect(screen.getByRole('textbox', { name: '第 1 页正文第 1 段' })).toHaveValue('我的陈旧正文');
  });
  it('edits actual paragraphs, guards navigation and approval, and persists across remount without approving', async () => {
    const h = await setup(); const view = h.mount();
    const body = await screen.findByRole('textbox', { name: '第 1 页正文第 1 段' });
    expect(body).toHaveValue('原文第一段\n保留换行');
    expect(screen.queryByRole('textbox', { name: '逐页细化 JSON' })).not.toBeInTheDocument();
    fireEvent.change(body, { target: { value: '用户已保存的正文' } });
    expect(screen.getByRole('button', { name: '批准全部细化' })).toBeDisabled();
    expect(h.onDirtyChange).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '批准全部细化' })).toBeEnabled());
    expect(h.getStored().approvals).toHaveLength(1);
    view.unmount(); h.mount();
    expect(await screen.findByRole('textbox', { name: '第 1 页正文第 1 段' })).toHaveValue('用户已保存的正文');
  });
  it('saves a title as pending structure and confirms only the new outline', async () => {
    const h = await setup(); h.mount();
    const review = await screen.findByRole('region', { name: '审核全部页面细化' });
    fireEvent.change(within(review).getByRole('textbox', { name: '第 1 页标题' }), { target: { value: '新页面标题' } });
    expect(screen.getByRole('button', { name: '保存修改' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
    await waitFor(() => expect(h.getStored().outlineRevisionDraft, screen.queryByRole('alert')?.textContent ?? '').toBeTruthy());
    const confirm = await screen.findByRole('button', { name: '确认结构变更' });
    await waitFor(() => expect(confirm).toBeEnabled());
    expect(h.getStored().outline!.value.slides[0]!.title).toBe('第一页');
    expect(h.getStored().approvals).toHaveLength(1);
    expect(screen.getByRole('button', { name: '批准全部细化' })).toBeDisabled();
    fireEvent.click(confirm);
    await waitFor(() => expect(screen.getByRole('button', { name: '批准全部细化' })).toBeEnabled());
    expect(h.getStored().outline!.value.slides[0]!.title).toBe('新页面标题');
    expect(h.getStored().slideSpecs!.version.status).toBe('draft');
    expect(h.getStored().approvals).toHaveLength(2);
  });
  it('retains all input when saving fails and confirms standalone navigation loss', async () => {
    const h = await setup(); h.controls.failCommit = true; h.mount(true);
    fireEvent.change(await screen.findByRole('textbox', { name: '第 1 页正文第 1 段' }), { target: { value: '尚未保存正文' } });
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('磁盘暂时不可用');
    expect(screen.getByRole('textbox', { name: '第 1 页正文第 1 段' })).toHaveValue('尚未保存正文');
    expect(screen.getByRole('button', { name: '批准全部细化' })).toBeDisabled();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    fireEvent.click(screen.getByRole('button', { name: '返回 PPT 项目' })); expect(h.onBack).not.toHaveBeenCalled();
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('逐页细化'));
    confirm.mockReturnValue(true); fireEvent.click(screen.getByRole('button', { name: '返回 PPT 项目' })); expect(h.onBack).toHaveBeenCalledOnce();
  });
});
