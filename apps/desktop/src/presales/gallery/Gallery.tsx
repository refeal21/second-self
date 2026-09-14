import { useEffect, useMemo, useRef, useState } from 'react';
import { GalleryImage } from './GalleryImage.js';
import type { GalleryAction, GalleryFeedback, GalleryGenerationReceipt, GalleryModel, GalleryPage, GalleryProps, GalleryVersion, GalleryVersionRef } from './model.js';
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
function versionSnapshot(page: GalleryPage, id: string | null): string | null {
  if (!id) return null;
  const version = page.versions.find(item => item.id === id);
  return JSON.stringify([id, version?.revision ?? null, version?.image?.id ?? null, version?.image?.sha256 ?? null]);
}
type GenerationFence = { phase: 'submitting' | 'awaiting-sync' | 'outcome-unknown'; requestId: string | null };

export function Gallery({ model, loadImage, onGenerate, onEdit, onAdopt, onRestore, onApprove, onSaveFeedback,
  onQueueChange, onBatchGenerate, onCancelJob, onRetryJob, onDirtyChange, onPageChange, initialPageId, initialVersionId, readOnly = false }: GalleryProps) {
  const [pageId, setPageId] = useState<string | null>(initialPageId ?? null);
  const [versionIds, setVersionIds] = useState<Record<string, string>>(initialPageId && initialVersionId ? { [initialPageId]: initialVersionId } : {});
  const [selected, setSelected] = useState<string[]>([]);
  const [feedback, setFeedback] = useState<Record<string, string>>({});
  const [baseline, setBaseline] = useState<Record<string, string>>({});
  const acknowledgedFeedbackRef = useRef<Record<string, GalleryFeedback>>({});
  const feedbackRevisionFloorRef = useRef<Record<string, number>>({});
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const generationPendingRef = useRef(new Map<string, GenerationFence>());
  const [generationPending, setGenerationPending] = useState<Record<string, GenerationFence>>({});
  const modelRef = useRef(model);
  modelRef.current = model;
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [checked, setChecked] = useState<Record<string, { content?: boolean; visual?: boolean }>>({});
  const [confirmation, setConfirmation] = useState<{
    pageIds: string[];
    candidateKeys: Record<string, string | null>;
    deliveryKeys: Record<string, string | null>;
    replaceCandidates: boolean;
    source: 'single' | 'selected' | 'missing';
    notice?: string;
  } | null>(null);

  useEffect(() => {
    const updates = Object.entries(model.savedFeedback).flatMap(([key, saved]) => {
      const floor = feedbackRevisionFloorRef.current[key] ?? -1;
      if (saved.revision < floor) return [];
      const acknowledgement = acknowledgedFeedbackRef.current[key];
      if (acknowledgement && saved.revision === acknowledgement.revision && saved.text !== acknowledgement.text) return [];
      feedbackRevisionFloorRef.current[key] = saved.revision;
      if (acknowledgement && saved.revision >= acknowledgement.revision) delete acknowledgedFeedbackRef.current[key];
      return [{ key, saved, acknowledgement }];
    });
    setBaseline(previous => {
      const next = { ...previous };
      for (const { key, saved } of updates) next[key] = saved.text;
      return next;
    });
    setFeedback(previous => {
      const next = { ...previous };
      for (const { key, saved, acknowledgement } of updates) {
        if (!(key in previous) || previous[key] === (baseline[key] ?? '') || previous[key] === acknowledgement?.text) next[key] = saved.text;
      }
      return next;
    });
  // Host updates only replace feedback if that key is not locally dirty.
  }, [model.savedFeedback]);
  const dirty = useMemo(() => Object.keys(feedback).some(key => feedback[key] !== (baseline[key] ?? '')) ||
    Object.keys(pending).some(key => key.startsWith('feedback:') && pending[key]), [feedback, baseline, pending]);
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);

  function syncGenerationFences() { setGenerationPending(Object.fromEntries(generationPendingRef.current)); }
  function reconcileGenerationFences(current: GalleryModel) {
    let changed = false;
    for (const [id, fence] of generationPendingRef.current) {
      if (fence.phase !== 'awaiting-sync' || !fence.requestId) continue;
      const currentPage = current.pages.find(item => item.id === id);
      if (currentPage && ((currentPage.job.state !== 'idle' && currentPage.job.requestId === fence.requestId) ||
        currentPage.versions.some(item => item.requestId === fence.requestId))) {
        generationPendingRef.current.delete(id);
        changed = true;
      }
    }
    if (changed) syncGenerationFences();
  }
  useEffect(() => { reconcileGenerationFences(model); }, [model.pages]);

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
  function runGeneration(ids: string[], key: string, work: () => Promise<GalleryGenerationReceipt>) {
    if (ids.some(id => generationPendingRef.current.has(id))) return;
    for (const id of ids) generationPendingRef.current.set(id, { phase: 'submitting', requestId: null });
    syncGenerationFences();
    setErrors(previous => ({ ...previous, [key]: '' }));
    void (async () => {
      try {
        const receipt = await work();
        const missing: string[] = [];
        for (const id of ids) {
          const requestId = receipt?.requestIds?.[id];
          if (typeof requestId === 'string' && requestId.trim()) generationPendingRef.current.set(id, { phase: 'awaiting-sync', requestId });
          else { generationPendingRef.current.set(id, { phase: 'outcome-unknown', requestId: null }); missing.push(id); }
        }
        syncGenerationFences();
        if (missing.length) setErrors(previous => ({ ...previous, [key]: `任务回执不完整（${missing.length} 页），提交结果待确认；请核对任务列表，暂不重复提交` }));
        reconcileGenerationFences(modelRef.current);
      } catch (error) {
        for (const id of ids) generationPendingRef.current.set(id, { phase: 'outcome-unknown', requestId: null });
        syncGenerationFences();
        setErrors(previous => ({ ...previous, [key]: `${explain(error)}；提交结果待确认，请核对任务列表，暂不重复提交。` }));
      }
    })();
  }
  const isGenerating = (id: string) => Boolean(generationPending[id]);
  function generationReason(id: string) {
    const phase = generationPending[id]?.phase;
    return phase === 'outcome-unknown' ? '提交结果待确认，请核对任务列表' : phase === 'awaiting-sync' ? '等待任务状态同步' : phase ? '该页操作进行中' : null;
  }
  function doVersionAction(action: Exclude<GalleryAction, 'edit' | 'generate'>, work: (ref: GalleryVersionRef) => Promise<void>) {
    if (!page || !ref || !version?.image || page.eligibility[action] || (action === 'restore' && (!version?.approved || (page.candidateVersionId !== version.id && page.currentDeliveryVersionId !== version.id))) || pending[actionKey(page.id, action)]) return;
    void perform(actionKey(page.id, action), () => work(ref));
  }
  function doEdit() {
    if (!page || !ref || page.eligibility.edit || model.capabilityReasons.edit || feedbackText !== feedbackBase || pending[`feedback:${feedbackId}`]) return;
    runGeneration([page.id], actionKey(page.id, 'edit'), () => onEdit(ref));
  }
  const feedbackId = ref ? feedbackKey(ref.pageId, ref.versionId, ref.revision) : '';
  const feedbackText = feedback[feedbackId] ?? model.savedFeedback[feedbackId]?.text ?? '';
  const feedbackBase = baseline[feedbackId] ?? model.savedFeedback[feedbackId]?.text ?? '';
  const currentCheckKey = ref ? `${ref.pageId}:${ref.versionId}:${ref.revision}:${version?.image?.id ?? ''}:${version?.image?.sha256 ?? ''}:${page?.reviewKey ?? ''}` : '';
  const checks = checked[currentCheckKey];
  const canApprove = Boolean(page && version?.image && page.candidateVersionId === version.id && checks?.content && checks?.visual && !page.eligibility.approve);
  const generateMissingIds = model.pages.filter(p => !p.candidateVersionId && !p.currentDeliveryVersionId && !generateReason(p) && !isGenerating(p.id)).map(p => p.id);
  function openBatch(ids: string[], source: 'single' | 'selected' | 'missing' = 'selected') {
    if (!ids.length) return;
    const targets = ids.map(id => model.pages.find(p => p.id === id));
    setConfirmation({ pageIds: ids, source,
      candidateKeys: Object.fromEntries(ids.map((id, index) => [id, targets[index] ? versionSnapshot(targets[index]!, targets[index]!.candidateVersionId) : null])),
      deliveryKeys: Object.fromEntries(ids.map((id, index) => [id, targets[index] ? versionSnapshot(targets[index]!, targets[index]!.currentDeliveryVersionId) : null])),
      replaceCandidates: targets.some(target => Boolean(target?.candidateVersionId)),
    });
  }
  function confirmGeneration() {
    if (!confirmation) return;
    const batch = confirmation;
    if (batch.source === 'missing' && model.queue.generateAllMissingReason) {
      setConfirmation(null);
      setErrors(previous => ({ ...previous, batch: model.queue.generateAllMissingReason ?? '队列当前不可用' }));
      return;
    }
    const currentIds = batch.source === 'selected' ? selected : batch.source === 'missing' ? generateMissingIds : batch.pageIds;
    const targets = batch.pageIds.map(id => model.pages.find(p => p.id === id));
    if (currentIds.length !== batch.pageIds.length || currentIds.some((id, index) => id !== batch.pageIds[index]) ||
      targets.some(target => !target || generateReason(target) || generationPendingRef.current.has(target.id))) {
      setConfirmation(null);
      setErrors(previous => ({ ...previous, batch: '页面状态已变化，请重新选择。' }));
      return;
    }
    const changed = targets.some((target, index) => versionSnapshot(target!, target!.candidateVersionId) !== batch.candidateKeys[batch.pageIds[index]!] ||
      versionSnapshot(target!, target!.currentDeliveryVersionId) !== batch.deliveryKeys[batch.pageIds[index]!]);
    if (changed) {
      setConfirmation({ ...batch,
        candidateKeys: Object.fromEntries(batch.pageIds.map((id, index) => [id, versionSnapshot(targets[index]!, targets[index]!.candidateVersionId)])),
        deliveryKeys: Object.fromEntries(batch.pageIds.map((id, index) => [id, versionSnapshot(targets[index]!, targets[index]!.currentDeliveryVersionId)])),
        replaceCandidates: targets.some(target => Boolean(target?.candidateVersionId)),
        notice: '页面状态已变化，请再次确认。',
      });
      return;
    }
    setConfirmation(null);
    runGeneration(batch.pageIds, batch.source === 'single' ? actionKey(batch.pageIds[0]!, 'generate') : `batch:${batch.pageIds.join('|')}`, () => batch.source === 'single'
      ? onGenerate(batch.pageIds[0]!, batch.replaceCandidates)
      : onBatchGenerate({ pageIds: batch.pageIds, replaceCandidates: batch.replaceCandidates }));
  }
  const selectedBlocker = selected.map(id => { const item = model.pages.find(p => p.id === id); return item ? generationReason(id) ?? generateReason(item) : '页面已移除'; }).find(Boolean);
  return <section className="presales-gallery" aria-label="多页视觉图库">
    <header className="presales-gallery__header"><div><p className="presales-gallery__eyebrow">视觉工作台 / 逐页审核</p><h1>多页图库</h1><p>逐页检查、修订和确认。新生成稿不会自动提交或成为交付版本。</p></div>
      <div className="presales-gallery__queue" aria-label="队列设置">
        <label>并发数 <input type="number" aria-label="并发数" min={1} max={4} value={model.queue.concurrency} disabled={readOnly}
          onChange={event => { const value = Number(event.target.value); if (Number.isInteger(value) && value >= 1 && value <= 4) void perform('queue:concurrency', () => onQueueChange({ concurrency: value })); }} /></label>
        <button type="button" disabled={Boolean(readOnly || pending['queue:pause'] || (model.queue.paused ? model.queue.resumeReason : model.queue.pauseReason))}
          onClick={() => void perform('queue:pause', () => onQueueChange({ paused: !model.queue.paused }))}>{model.queue.paused ? '继续队列' : '暂停队列'}</button>
        {(model.queue.paused ? model.queue.resumeReason : model.queue.pauseReason) && <small>{model.queue.paused ? model.queue.resumeReason : model.queue.pauseReason}</small>}
      </div></header>
    <div className="presales-gallery__toolbar"><span>{model.pages.length} 页 · 已选 {selected.length} 页</span>
      <button type="button" disabled={!selected.length || Boolean(selectedBlocker)} title={selectedBlocker || undefined} onClick={() => openBatch(selected)}>批量生成所选页</button>
      {selectedBlocker && <small>所选页无法生成：{selectedBlocker}</small>}
      <button type="button" disabled={!generateMissingIds.length || Boolean(model.queue.generateAllMissingReason)} onClick={() => openBatch(generateMissingIds, 'missing')}>生成全部缺失页</button>
      {model.queue.generateAllMissingReason && <small>{model.queue.generateAllMissingReason}</small>}</div>
    <div className="presales-gallery__layout"><aside className="presales-gallery__pages" aria-label="页面列表">
      {model.pages.map(item => {
        const thumbnail = item.versions.find(v => v.id === item.candidateVersionId) ?? item.versions.find(v => v.id === item.currentDeliveryVersionId);
        return <div className={`presales-gallery__page ${item.id === page?.id ? 'is-active' : ''}`} key={item.id}>
          <input type="checkbox" aria-label={`选择第 ${item.number} 页`} checked={selected.includes(item.id)} onChange={event => setSelected(previous => event.target.checked ? [...previous, item.id] : previous.filter(id => id !== item.id))} />
          <button type="button" aria-current={item.id === page?.id ? 'page' : undefined} onClick={() => { setPageId(item.id); onPageChange?.(item.id); }}>
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
          <button type="button" disabled={Boolean(generateReason(page) || isGenerating(page.id))} title={generateReason(page) ?? generationReason(page.id) ?? undefined}
            onClick={() => openBatch([page.id], 'single')}>生成新稿</button>
          <button type="button" disabled={!ref || Boolean(page.eligibility.edit || model.capabilityReasons.edit || isGenerating(page.id) || feedbackText !== feedbackBase || pending[`feedback:${feedbackId}`])} title={page.eligibility.edit ?? model.capabilityReasons.edit ?? (feedbackText !== feedbackBase || pending[`feedback:${feedbackId}`] ? '先保存此版本反馈，再修改' : isGenerating(page.id) ? '该页操作进行中' : undefined)}
            onClick={doEdit}>编辑此版本</button>
          <button type="button" disabled={!ref || !version?.image || Boolean(page.eligibility.adopt || pending[actionKey(page.id, 'adopt')])} title={!version?.image ? '此历史版本图片不可用' : page.eligibility.adopt ?? undefined}
            onClick={() => doVersionAction('adopt', onAdopt)}>选择用于交付</button>
          <button type="button" disabled={!ref || !version?.image || Boolean(!version?.approved || (page.candidateVersionId !== version.id && page.currentDeliveryVersionId !== version.id) || page.eligibility.restore || pending[actionKey(page.id, 'restore')])} title={!version?.image ? '此历史版本图片不可用' : !version?.approved ? '仅已批准版本可恢复' : page.candidateVersionId !== version.id && page.currentDeliveryVersionId !== version.id ? '请先明确采用此历史版本，再恢复其批准' : page.eligibility.restore ?? undefined}
            onClick={() => doVersionAction('restore', onRestore)}>恢复此前批准</button>
        </div>
        <div className="presales-gallery__reasons">{model.capabilityReasons.reference && <p>参考图：{model.capabilityReasons.reference}</p>}{model.capabilityReasons.edit && <p>编辑：{model.capabilityReasons.edit}</p>}
          {Object.entries({ ...page.eligibility, generate: generateReason(page) }).map(([action, reason]) => reason && <p key={action}>{({ generate: '生成', edit: '编辑', adopt: '采用', restore: '恢复', approve: '批准' } as Record<string,string>)[action]}：{reason}</p>)}
          {!version?.approved && version && <p>恢复：仅已批准版本可恢复</p>}
          {generationPending[page.id]?.phase === 'awaiting-sync' && <p>已提交，等待任务状态同步；暂不重复提交。</p>}
          {generationPending[page.id]?.phase === 'outcome-unknown' && <p>提交结果待确认，请核对任务列表；暂不重复提交。</p>}
          {ref && (feedbackText !== feedbackBase || pending[`feedback:${feedbackId}`]) && <p>先保存此版本反馈，再修改</p>}
          {page.job.state === 'unknown' && <p>任务结果待确认，暂不自动重试。</p>}</div>
        {(onCancelJob || onRetryJob) && <div className="presales-gallery__actions">
          {onCancelJob && <button type="button" disabled={Boolean(!['queued', 'running'].includes(page.job.state) || page.job.cancelReason || pending[actionKey(page.id, 'cancel')])} onClick={() => void perform(actionKey(page.id, 'cancel'), () => onCancelJob(page.id))}>取消任务</button>}
          {onRetryJob && <button type="button" disabled={Boolean(page.job.state !== 'failed' || page.job.retryReason || pending[actionKey(page.id, 'retry')])} onClick={() => void perform(actionKey(page.id, 'retry'), () => onRetryJob(page.id))}>重试任务</button>}
          {page.job.retryReason && <small>{page.job.retryReason}</small>}
        </div>}
        {ref && <section className="presales-gallery__review" aria-label="版本审核"><h3>审核此版本</h3>
          <label className="presales-gallery__feedback">反馈（可选）<textarea aria-label="此版本反馈" value={feedbackText} disabled={readOnly} onChange={event => setFeedback(previous => ({ ...previous, [feedbackId]: event.target.value }))} /></label>
          <div className="presales-gallery__actions"><button type="button" disabled={readOnly || feedbackText === feedbackBase || Boolean(pending[`feedback:${feedbackId}`])} onClick={() => {
            const text = feedbackText;
            void perform(`feedback:${feedbackId}`, async () => {
              const saved = await onSaveFeedback(ref, text);
              if (saved.revision < (feedbackRevisionFloorRef.current[feedbackId] ?? -1)) {
                throw new Error('反馈已被其他更新覆盖，请核对后重新保存。');
              }
              acknowledgedFeedbackRef.current[feedbackId] = saved;
              feedbackRevisionFloorRef.current[feedbackId] = Math.max(feedbackRevisionFloorRef.current[feedbackId] ?? -1, saved.revision);
              setBaseline(previous => ({ ...previous, [feedbackId]: saved.text }));
            });
          }}>保存反馈</button>
          <label className="presales-gallery__check"><input type="checkbox" disabled={readOnly} checked={Boolean(checks?.content)} onChange={event => setChecked(previous => ({ ...previous, [currentCheckKey]: { ...previous[currentCheckKey], content: event.target.checked } }))} />已核对第 {page.number} 页修订 {version!.revision}：内容与页面规格一致</label>
          <label className="presales-gallery__check"><input type="checkbox" disabled={readOnly} checked={Boolean(checks?.visual)} onChange={event => setChecked(previous => ({ ...previous, [currentCheckKey]: { ...previous[currentCheckKey], visual: event.target.checked } }))} />已核对第 {page.number} 页修订 {version!.revision}：视觉与设计方案一致</label>
          <button type="button" className="presales-gallery__primary" disabled={readOnly || !canApprove || Boolean(pending[actionKey(page.id, 'approve')])} onClick={() => doVersionAction('approve', checkedRef => {
            const confirmed = checked[currentCheckKey];
            if (!confirmed?.content || !confirmed.visual) throw new Error('请分别确认内容与视觉');
            return onApprove(checkedRef, { contentChecked: confirmed.content, visualChecked: confirmed.visual });
          })}>批准此版本</button></div>
          {errors[`feedback:${feedbackId}`] && <p role="alert">{errors[`feedback:${feedbackId}`]}。输入已保留。</p>}
        </section>}
        {Object.entries(errors).filter(([key, value]) => value && !key.startsWith('feedback:') &&
          (key.startsWith(`${page.id}:`) || key === 'batch' || key.startsWith('batch:') || key.startsWith('queue:'))).map(([key, value]) => <p role="alert" key={key}>{value}</p>)}
      </>}</main></div>
    {confirmation && <div className="presales-gallery__modal-backdrop"><div role="dialog" aria-modal="true" aria-label="确认批量生成" className="presales-gallery__modal">
      <h2>确认批量生成</h2><p>将为 {confirmation.pageIds.length} 页创建新候选稿；不会自动提交或批准。</p>
      {confirmation.replaceCandidates && <p>所选页面已有候选稿。确认后将替换候选稿；历史版本仍可查看。</p>}
      {confirmation.notice && <p role="status">{confirmation.notice}</p>}
      <div className="presales-gallery__actions"><button type="button" onClick={() => setConfirmation(null)}>返回</button><button type="button" className="presales-gallery__primary" onClick={confirmGeneration}>确认批量生成</button></div></div></div>}
  </section>;
}

export type { GalleryModel, GalleryProps } from './model.js';
