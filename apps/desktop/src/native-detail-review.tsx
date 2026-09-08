import { useEffect, useState } from 'react';
import type { NativePptPipeline } from '../../worker/src/native-pipeline.js';
import type { DesktopAdapter } from './desktop-adapter.js';
import type { ProjectEdit } from './project-edits.js';
import { DetailEditor } from './detail-editor.js';
import { describeOutlineChanges, detailDocumentError, hasOutlineChanges, type DetailDocument } from './detail-document.js';
import './native-detail-review.css';

interface DetailDraft {
  baseline: NativePptPipeline; value: DetailDocument; savedKey: string; conflict: boolean;
}
function loadedDraft(pipeline: NativePptPipeline): DetailDraft | null {
  const pending = pipeline.outlineRevisionDraft;
  const value = pending ? { outline: pending.outline, specs: pending.specs } : pipeline.outline && pipeline.slideSpecs
    ? { outline: pipeline.outline.value, specs: pipeline.slideSpecs.value } : null;
  return value ? { baseline: structuredClone(pipeline), value: structuredClone(value), savedKey: JSON.stringify(value), conflict: false } : null;
}
export function useNativeDetailDraft(pipeline: NativePptPipeline | null, edit: ProjectEdit | null) {
  const [draft, setDraft] = useState<DetailDraft | null>(null);
  useEffect(() => {
    if (!pipeline) return;
    setDraft((previous) => {
      if (!previous || previous.baseline.project.id !== pipeline.project.id) return loadedDraft(pipeline);
      if (edit?.status === 'failed' && /版本冲突|revision conflict/i.test(edit.error ?? '') &&
        edit.identity.expectedRevision === previous.baseline.revision) return { ...previous, conflict: true };
      if (pipeline.revision <= previous.baseline.revision) return previous;
      const dirty = JSON.stringify(previous.value) !== previous.savedKey;
      const ownSave = edit?.status === 'completed' && edit.pipeline?.revision === pipeline.revision &&
        edit.identity.expectedRevision === previous.baseline.revision && 'payloadKey' in edit.identity &&
        // A details-only save cannot persist local purpose or other outline edits.
        // Revision saves below already match the complete outline/spec document.
        (edit.kind !== 'details.save' || (!previous.baseline.outlineRevisionDraft &&
          JSON.stringify(previous.value.outline) === JSON.stringify(previous.baseline.outline?.value))) &&
        edit.identity.payloadKey === JSON.stringify(edit.kind === 'details.save' ? previous.value.specs : previous.value);
      if (dirty && !ownSave) return { ...previous, conflict: true };
      return loadedDraft(pipeline);
    });
  }, [pipeline, edit]);
  return {
    draft,
    dirty: Boolean(draft && JSON.stringify(draft.value) !== draft.savedKey),
    change: (value: DetailDocument) => setDraft((previous) => previous ? { ...previous, value } : previous),
    discard: (latest: NativePptPipeline) => setDraft(loadedDraft(latest)),
  };
}

export function NativeDetailReview({ pipeline, adapter, state, busy, promptContextDirty, run, onReload }: {
  pipeline: NativePptPipeline; adapter: DesktopAdapter; state: ReturnType<typeof useNativeDetailDraft>;
  busy: boolean; promptContextDirty: boolean;
  run: (operation: () => Promise<NativePptPipeline>, success: string) => Promise<boolean>;
  onReload: (pipeline: NativePptPipeline) => void;
}) {
  const [cancelConfirmation, setCancelConfirmation] = useState(false);
  const { draft, dirty } = state;
  if (!draft) return null;
  const { baseline, value, conflict } = draft;
  const editable = pipeline.project.workflowStatus === 'detail_review' && pipeline.slideSpecs?.version.status === 'draft';
  const pending = baseline.outlineRevisionDraft;
  const validation = detailDocumentError(value);
  const structureChanges = describeOutlineChanges(baseline.outline!.value, value.outline);
  const invalid = Boolean(validation);
  const save = () => {
    if (busy || !editable || !dirty || conflict || invalid) return;
    const projectId = baseline.project.id;
    if (pending || hasOutlineChanges(baseline.outline!.value, value.outline)) {
      const at = new Date().toISOString();
      void run(() => adapter.saveOutlineRevision(projectId, {
        id: pending?.id ?? `revision-${crypto.randomUUID()}`,
        baseOutlineVersionId: pending?.baseOutlineVersionId ?? baseline.outline!.version.id,
        ...value, createdAt: pending?.createdAt ?? at, updatedAt: at,
      }, baseline.revision), '修订已保存，需先确认大纲结构变更。');
    } else {
      void run(() => adapter.saveDetails(projectId, value.specs, baseline.revision), '已保存，待审核。');
    }
  };
  return <section className="native-detail-review" aria-label={editable ? '审核全部页面细化' : '已批准细化（只读）'}>
    <div className="native-detail-actions">
      <h2>{editable ? '4. 审核全部页面细化' : '已批准细化（只读）'}</h2>
      <p>{value.specs.length} 页 · {dirty ? '有未保存的修改，请先保存，再批准。' : editable ? '已保存，待审核' : '已批准，内容只读'}</p>
      {editable && <div className="review-actions">
        <button className="button button-secondary" disabled={busy || !dirty || conflict || invalid} onClick={save}>保存修改</button>
        <button className="button button-primary" disabled={busy || dirty || conflict || invalid || Boolean(pending) || promptContextDirty}
          onClick={() => void run(() => adapter.approveDetails(baseline.project.id, baseline.revision), '全部页面细化已批准并冻结。')}>批准全部细化</button>
      </div>}
      {validation && <p role="alert">{validation}</p>}
      {conflict && <div role="alert"><p>版本冲突：其他操作已更新项目。你的输入已保留，无法覆盖最新版本。</p>
        <button className="button button-secondary" disabled={busy} onClick={() => {
          if (!window.confirm('放弃全部未保存修改并载入最新版本？')) return;
          void run(async () => { const latest = await adapter.loadProjectPipeline(baseline.project.id); state.discard(latest); onReload(latest); return latest; }, '已载入最新版本。');
        }}>放弃修改并载入最新版本</button></div>}
    </div>
    {editable && (pending || structureChanges.length > 0) && <section className="native-revision-summary" aria-label="大纲结构变更摘要">
      <h3>{pending ? '需先确认大纲结构变更' : '结构变更尚未保存'}</h3>
      <ul>{structureChanges.map((change, index) => <li key={index}>{change}</li>)}</ul>
      {pending && <>
        <p>结构确认仅批准新大纲；细化仍需另行审核批准。</p>
        <div className="review-actions">
          <button className="button button-primary" disabled={busy || dirty || conflict || invalid || promptContextDirty}
            onClick={() => void run(() => adapter.approveOutlineRevision(baseline.project.id, pending.id, pending.baseOutlineVersionId, baseline.revision), '结构变更已确认，请继续审核全部细化。')}>确认结构变更</button>
          <button className="button button-secondary" disabled={busy || conflict} onClick={() => setCancelConfirmation(true)}>放弃结构修订</button>
        </div>
        {cancelConfirmation && <div role="alert"><p>将同时放弃本次结构修订及其中的内容修改（包括未保存修改），恢复修订前的已保存内容。修订快照仍保留在历史中。</p>
          <button className="button button-secondary" disabled={busy} onClick={() => setCancelConfirmation(false)}>继续编辑</button>
          <button className="button button-primary" disabled={busy} onClick={() => void run(async () => {
            const next = await adapter.cancelOutlineRevision(baseline.project.id, pending.id, pending.baseOutlineVersionId, baseline.revision);
            state.discard(next); setCancelConfirmation(false); return next;
          }, '结构修订已放弃，已恢复修订前内容。')}>确认放弃结构与内容修改</button>
        </div>}
      </>}
    </section>}
    <DetailEditor value={value} analysis={pipeline.analysis?.output ?? null} sources={pipeline.sources}
      readOnly={!editable} disabled={busy || conflict} onChange={state.change} />
    {(pipeline.revisionHistory?.length ?? 0) > 0 && <details className="native-revision-history">
      <summary>结构修订历史（只读）</summary>
      {pipeline.revisionHistory!.map((history) => <details key={history.id}>
        <summary>{history.status === 'confirmed' ? '已确认' : '已放弃'} · {history.decidedAt}</summary>
        <p>基础大纲 {history.baseOutline.version.id} · {history.newOutlineVersionId ? `新大纲 ${history.newOutlineVersionId}` : '未产生新的批准'}</p>
        <details><summary>修订前的已保存内容</summary><DetailEditor value={{ outline: history.baseOutline.value, specs: history.baseSlideSpecs.value }}
          analysis={pipeline.analysis?.output ?? null} sources={pipeline.sources} readOnly disabled={false}
          idPrefix={`history-${history.id}-base`} onChange={() => {}} /></details>
        <details><summary>修订草稿快照</summary><DetailEditor value={{ outline: history.draft.outline, specs: history.draft.specs }}
          analysis={pipeline.analysis?.output ?? null} sources={pipeline.sources} readOnly disabled={false}
          idPrefix={`history-${history.id}-draft`} onChange={() => {}} /></details>
      </details>)}
    </details>}
    <details><summary>历史批准证据（只读）</summary><ul>{pipeline.approvals.map((approval) => <li key={approval.id}>
      {approval.stage === 'outline_review' ? '大纲批准' : approval.stage === 'detail_review' ? '细化批准' : '视觉批准'} · {approval.versionId} · {approval.decidedAt}
    </li>)}</ul></details>
  </section>;
}
