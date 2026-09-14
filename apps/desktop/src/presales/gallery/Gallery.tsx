import { useEffect, useMemo, useState } from 'react';
import { GalleryImage } from './GalleryImage.js';
import type { GalleryAction, GalleryPage, GalleryProps, GalleryVersion, GalleryVersionRef } from './model.js';
import './gallery.css';

const feedbackKey = (pageId: string, versionId: string, revision: number) => `${pageId}:${versionId}:${revision}`;
const versionRef = (page: GalleryPage, version: GalleryVersion): GalleryVersionRef => ({ pageId: page.id, versionId: version.id, revision: version.revision });
function explain(error: unknown) { return error instanceof Error && error.message.trim() ? error.message : '操作失败，请检查后重试。'; }
function firstVersion(page: GalleryPage) { return page.versions.find(v => v.id === page.candidateVersionId) ?? page.versions.find(v => v.id === page.currentDeliveryVersionId) ?? page.versions.at(-1) ?? null; }
function versionRole(page: GalleryPage, version: GalleryVersion) {
  if (page.currentDeliveryVersionId === version.id) return '当前交付';
  if (page.candidateVersionId === version.id) return '候选稿';
  return '历史版本';
}
const jobLabels = { idle: '空闲', queued: '排队中', running: '生成中', unknown: '状态待核对', failed: '失败', completed: '已完成' };
function generateReason(page: GalleryPage): string | null {
  if (page.eligibility.generate) return page.eligibility.generate;
  if (page.job.state === 'running') return '正在生成';
  if (page.job.state === 'queued') return '已排队';
  if (page.job.state === 'unknown') return '任务状态待核对';
  if (page.job.state === 'failed') return '请先核对失败任务';
  return null;
}

export function Gallery({ model, loadImage, onGenerate, onEdit, onAdopt, onRestore, onApprove, onSaveFeedback,
  onQueueChange, onBatchGenerate, onCancelJob, onRetryJob, onDirtyChange }: GalleryProps) {
  const [pageId, setPageId] = useState<string | null>(null);
  const [versionIds, setVersionIds] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<string[]>([]);
  const [feedback, setFeedback] = useState<Record<string, string>>({});
  const [baseline, setBaseline] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [confirmation, setConfirmation] = useState<{ pageIds: string[]; replaceCandidates: boolean; single: boolean } | null>(null);

  useEffect(() => {
    setBaseline(previous => {
      const next = { ...previous };
      for (const [key, saved] of Object.entries(model.savedFeedback)) next[key] = saved.text;
      return next;
    });
    setFeedback(previous => {
      const next = { ...previous };
      for (const [key, saved] of Object.entries(model.savedFeedback)) {
        if (!(key in previous) || previous[key] === (baseline[key] ?? '')) next[key] = saved.text;
      }
      return next;
    });
  // Host updates only replace feedback if that key is not locally dirty.
  }, [model.savedFeedback]);
  const dirty = useMemo(() => Object.keys(feedback).some(key => feedback[key] !== (baseline[key] ?? '')) ||
    Object.keys(pending).some(key => key.startsWith('feedback:') && pending[key]), [feedback, baseline, pending]);
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);

  const page = model.pages.find(p => p.id === pageId) ?? model.pages[0] ?? null;
  const version = page?.versions.find(v => v.id === versionIds[page.id]) ?? (page ? firstVersion(page) : null);
  const ref = page && version ? versionRef(page, version) : null;
  const actionKey = (id: string, action: string) => `${id}:${action}`;
  async function perform(key: string, work: () => Promise<void>) {
    if (pending[key]) return;
    setPending(previous => ({ ...previous, [key]: true }));
    setErrors(previous => ({ ...previous, [key]: '' }));
    try { await work(); }
    catch (error) { setErrors(previous => ({ ...previous, [key]: explain(error) })); }
    finally { setPending(previous => ({ ...previous, [key]: false })); }
  }
  function doVersionAction(action: GalleryAction, work: (ref: GalleryVersionRef) => Promise<void>) {
    if (!page || !ref || page.eligibility[action] || (action === 'restore' && !version?.approved) || pending[actionKey(page.id, action)]) return;
    void perform(actionKey(page.id, action), () => work(ref));
  }
  const feedbackId = ref ? feedbackKey(ref.pageId, ref.versionId, ref.revision) : '';
  const feedbackText = feedback[feedbackId] ?? model.savedFeedback[feedbackId]?.text ?? '';
  const feedbackBase = baseline[feedbackId] ?? model.savedFeedback[feedbackId]?.text ?? '';
  const currentCheckKey = ref ? `${ref.pageId}:${ref.versionId}:${ref.revision}` : '';
  const canApprove = Boolean(page && version && page.candidateVersionId === version.id && checked[currentCheckKey] && !page.eligibility.approve);
  const generateMissingIds = model.pages.filter(p => !p.candidateVersionId && !p.currentDeliveryVersionId && !generateReason(p)).map(p => p.id);
  function openBatch(ids: string[], single = false) {
    if (!ids.length) return;
    setConfirmation({ pageIds: ids, replaceCandidates: ids.some(id => Boolean(model.pages.find(p => p.id === id)?.candidateVersionId)), single });
  }
  const selectedBlocker = selected.map(id => { const item = model.pages.find(p => p.id === id); return item ? generateReason(item) : '页面已移除'; }).find(Boolean);
  return <section className="presales-gallery" aria-label="多页视觉图库">
    <header className="presales-gallery__header"><div><p className="presales-gallery__eyebrow">视觉工作台 / 逐页审核</p><h1>多页图库</h1><p>逐页检查、修订和确认。新生成稿不会自动提交或成为交付版本。</p></div>
      <div className="presales-gallery__queue" aria-label="队列设置">
        <label>并发数 <input type="number" aria-label="并发数" min={1} max={4} value={model.queue.concurrency}
          onChange={event => { const value = Number(event.target.value); if (Number.isInteger(value) && value >= 1 && value <= 4) void perform('queue:concurrency', () => onQueueChange({ concurrency: value })); }} /></label>
        <button type="button" disabled={Boolean(pending['queue:pause'] || (model.queue.paused ? model.queue.resumeReason : model.queue.pauseReason))}
          onClick={() => void perform('queue:pause', () => onQueueChange({ paused: !model.queue.paused }))}>{model.queue.paused ? '继续队列' : '暂停队列'}</button>
        {(model.queue.paused ? model.queue.resumeReason : model.queue.pauseReason) && <small>{model.queue.paused ? model.queue.resumeReason : model.queue.pauseReason}</small>}
      </div></header>
    <div className="presales-gallery__toolbar"><span>{model.pages.length} 页 · 已选 {selected.length} 页</span>
      <button type="button" disabled={!selected.length || Boolean(selectedBlocker) || Boolean(pending['batch'])} title={selectedBlocker || undefined} onClick={() => openBatch(selected)}>批量生成所选页</button>
      {selectedBlocker && <small>所选页无法生成：{selectedBlocker}</small>}
      <button type="button" disabled={!generateMissingIds.length || Boolean(model.queue.generateAllMissingReason) || Boolean(pending['batch'])} onClick={() => openBatch(generateMissingIds)}>生成全部缺失页</button>
      {model.queue.generateAllMissingReason && <small>{model.queue.generateAllMissingReason}</small>}</div>
    <div className="presales-gallery__layout"><aside className="presales-gallery__pages" aria-label="页面列表">
      {model.pages.map(item => {
        const thumbnail = item.versions.find(v => v.id === item.candidateVersionId) ?? item.versions.find(v => v.id === item.currentDeliveryVersionId);
        return <div className={`presales-gallery__page ${item.id === page?.id ? 'is-active' : ''}`} key={item.id}>
          <input type="checkbox" aria-label={`选择第 ${item.number} 页`} checked={selected.includes(item.id)} onChange={event => setSelected(previous => event.target.checked ? [...previous, item.id] : previous.filter(id => id !== item.id))} />
          <button type="button" aria-current={item.id === page?.id ? 'page' : undefined} onClick={() => setPageId(item.id)}>
            {thumbnail?.image && <GalleryImage image={thumbnail.image} loadImage={loadImage} alt="" />}
            <span><strong>第 {item.number} 页 {item.title}</strong><small>{item.summary}</small><em>{item.job.label ?? (item.currentDeliveryVersionId ? '有交付稿' : item.candidateVersionId ? '待审核' : '未生成')}</em></span>
          </button>
          {item.job.cancelReason && <small className="presales-gallery__reason">{item.job.cancelReason}</small>}
        </div>;
      })}</aside>
      <main className="presales-gallery__detail">{!page ? <p>暂无页面</p> : <>
        <div className="presales-gallery__detail-head"><div><p className="presales-gallery__eyebrow">PAGE {String(page.number).padStart(2, '0')}</p><h2>第 {page.number} 页 · {page.title}</h2><p>{page.summary}</p></div><span className="presales-gallery__job">{page.job.label ?? jobLabels[page.job.state]}</span></div>
        <div className="presales-gallery__stage">{version ? <>
          {version.image ? <GalleryImage key={`${version.image.id}:${version.image.sha256}`} image={version.image} loadImage={loadImage} alt={`第 ${page.number} 页${version.label}预览`} priority />
            : <div className="presales-gallery__missing"><strong>图片不可用</strong><p>{version.missingReason ?? '此版本没有图片资源；仍可查看版本信息。'}</p></div>}
          <div className="presales-gallery__stage-caption"><strong>{versionRole(page, version)} · 修订 {version.revision}</strong><span>{version.label}{version.manualRevision ? ` · 手工修订 ${version.manualRevision}` : ''}</span></div>
        </> : <div className="presales-gallery__missing">尚无生成版本</div>}</div>
        <div className="presales-gallery__history"><h3>版本历史</h3><div>{page.versions.map(item => <button key={item.id} type="button" className={item.id === version?.id ? 'is-active' : ''}
          onClick={() => setVersionIds(previous => ({ ...previous, [page.id]: item.id }))}>查看{item.label} 修订 {item.revision}{item.id === page.currentDeliveryVersionId ? ' · 当前交付' : ''}</button>)}</div></div>
        <div className="presales-gallery__actions" aria-label="页面操作">
          <button type="button" disabled={Boolean(generateReason(page) || pending[actionKey(page.id, 'generate')])} title={generateReason(page) ?? undefined}
            onClick={() => openBatch([page.id], true)}>生成新稿</button>
          <button type="button" disabled={!ref || Boolean(page.eligibility.edit || model.capabilityReasons.edit || pending[actionKey(page.id, 'edit')])} title={page.eligibility.edit ?? model.capabilityReasons.edit ?? undefined}
            onClick={() => doVersionAction('edit', onEdit)}>编辑此版本</button>
          <button type="button" disabled={!ref || Boolean(page.eligibility.adopt || pending[actionKey(page.id, 'adopt')])} title={page.eligibility.adopt ?? undefined}
            onClick={() => doVersionAction('adopt', onAdopt)}>选择用于交付</button>
          <button type="button" disabled={!ref || Boolean(!version?.approved || page.eligibility.restore || pending[actionKey(page.id, 'restore')])} title={!version?.approved ? '仅已批准版本可恢复' : page.eligibility.restore ?? undefined}
            onClick={() => doVersionAction('restore', onRestore)}>恢复此前批准</button>
        </div>
        <div className="presales-gallery__reasons">{model.capabilityReasons.reference && <p>参考图：{model.capabilityReasons.reference}</p>}{model.capabilityReasons.edit && <p>编辑：{model.capabilityReasons.edit}</p>}
          {Object.entries({ ...page.eligibility, generate: generateReason(page) }).map(([action, reason]) => reason && <p key={action}>{({ generate: '生成', edit: '编辑', adopt: '采用', restore: '恢复', approve: '批准' } as Record<string,string>)[action]}：{reason}</p>)}
          {!version?.approved && version && <p>恢复：仅已批准版本可恢复</p>}
          {page.job.state === 'unknown' && <p>任务结果待确认，暂不自动重试。</p>}</div>
        {(onCancelJob || onRetryJob) && <div className="presales-gallery__actions">
          {onCancelJob && <button type="button" disabled={Boolean(!['queued', 'running'].includes(page.job.state) || page.job.cancelReason || pending[actionKey(page.id, 'cancel')])} onClick={() => void perform(actionKey(page.id, 'cancel'), () => onCancelJob(page.id))}>取消任务</button>}
          {onRetryJob && <button type="button" disabled={Boolean(page.job.state !== 'failed' || page.job.retryReason || pending[actionKey(page.id, 'retry')])} onClick={() => void perform(actionKey(page.id, 'retry'), () => onRetryJob(page.id))}>重试任务</button>}
          {page.job.retryReason && <small>{page.job.retryReason}</small>}
        </div>}
        {ref && <section className="presales-gallery__review" aria-label="版本审核"><h3>审核此版本</h3>
          <label className="presales-gallery__feedback">反馈（可选）<textarea aria-label="此版本反馈" value={feedbackText} onChange={event => setFeedback(previous => ({ ...previous, [feedbackId]: event.target.value }))} /></label>
          <div className="presales-gallery__actions"><button type="button" disabled={feedbackText === feedbackBase || Boolean(pending[`feedback:${feedbackId}`])} onClick={() => {
            const text = feedbackText;
            void perform(`feedback:${feedbackId}`, async () => { await onSaveFeedback(ref, text); setBaseline(previous => ({ ...previous, [feedbackId]: text })); });
          }}>保存反馈</button>
          <label className="presales-gallery__check"><input type="checkbox" checked={Boolean(checked[currentCheckKey])} onChange={event => setChecked(previous => ({ ...previous, [currentCheckKey]: event.target.checked }))} />已人工核对第 {page.number} 页{versionRole(page, version!)}修订 {version!.revision}（仅此版本）</label>
          <button type="button" className="presales-gallery__primary" disabled={!canApprove || Boolean(pending[actionKey(page.id, 'approve')])} onClick={() => doVersionAction('approve', onApprove)}>批准此版本</button></div>
          {errors[`feedback:${feedbackId}`] && <p role="alert">{errors[`feedback:${feedbackId}`]}。输入已保留。</p>}
        </section>}
        {Object.entries(errors).filter(([key, value]) => value && !key.startsWith('feedback:') &&
          (key.startsWith(`${page.id}:`) || key === 'batch' || key.startsWith('queue:'))).map(([key, value]) => <p role="alert" key={key}>{value}</p>)}
      </>}</main></div>
    {confirmation && <div className="presales-gallery__modal-backdrop"><div role="dialog" aria-modal="true" aria-label="确认批量生成" className="presales-gallery__modal">
      <h2>确认批量生成</h2><p>将为 {confirmation.pageIds.length} 页创建新候选稿；不会自动提交或批准。</p>
      {confirmation.replaceCandidates && <p>所选页面已有候选稿。确认后将替换候选稿；历史版本仍可查看。</p>}
      <div className="presales-gallery__actions"><button type="button" onClick={() => setConfirmation(null)}>返回</button><button type="button" className="presales-gallery__primary" onClick={() => {
        const batch = confirmation; setConfirmation(null);
        void perform(batch.single ? actionKey(batch.pageIds[0]!, 'generate') : 'batch', () => batch.single
          ? onGenerate(batch.pageIds[0]!, batch.replaceCandidates)
          : onBatchGenerate({ pageIds: batch.pageIds, replaceCandidates: batch.replaceCandidates }));
      }}>确认批量生成</button></div></div></div>}
  </section>;
}

export type { GalleryModel, GalleryProps } from './model.js';
