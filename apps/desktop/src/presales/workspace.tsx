import { useCallback, useEffect, useRef, useState } from 'react';
import { Gallery } from './gallery/Gallery.js';
import { clearGalleryImageCache } from './gallery/GalleryImage.js';
import { toGalleryModel, nativePage } from './read-model.js';
import { DraftWorkspace } from './draft-workspace.js';
import { PreVersionFeedbackEditor } from './feedback-editor.js';
import type { GalleryGenerationReceipt, GalleryVersionRef } from './gallery/model.js';
import type { PresalesAdapter, V3Page, V3Project, V3ProjectSnapshot, V3QueueSnapshot } from './adapter.js';
import './workspace.css';

type PendingIntent = { requestId: string; attemptId: string };
const pendingIntents = new Map<string, PendingIntent>();
const pendingKey = (projectId: string, slideId: string) => `${projectId}:${slideId}`;
const makeId = () => crypto.randomUUID();
const errorText = (error: unknown) => error instanceof Error ? error.message : typeof error === 'string' ? error : '操作未完成';
// Direct buttons report failures in component state; they do not have a caller to reject to.
const fire = (promise: Promise<unknown>) => { void promise.catch(() => {}); };

export function PresalesWorkspacePage({ adapter, projectId, initialPageId, initialVersionId, onDirtyChange }: { adapter: PresalesAdapter; projectId: string; initialPageId?: string; initialVersionId?: string; onDirtyChange: (dirty: boolean) => void }) {
  const [loaded, setLoaded] = useState<V3Project | null>(null);
  const [queue, setQueue] = useState<V3QueueSnapshot | null>(null);
  const [selectedPageId, setSelectedPageId] = useState<string | null>(initialPageId ?? null);
  const [galleryDirty, setGalleryDirty] = useState(false);
  const [preFeedbackText, setPreFeedbackText] = useState<Record<string, string>>({});
  const [preFeedbackAcknowledged, setPreFeedbackAcknowledged] = useState<Record<string, { revision: number; text: string }>>({});
  const [preFeedbackError, setPreFeedbackError] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const projectRef = useRef(loaded); projectRef.current = loaded;
  const queueRef = useRef(queue); queueRef.current = queue;
  const currentPages = loaded?.kind === 'frozen' ? loaded.project.pages : [];
  const preDirty = currentPages.some(item => {
    const stored = item.feedbackDrafts.find(draft => draft.baseVersionId === null);
    const acknowledged = preFeedbackAcknowledged[item.slideId];
    const baseline = acknowledged && acknowledged.revision >= (stored?.revision ?? 0) ? acknowledged.text : stored?.text ?? '';
    return preFeedbackText[item.slideId] !== undefined && preFeedbackText[item.slideId] !== baseline;
  });
  useEffect(() => { if (loaded?.kind === 'frozen') onDirtyChange(galleryDirty || preDirty); }, [galleryDirty, preDirty, onDirtyChange, loaded?.kind]);
  const refreshToken = useRef(0);
  const refresh = useCallback(async () => {
    const token = ++refreshToken.current;
    const [nextProject, nextQueue] = await Promise.all([adapter.load(projectId), adapter.queue()]);
    if (token !== refreshToken.current) return;
    for (const [key, intent] of pendingIntents) {
      if (!key.startsWith(`${projectId}:`)) continue;
      const pageId = key.slice(projectId.length + 1);
      const pages = nextProject.kind === 'draft' ? [] : nextProject.project.pages;
      if (nextQueue.jobs.some(job => job.kind === 'image' && job.projectId === projectId && job.slideId === pageId && job.requestId === intent.requestId) ||
        pages.some(page => page.slideId === pageId && page.versions.some(version => version.requestId === intent.requestId))) pendingIntents.delete(key);
    }
    setLoaded(nextProject); setQueue(nextQueue);
  }, [adapter, projectId]);
  useEffect(() => {
    setLoaded(null); setQueue(null); setSelectedPageId(initialPageId ?? null); setError(null); setNotice(null);
    void refresh().catch(error => setError(errorText(error)));
    const unsubscribe = adapter.subscribe(() => { void refresh().catch(error => setError(errorText(error))); });
    return () => { refreshToken.current++; unsubscribe(); clearGalleryImageCache(); onDirtyChange(false); };
  }, [adapter, projectId, refresh, onDirtyChange, initialPageId]);
  async function action<T>(key: string, work: () => Promise<T>): Promise<T> {
    if (pending[key]) throw new Error('该操作正在处理');
    setPending(previous => ({ ...previous, [key]: true })); setError(null);
    try { const result = await work(); await refresh(); return result; }
    catch (caught) { setError(`${errorText(caught)}。已重新读取权威状态；本地未保存输入仍保留。`); try { await refresh(); } catch { /* original error stays visible */ } throw caught; }
    finally { setPending(previous => ({ ...previous, [key]: false })); }
  }
  function frozen(): V3ProjectSnapshot {
    const current = projectRef.current;
    if (!current || current.kind !== 'frozen') throw new Error('此项目不能修改生成状态');
    return current.project;
  }
  function page(id: string): V3Page { return nativePage(frozen(), id); }
  function exact(ref: GalleryVersionRef) {
    const currentPage = page(ref.pageId);
    const version = currentPage.versions.find(item => item.versionId === ref.versionId && item.sequence === ref.revision);
    if (!version) throw new Error('版本已变化，请重新检查');
    return { currentPage, version };
  }
  async function enqueue(ids: string[], parent: GalleryVersionRef | null): Promise<GalleryGenerationReceipt> {
    const current = frozen(); const currentQueue = queueRef.current;
    if (!currentQueue?.capabilities?.generation) throw new Error(currentQueue?.capabilities?.reason ?? '图片生成能力尚未确认');
    if (parent && !currentQueue.capabilities.referenceEditing) throw new Error(currentQueue.capabilities.reason ?? '模型不支持图片参考编辑');
    const targets = ids.map(id => {
      const native = nativePage(current, id);
      if (!native.visualBasis || currentQueue.jobs.some(job => job.kind === 'image' && job.projectId === projectId && job.slideId === id && ['queued', 'dispatching', 'running', 'result_ready', 'committing', 'cancel_requested', 'outcome_unknown'].includes(job.status))) throw new Error(`第 ${native.ordinal} 页当前不符合生成条件`);
      const existing = pendingIntents.get(pendingKey(projectId, id));
      if (existing) throw new Error('该页前次提交结果待核对，请勿重复提交');
      const parentVersion = parent?.pageId === id ? exact(parent).version : null;
      if (parent && (!parentVersion?.image || !parentVersion.basis)) throw new Error('父版本图片或依据缺失，不能作为图片编辑输入');
      return { id, native, parentVersion };
    });
    const pages = targets.map(({ id, native, parentVersion }) => {
      const intent = { requestId: makeId(), attemptId: makeId() };
      pendingIntents.set(pendingKey(projectId, id), intent);
      return { slideId: id, ...intent, expectedRevision: native.revision, parentVersionId: parentVersion?.versionId ?? null,
        feedback: native.feedbackDrafts.find(draft => draft.baseVersionId === (parentVersion?.versionId ?? native.currentVersionId ?? null))?.text ?? '' };
    });
    try {
      const result = await adapter.enqueue(projectId, makeId(), pages);
      const requestIds: Record<string, string> = {};
      for (const submitted of pages) {
        const accepted = result.jobs.find(job => job.target.projectId === projectId && job.target.slideId === submitted.slideId && job.requestId === submitted.requestId);
        if (accepted) requestIds[submitted.slideId] = accepted.requestId;
      }
      await refresh();
      return { requestIds };
    } catch (caught) {
      // A transport error is not proof of non-admission. Keep stable IDs for reconciliation.
      setError(`${errorText(caught)}。提交结果待确认；不会自动重发。`);
      try { await refresh(); } catch { /* remain fenced */ }
      return { requestIds: {} };
    }
  }
  async function versionAction(ref: GalleryVersionRef, kind: 'adopt' | 'restore' | 'approve', checks?: { contentChecked: true; visualChecked: true }) {
    const { currentPage, version } = exact(ref);
    if (!version.image || !version.basis) throw new Error('此版本图片或依据缺失，不能批准或采用');
    const input = { projectId, slideId: ref.pageId, versionId: version.versionId, expectedRevision: currentPage.revision };
    if (kind === 'approve') {
      if (!checks?.contentChecked || !checks.visualChecked) throw new Error('须分别核对内容和视觉');
      if (currentPage.currentVersionId !== version.versionId) throw new Error('只能批准当前候选版本');
      if (!version.provenance || typeof version.provenance !== 'object' || (version.provenance as { kind?: string }).kind !== 'presales') throw new Error('原项目图片不能获得新的售前批准');
      if (JSON.stringify(version.basis) !== JSON.stringify(currentPage.visualBasis)) throw new Error('页面视觉依据已变化，请重新审核');
      await action(`${ref.pageId}:approve`, () => adapter.approveVersion({ ...input, imageSha256: version.image!.sha256, basis: version.basis!, ...checks }));
    } else if (kind === 'adopt') await action(`${ref.pageId}:adopt`, () => adapter.adoptVersion(input));
    else await action(`${ref.pageId}:restore`, () => adapter.restoreApproval(input));
  }
  const current = loaded?.project;
  if (!loaded || !queue) return <main className="presales-workspace"><h1>售前 v3 工作台</h1>{error ? <p role="alert">{error}</p> : <p role="status">正在读取副本与队列…</p>}</main>;
  if (loaded.kind === 'draft') return <DraftWorkspace adapter={adapter} project={loaded.project} queue={queue} onDirtyChange={onDirtyChange} refresh={refresh} />;
  const readOnly = loaded.kind === 'history_only';
  const snapshot = current as V3ProjectSnapshot | import('./adapter.js').V3HistoryProject;
  const model = toGalleryModel(snapshot, queue, readOnly);
  for (const galleryPage of model.pages) if (pendingIntents.has(pendingKey(projectId, galleryPage.id))) {
    galleryPage.eligibility.generate = '前次提交结果待核对，请勿重复提交';
    galleryPage.eligibility.edit = '前次提交结果待核对，请勿重复提交';
    if (galleryPage.job.state === 'idle') galleryPage.job = { state: 'unknown', requestId: pendingIntents.get(pendingKey(projectId, galleryPage.id))!.requestId, label: '提交结果待核对' };
  }
  const selectedPage = snapshot.pages.find(item => item.slideId === selectedPageId) ?? snapshot.pages[0] ?? null;
  const selectedJob = selectedPage && [...queue.jobs].reverse().find(job => job.kind === 'image' && job.projectId === projectId && job.slideId === selectedPage.slideId);
  return <main className="presales-workspace" id="main-content">
    <header className="presales-workspace__intro"><div><p>售前 v3 · {readOnly ? '历史只读' : '冻结页面'}</p><h1>{snapshot.summary.name}</h1><small>源项目 {snapshot.origin.sourceProjectId} · 源修订 {snapshot.origin.sourceRevision} · 副本独立保存，原项目保持不变</small></div><button onClick={() => fire(refresh().catch(caught => { setError(errorText(caught)); }))}>重新核对状态</button></header>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    <Gallery key={projectId} model={model} readOnly={readOnly} initialPageId={initialPageId} initialVersionId={initialVersionId} onDirtyChange={setGalleryDirty} onPageChange={setSelectedPageId}
      loadImage={async identity => {
        const match = snapshot.pages.flatMap(p => p.versions.map(v => ({ p, v }))).find(({ v }) => v.image?.assetId === identity.id && v.image.sha256 === identity.sha256);
        if (!match) throw new Error('图片身份已变化');
        const image = await adapter.readImage({ projectId, slideId: match.p.slideId, versionId: match.v.versionId, assetId: identity.id, sha256: identity.sha256 });
        if (image.mimeType !== 'image/png') throw new Error('图片类型不匹配');
        return `data:image/png;base64,${image.base64}`;
      }}
      onGenerate={id => enqueue([id], null)} onBatchGenerate={batch => enqueue(batch.pageIds, null)} onEdit={ref => enqueue([ref.pageId], ref)}
      onAdopt={ref => versionAction(ref, 'adopt')} onRestore={ref => versionAction(ref, 'restore')}
      onApprove={(ref, checks) => versionAction(ref, 'approve', checks)}
      onSaveFeedback={async (ref, value) => {
        const { currentPage } = exact(ref); const existing = currentPage.feedbackDrafts.find(draft => draft.baseVersionId === ref.versionId);
        const saved = await action(`${ref.pageId}:feedback:${ref.versionId}`, () => adapter.saveFeedback({ projectId, slideId: ref.pageId, baseVersionId: ref.versionId, expectedRevision: existing?.revision ?? 0, text: value }));
        return { text: saved.text, revision: saved.revision };
      }}
      onQueueChange={change => action('settings', async () => { await adapter.settings(change.concurrency ?? queue.settings.concurrency, change.paused ?? queue.settings.paused); })}
      onCancelJob={readOnly ? undefined : async id => { const job = [...queue.jobs].reverse().find(item => item.kind === 'image' && item.projectId === projectId && item.slideId === id); if (!job) throw new Error('未找到任务'); await action(`${id}:cancel`, () => adapter.cancel('image', job.requestId)); }}
    />
    {!readOnly && selectedPage && (() => {
      const stored = selectedPage.feedbackDrafts.find(draft => draft.baseVersionId === null);
      const acknowledged = preFeedbackAcknowledged[selectedPage.slideId];
      const baseline = acknowledged && acknowledged.revision >= (stored?.revision ?? 0) ? acknowledged.text : stored?.text ?? '';
      const value = preFeedbackText[selectedPage.slideId] ?? baseline;
      return <PreVersionFeedbackEditor pageNumber={selectedPage.ordinal} text={value} baseline={baseline} busy={Boolean(pending[`pre-feedback:${selectedPage.slideId}`])} error={preFeedbackError[selectedPage.slideId] ?? null}
        onChange={text => setPreFeedbackText(previous => ({ ...previous, [selectedPage.slideId]: text }))}
        onSave={() => void (async () => { const id = selectedPage.slideId; setPreFeedbackError(previous => ({ ...previous, [id]: '' })); try { const result = await action(`pre-feedback:${id}`, () => adapter.saveFeedback({ projectId, slideId: id, baseVersionId: null, expectedRevision: stored?.revision ?? 0, text: value })); setPreFeedbackAcknowledged(previous => ({ ...previous, [id]: { revision: result.revision, text: result.text } })); } catch (caught) { setPreFeedbackError(previous => ({ ...previous, [id]: errorText(caught) })); } })()}
      />;
    })()}
    {!readOnly && selectedPage && <section className="presales-workspace__panel" aria-label="页面参考图"><h2>第 {selectedPage.ordinal} 页参考图</h2><p>选择系统文件后由本机验证并复制；仅作为风格、布局或构图参考，不替换文字内容。</p>
      <div className="presales-workspace__actions">{(['style', 'layout', 'composition'] as const).map(purpose => <button key={purpose} disabled={Boolean(pending[`reference:${selectedPage.slideId}`])} onClick={() => fire(action(`reference:${selectedPage.slideId}`, async () => { const next = await adapter.pickReference({ projectId, slideId: selectedPage.slideId, expectedRevision: selectedPage.revision, purpose }); if (next === null) setNotice('已取消选择，页面未修改。'); }))}>{({ style: '选择风格参考', layout: '选择布局参考', composition: '选择构图参考' })[purpose]}</button>)}</div>
      {selectedPage.references.map(reference => <div key={`${reference.image.assetId}:${reference.purpose}`}><span>{reference.purpose} · {reference.image.assetId}</span> <button onClick={() => fire(action(`reference:${selectedPage.slideId}`, () => adapter.setReferences(projectId, selectedPage.slideId, selectedPage.revision, selectedPage.references.filter(item => item !== reference))))}>移除此参考</button></div>)}
      {!queue.capabilities?.referenceEditing && <p>参考图可附加，但当前模型编辑能力未确认：{queue.capabilities?.reason ?? '等待能力确认'}</p>}</section>}
    {!readOnly && selectedJob && <section className="presales-workspace__panel" aria-label="任务恢复"><h2>任务恢复</h2><p>{selectedJob.status}{selectedJob.error ? ` · ${selectedJob.error}` : ''}</p><div className="presales-workspace__actions">
      {['result_ready', 'committing'].includes(selectedJob.status) && <button onClick={() => fire(action('retry-save', () => adapter.retrySave()))}>仅重试本地保存</button>}
      {['outcome_unknown', 'cancel_requested'].includes(selectedJob.status) && <button onClick={() => { if (window.confirm('远端可能仍会完成并计费。确认放弃占位且承担重复执行风险？')) fire(action('abandon', () => adapter.abandon('image', selectedJob.requestId))); }}>确认风险并放弃占位</button>}
      {selectedJob.status === 'failed' && <button onClick={() => fire(enqueue([selectedPage!.slideId], null).catch(caught => { setError(errorText(caught)); }))}>明确创建新请求</button>}
    </div></section>}
  </main>;
}
