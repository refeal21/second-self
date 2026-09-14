// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Gallery } from './Gallery.js';
import { GalleryImage } from './GalleryImage.js';
import type { GalleryModel, GalleryProps } from './model.js';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const image = (id: string) => ({ id, sha256: `${id}-sha` });
const base: GalleryModel = {
  pages: [
    { id: 'a', number: 1, title: '开场', summary: '项目定位', currentDeliveryVersionId: null, candidateVersionId: null,
      versions: [], job: { state: 'running', label: '生成中' }, eligibility: { generate: null, edit: '正在生成', adopt: '无候选稿', restore: '无历史稿', approve: '无候选稿' } },
    { id: 'b', number: 2, title: '机会', summary: '机会说明', currentDeliveryVersionId: null, candidateVersionId: 'b2',
      versions: [{ id: 'b1', revision: 1, label: '初稿', image: image('b1'), manualRevision: 0, approved: true },
        { id: 'b2', revision: 2, label: '候选稿', image: image('b2'), manualRevision: 1, approved: false }],
      job: { state: 'idle' }, eligibility: { generate: null, edit: null, adopt: null, restore: null, approve: null } },
    { id: 'c', number: 3, title: '方案', summary: '方案说明', currentDeliveryVersionId: null, candidateVersionId: null,
      versions: [], job: { state: 'queued', label: '排队中', cancelReason: '队列未确认取消' },
      eligibility: { generate: '已排队', edit: '无候选稿', adopt: '无候选稿', restore: '无历史稿', approve: '无候选稿' } },
  ],
  savedFeedback: {}, queue: { concurrency: 2, paused: false, pauseReason: null, resumeReason: null, generateAllMissingReason: null },
  capabilityReasons: { reference: '暂不支持参考图编辑', edit: null },
};

function props(overrides: Partial<GalleryProps> = {}): GalleryProps {
  return { model: base, loadImage: vi.fn(async () => 'data:image/png;base64,aGVsbG8='),
    onGenerate: vi.fn(async () => {}), onEdit: vi.fn(async () => {}), onAdopt: vi.fn(async () => {}),
    onRestore: vi.fn(async () => {}), onApprove: vi.fn(async () => {}), onSaveFeedback: vi.fn(async (_ref, text: string) => ({ text, revision: 1 })),
    onQueueChange: vi.fn(async () => {}), onBatchGenerate: vi.fn(async () => {}), onDirtyChange: vi.fn(), ...overrides };
}

describe('Gallery', () => {
  it('keeps B selected while A runs and allows B edit and exact-version approval without submitting a new draft', async () => {
    const user = userEvent.setup(); const pending = deferred();
    const onEdit = vi.fn(() => pending.promise); const onApprove = vi.fn(async () => {});
    const input = props({ onEdit, onApprove });
    const { rerender } = render(<Gallery {...input} />);
    await user.click(screen.getByRole('button', { name: /第 2 页 机会/ }));
    expect(screen.getByText('候选稿 · 修订 2')).toBeVisible();
    await user.click(screen.getByRole('button', { name: '编辑此版本' }));
    expect(onEdit).toHaveBeenCalledWith({ pageId: 'b', versionId: 'b2', revision: 2 });
    expect(screen.getByRole('button', { name: /第 1 页 开场/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: '批准此版本' })).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: /已人工核对第 2 页候选稿修订 2/ }));
    expect(screen.getByRole('button', { name: '批准此版本' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: '批准此版本' }));
    expect(onApprove).toHaveBeenCalledWith({ pageId: 'b', versionId: 'b2', revision: 2 });
    rerender(<Gallery {...input} model={{ ...base, pages: base.pages.map(p => p.id === 'a' ? { ...p, job: { state: 'idle' } } : p) }} />);
    expect(screen.getByRole('heading', { name: /第 2 页 · 机会/ })).toBeVisible();
    pending.resolve();
  });

  it('inspects history without adoption, then requires explicit adoption or restoration', async () => {
    const user = userEvent.setup(); const onAdopt = vi.fn(async () => {}); const onRestore = vi.fn(async () => {});
    render(<Gallery {...props({ onAdopt, onRestore })} />);
    await user.click(screen.getByRole('button', { name: /第 2 页 机会/ }));
    expect(screen.getByRole('button', { name: '恢复此前批准' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: /查看初稿 修订 1/ }));
    expect(screen.getByText('历史版本 · 修订 1')).toBeVisible();
    expect(onAdopt).not.toHaveBeenCalled(); expect(onRestore).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '选择用于交付' }));
    expect(onAdopt).toHaveBeenCalledWith({ pageId: 'b', versionId: 'b1', revision: 1 });
    await user.click(screen.getByRole('button', { name: '恢复此前批准' }));
    expect(onRestore).toHaveBeenCalledWith({ pageId: 'b', versionId: 'b1', revision: 1 });
  });

  it('retains typed feedback through save conflict and unrelated updates, then restores host-saved feedback after remount', async () => {
    const user = userEvent.setup(); const onDirtyChange = vi.fn();
    const onSaveFeedback = vi.fn().mockRejectedValueOnce(new Error('版本冲突')).mockResolvedValue({ text: '请加强对比', revision: 1 });
    const input = props({ onSaveFeedback, onDirtyChange });
    const { rerender, unmount } = render(<Gallery {...input} />);
    await user.click(screen.getByRole('button', { name: /第 2 页 机会/ }));
    await user.type(screen.getByRole('textbox', { name: '此版本反馈' }), '请加强对比');
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    await user.click(screen.getByRole('button', { name: '保存反馈' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('版本冲突');
    expect(screen.getByRole('textbox', { name: '此版本反馈' })).toHaveValue('请加强对比');
    rerender(<Gallery {...input} model={{ ...base, pages: [...base.pages] }} />);
    expect(screen.getByRole('textbox', { name: '此版本反馈' })).toHaveValue('请加强对比');
    await user.click(screen.getByRole('button', { name: '保存反馈' }));
    expect(onSaveFeedback).toHaveBeenLastCalledWith({ pageId: 'b', versionId: 'b2', revision: 2 }, '请加强对比');
    unmount();
    render(<Gallery {...props({ model: { ...base, savedFeedback: { 'b:b2:2': { text: '请加强对比', revision: 2 } } } })} />);
    await user.click(screen.getByRole('button', { name: /第 2 页 机会/ }));
    expect(screen.getByRole('textbox', { name: '此版本反馈' })).toHaveValue('请加强对比');
  });

  it('shows five manual revisions and missing historical image metadata without image load', async () => {
    const user = userEvent.setup(); const loadImage = vi.fn(async () => 'data:image/png;base64,aGVsbG8=');
    const versions = Array.from({ length: 5 }, (_, i) => ({ id: `b${i+1}`, revision: i+1, label: `手工修订 ${i+1}`, image: i === 0 ? null : image(`b${i+1}`), missingReason: i === 0 ? '原图已清理' : undefined, manualRevision: i+1, approved: i === 0 }));
    render(<Gallery {...props({ loadImage, model: { ...base, pages: base.pages.map(p => p.id === 'b' ? { ...p, candidateVersionId: 'b5', versions } : p) } })} />);
    await user.click(screen.getByRole('button', { name: /第 2 页 机会/ }));
    expect(screen.getAllByRole('button', { name: /查看手工修订/ })).toHaveLength(5);
    await user.click(screen.getByRole('button', { name: /查看手工修订 1 修订 1/ }));
    expect(screen.getByText('原图已清理')).toBeVisible();
    expect(loadImage).not.toHaveBeenCalledWith(image('b1'));
  });

  it('requires batch confirmation, reports disabled reasons, and keeps queued cancellation gated', async () => {
    const user = userEvent.setup(); const onBatchGenerate = vi.fn(async () => {}); const onQueueChange = vi.fn(async () => {});
    render(<Gallery {...props({ onBatchGenerate, onQueueChange })} />);
    await user.click(screen.getByRole('checkbox', { name: /选择第 2 页/ }));
    await user.click(screen.getByRole('button', { name: '批量生成所选页' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('替换');
    expect(onBatchGenerate).not.toHaveBeenCalled();
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '确认批量生成' }));
    expect(onBatchGenerate).toHaveBeenCalledWith({ pageIds: ['b'], replaceCandidates: true });
    expect(screen.getByText('队列未确认取消')).toBeVisible();
    fireEvent.change(screen.getByRole('spinbutton', { name: '并发数' }), { target: { value: '4' } });
    expect(onQueueChange).toHaveBeenCalledWith({ concurrency: 4 });
  });

  it('loads only the selected preview when offscreen thumbnails are not intersecting', async () => {
    const user = userEvent.setup(); const loadImage = vi.fn(async () => 'data:image/png;base64,aGVsbG8=');
    const unique = { id: 'b2-lazy', sha256: 'b2-lazy-sha' };
    const model = { ...base, pages: base.pages.map(p => p.id === 'b' ? { ...p, versions: p.versions.map(v => v.id === 'b2' ? { ...v, image: unique } : v) } : p) };
    render(<Gallery {...props({ loadImage, model })} />);
    expect(loadImage).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: /第 2 页 机会/ }));
    await waitFor(() => expect(loadImage).toHaveBeenCalledWith(unique));
    expect(loadImage).not.toHaveBeenCalledWith(image('b1'));
  });

  it('requires explicit replacement confirmation before single-page generation', async () => {
    const user = userEvent.setup(); const onGenerate = vi.fn(async () => {});
    render(<Gallery {...props({ onGenerate })} />);
    await user.click(screen.getByRole('button', { name: /第 2 页 机会/ }));
    await user.click(screen.getByRole('button', { name: '生成新稿' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('替换候选稿');
    expect(onGenerate).not.toHaveBeenCalled();
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '确认批量生成' }));
    expect(onGenerate).toHaveBeenCalledWith('b', true);
  });

  it('does not carry feedback onto a changed revision of the same version identity', async () => {
    const user = userEvent.setup(); const input = props();
    const { rerender } = render(<Gallery {...input} />);
    await user.click(screen.getByRole('button', { name: /第 2 页 机会/ }));
    await user.type(screen.getByRole('textbox', { name: '此版本反馈' }), '针对修订二');
    const updated: GalleryModel = { ...base, pages: base.pages.map(p => p.id === 'b' ? {
      ...p, versions: p.versions.map(v => v.id === 'b2' ? { ...v, revision: 3, image: image('b2-revision-3') } : v),
    } : p) };
    rerender(<Gallery {...input} model={updated} />);
    expect(screen.getByRole('textbox', { name: '此版本反馈' })).toHaveValue('');
    expect(screen.getByRole('button', { name: '批准此版本' })).toBeDisabled();
  });

  it('gates cancel and retry by authoritative job state as well as capability reason', async () => {
    const user = userEvent.setup(); const onCancelJob = vi.fn(async () => {}); const onRetryJob = vi.fn(async () => {});
    render(<Gallery {...props({ onCancelJob, onRetryJob })} />);
    expect(screen.getByRole('button', { name: '取消任务' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '重试任务' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: /第 2 页 机会/ }));
    expect(screen.getByRole('button', { name: '取消任务' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '重试任务' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: /第 3 页 方案/ }));
    expect(screen.getByRole('button', { name: '取消任务' })).toBeDisabled();
    expect(screen.getByText('队列未确认取消')).toBeVisible();
    expect(onCancelJob).not.toHaveBeenCalled(); expect(onRetryJob).not.toHaveBeenCalled();
  });

  it('rejects a stale image promise after immutable identity changes', async () => {
    const old = deferred<string>(); const next = deferred<string>();
    const oldImage = { id: 'stale-test', sha256: 'old-sha' };
    const nextImage = { id: 'stale-test', sha256: 'next-sha' };
    const loadImage = vi.fn((identity: typeof oldImage) => identity.sha256 === 'old-sha' ? old.promise : next.promise);
    const { rerender } = render(<GalleryImage image={oldImage} loadImage={loadImage} alt="版本预览" priority />);
    rerender(<GalleryImage image={nextImage} loadImage={loadImage} alt="版本预览" priority />);
    await act(async () => old.resolve('data:image/png;base64,b2xk'));
    expect(screen.queryByRole('img', { name: '版本预览' })).not.toBeInTheDocument();
    await act(async () => next.resolve('data:image/png;base64,bmV3'));
    expect(screen.getByRole('img', { name: '版本预览' })).toHaveAttribute('src', 'data:image/png;base64,bmV3');
  });

  it('bounds decoded URL caching instead of retaining every historical image', async () => {
    const loadImage = vi.fn(async () => 'data:image/png;base64,Y2FjaGU=');
    const identity = (index: number) => ({ id: `cache-bound-${index}`, sha256: `sha-${index}` });
    const { rerender } = render(<GalleryImage image={identity(0)} loadImage={loadImage} alt="预览0" priority />);
    for (let index = 0; index < 25; index += 1) {
      if (index) rerender(<GalleryImage image={identity(index)} loadImage={loadImage} alt={`预览${index}`} priority />);
      await waitFor(() => expect(screen.getByRole('img', { name: `预览${index}` })).toBeInTheDocument());
    }
    expect(loadImage).toHaveBeenCalledTimes(25);
    rerender(<GalleryImage image={identity(0)} loadImage={loadImage} alt="再次预览" priority />);
    await waitFor(() => expect(loadImage).toHaveBeenCalledTimes(26));
  });

  it('excludes running and queued pages from generate-all-missing even when generation is otherwise eligible', () => {
    render(<Gallery {...props()} />);
    expect(screen.getByRole('button', { name: '生成全部缺失页' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '生成新稿' })).toBeDisabled();
    expect(screen.getByText(/生成：正在生成/)).toBeVisible();
  });

  it('keeps an action error on its page instead of interrupting another page', async () => {
    const user = userEvent.setup();
    render(<Gallery {...props({ onEdit: vi.fn(async () => { throw new Error('编辑暂不可用'); }) })} />);
    await user.click(screen.getByRole('button', { name: /第 2 页 机会/ }));
    await user.click(screen.getByRole('button', { name: '编辑此版本' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('编辑暂不可用');
    await user.click(screen.getByRole('button', { name: /第 1 页 开场/ }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('blocks overlapping generation paths for B while permitting a different page to generate', async () => {
    const user = userEvent.setup(); const running = deferred();
    const onGenerate = vi.fn(() => running.promise); const onBatchGenerate = vi.fn(async () => {});
    const d = { ...base.pages[1]!, id: 'd', number: 4, title: '成果', candidateVersionId: 'd1',
      versions: [{ id: 'd1', revision: 1, label: '候选稿', manualRevision: 0, approved: false, image: image('d1') }] };
    render(<Gallery {...props({ model: { ...base, pages: [...base.pages, d] }, onGenerate, onBatchGenerate })} />);
    await user.click(screen.getByRole('button', { name: /第 2 页 机会/ }));
    await user.click(screen.getByRole('button', { name: '生成新稿' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '确认批量生成' }));
    expect(onGenerate).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('checkbox', { name: '选择第 2 页' }));
    expect(screen.getByRole('button', { name: '批量生成所选页' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '生成新稿' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '编辑此版本' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: /第 4 页 成果/ }));
    expect(screen.getByRole('button', { name: '生成新稿' })).toBeEnabled();
    expect(onBatchGenerate).not.toHaveBeenCalled();
    await act(async () => running.resolve());
  });

  it('allows a disjoint batch while another batch is awaiting its callback', async () => {
    const user = userEvent.setup(); const first = deferred();
    const onBatchGenerate = vi.fn((batch: { pageIds: string[] }) => batch.pageIds[0] === 'b' ? first.promise : Promise.resolve());
    const d = { ...base.pages[1]!, id: 'd', number: 4, title: '成果', candidateVersionId: 'd1',
      versions: [{ id: 'd1', revision: 1, label: '候选稿', manualRevision: 0, approved: false, image: image('d1') }] };
    render(<Gallery {...props({ model: { ...base, pages: [...base.pages, d] }, onBatchGenerate })} />);
    await user.click(screen.getByRole('checkbox', { name: '选择第 2 页' }));
    await user.click(screen.getByRole('button', { name: '批量生成所选页' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '确认批量生成' }));
    await user.click(screen.getByRole('checkbox', { name: '选择第 2 页' }));
    await user.click(screen.getByRole('checkbox', { name: '选择第 4 页' }));
    expect(screen.getByRole('button', { name: '批量生成所选页' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: '批量生成所选页' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '确认批量生成' }));
    expect(onBatchGenerate).toHaveBeenCalledTimes(2);
    expect(onBatchGenerate).toHaveBeenNthCalledWith(2, { pageIds: ['d'], replaceCandidates: true });
    await act(async () => first.resolve());
  });

  it('treats a pending edit as generation work for that page only', async () => {
    const user = userEvent.setup(); const running = deferred();
    const onEdit = vi.fn(() => running.promise);
    render(<Gallery {...props({ onEdit })} />);
    await user.click(screen.getByRole('button', { name: /第 2 页 机会/ }));
    await user.click(screen.getByRole('button', { name: '编辑此版本' }));
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: '生成新稿' })).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: '选择第 2 页' }));
    expect(screen.getByRole('button', { name: '批量生成所选页' })).toBeDisabled();
    await act(async () => running.resolve());
  });

  it('requires fresh replacement confirmation when a candidate appears while the dialog is open', async () => {
    const user = userEvent.setup(); const onGenerate = vi.fn(async () => {});
    const d = { ...base.pages[1]!, id: 'd', number: 4, title: '成果', candidateVersionId: null, versions: [] };
    const first: GalleryModel = { ...base, pages: [...base.pages, d] };
    const { rerender } = render(<Gallery {...props({ model: first, onGenerate })} />);
    await user.click(screen.getByRole('button', { name: /第 4 页 成果/ }));
    await user.click(screen.getByRole('button', { name: '生成新稿' }));
    expect(screen.getByRole('dialog')).not.toHaveTextContent('替换候选稿');
    const updated: GalleryModel = { ...first, pages: first.pages.map(p => p.id === 'd' ? {
      ...p, candidateVersionId: 'd1', versions: [{ id: 'd1', revision: 1, label: '新候选稿', manualRevision: 0, approved: false, image: image('d1') }],
    } : p) };
    rerender(<Gallery {...props({ model: updated, onGenerate })} />);
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '确认批量生成' }));
    expect(onGenerate).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toHaveTextContent('替换候选稿');
    expect(screen.getByRole('dialog')).toHaveTextContent('页面状态已变化，请再次确认');
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '确认批量生成' }));
    expect(onGenerate).toHaveBeenCalledWith('d', true);
  });

  it('rejects a batch confirmation when a selected page becomes queued before dispatch', async () => {
    const user = userEvent.setup(); const onBatchGenerate = vi.fn(async () => {});
    const input = props({ onBatchGenerate });
    const { rerender } = render(<Gallery {...input} />);
    await user.click(screen.getByRole('checkbox', { name: '选择第 2 页' }));
    await user.click(screen.getByRole('button', { name: '批量生成所选页' }));
    const updated: GalleryModel = { ...base, pages: base.pages.map(p => p.id === 'b' ? { ...p, job: { state: 'queued', label: '排队中' } } : p) };
    rerender(<Gallery {...input} model={updated} />);
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '确认批量生成' }));
    expect(onBatchGenerate).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('页面状态已变化，请重新选择');
  });

  it('requires fresh confirmation when the same candidate identity gets a new revision', async () => {
    const user = userEvent.setup(); const onGenerate = vi.fn(async () => {});
    const input = props({ onGenerate }); const { rerender } = render(<Gallery {...input} />);
    await user.click(screen.getByRole('button', { name: /第 2 页 机会/ }));
    await user.click(screen.getByRole('button', { name: '生成新稿' }));
    const updated: GalleryModel = { ...base, pages: base.pages.map(p => p.id === 'b' ? {
      ...p, versions: p.versions.map(v => v.id === 'b2' ? { ...v, revision: 3 } : v),
    } : p) };
    rerender(<Gallery {...input} model={updated} />);
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '确认批量生成' }));
    expect(onGenerate).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toHaveTextContent('页面状态已变化，请再次确认');
  });

  it('keeps acknowledged feedback through an older host snapshot and accepts a newer one', async () => {
    const user = userEvent.setup(); const saving = deferred<{ text: string; revision: number }>();
    const onSaveFeedback = vi.fn(() => saving.promise); const onDirtyChange = vi.fn();
    const saved = { 'b:b2:2': { text: '旧反馈', revision: 2 } };
    const input = props({ model: { ...base, savedFeedback: saved }, onSaveFeedback, onDirtyChange });
    const { rerender } = render(<Gallery {...input} />);
    await user.click(screen.getByRole('button', { name: /第 2 页 机会/ }));
    await user.clear(screen.getByRole('textbox', { name: '此版本反馈' }));
    await user.type(screen.getByRole('textbox', { name: '此版本反馈' }), '新反馈');
    await user.click(screen.getByRole('button', { name: '保存反馈' }));
    expect(onSaveFeedback).toHaveBeenCalledWith({ pageId: 'b', versionId: 'b2', revision: 2 }, '新反馈');
    await act(async () => saving.resolve({ text: '新反馈', revision: 3 }));
    rerender(<Gallery {...input} model={{ ...base, savedFeedback: { 'b:b2:2': { text: '旧反馈', revision: 2 } } }} />);
    expect(screen.getByRole('textbox', { name: '此版本反馈' })).toHaveValue('新反馈');
    expect(screen.getByRole('button', { name: '保存反馈' })).toBeDisabled();
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    rerender(<Gallery {...input} model={{ ...base, savedFeedback: { 'b:b2:2': { text: '新反馈', revision: 3 } } }} />);
    expect(screen.getByRole('textbox', { name: '此版本反馈' })).toHaveValue('新反馈');
    rerender(<Gallery {...input} model={{ ...base, savedFeedback: { 'b:b2:2': { text: '远程反馈', revision: 4 } } }} />);
    expect(screen.getByRole('textbox', { name: '此版本反馈' })).toHaveValue('远程反馈');
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  it('keeps a typed draft dirty when a newer host feedback revision precedes save acknowledgment', async () => {
    const user = userEvent.setup(); const saving = deferred<{ text: string; revision: number }>();
    const initial: GalleryModel = { ...base, savedFeedback: { 'b:b2:2': { text: '旧反馈', revision: 2 } } };
    const input = props({ model: initial, onSaveFeedback: vi.fn(() => saving.promise) });
    const { rerender } = render(<Gallery {...input} />);
    await user.click(screen.getByRole('button', { name: /第 2 页 机会/ }));
    await user.clear(screen.getByRole('textbox', { name: '此版本反馈' }));
    await user.type(screen.getByRole('textbox', { name: '此版本反馈' }), '我的更新');
    await user.click(screen.getByRole('button', { name: '保存反馈' }));
    rerender(<Gallery {...input} model={{ ...base, savedFeedback: { 'b:b2:2': { text: '远程更新', revision: 4 } } }} />);
    await act(async () => saving.resolve({ text: '我的更新', revision: 3 }));
    expect(screen.getByRole('textbox', { name: '此版本反馈' })).toHaveValue('我的更新');
    expect(screen.getByRole('button', { name: '保存反馈' })).toBeEnabled();
    expect(screen.getByRole('alert')).toHaveTextContent('反馈已被其他更新覆盖');
  });

  it('requires saving typed feedback before editing that version and keeps text after a failed save', async () => {
    const user = userEvent.setup(); const onEdit = vi.fn(async () => {});
    const onSaveFeedback = vi.fn(async () => { throw new Error('版本冲突'); });
    render(<Gallery {...props({ onEdit, onSaveFeedback })} />);
    await user.click(screen.getByRole('button', { name: /第 2 页 机会/ }));
    await user.type(screen.getByRole('textbox', { name: '此版本反馈' }), '先修改重点');
    expect(screen.getByRole('button', { name: '编辑此版本' })).toBeDisabled();
    expect(screen.getByText('先保存此版本反馈，再修改')).toBeVisible();
    await user.click(screen.getByRole('button', { name: '保存反馈' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('版本冲突');
    expect(screen.getByRole('textbox', { name: '此版本反馈' })).toHaveValue('先修改重点');
    expect(screen.getByRole('button', { name: '编辑此版本' })).toBeDisabled();
    expect(onEdit).not.toHaveBeenCalled();
  });

  it('does not load a changed thumbnail identity until the new image intersects', async () => {
    const callbacks: IntersectionObserverCallback[] = [];
    class Observer {
      constructor(callback: IntersectionObserverCallback) { callbacks.push(callback); }
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal('IntersectionObserver', Observer);
    const loadImage = vi.fn(async () => 'data:image/png;base64,aW1hZ2U=');
    const oldImage = { id: 'visible-old', sha256: 'old' };
    const newImage = { id: 'offscreen-new', sha256: 'new' };
    const { rerender } = render(<GalleryImage image={oldImage} loadImage={loadImage} alt="缩略图" />);
    expect(loadImage).not.toHaveBeenCalled();
    await act(async () => callbacks[0]!([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
    await waitFor(() => expect(loadImage).toHaveBeenCalledWith(oldImage));
    rerender(<GalleryImage image={newImage} loadImage={loadImage} alt="缩略图" />);
    expect(loadImage).not.toHaveBeenCalledWith(newImage);
    await act(async () => callbacks[1]!([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
    await waitFor(() => expect(loadImage).toHaveBeenCalledWith(newImage));
  });
});
