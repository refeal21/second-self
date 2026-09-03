import { useEffect, useMemo, useState, type ChangeEvent, type ReactNode } from 'react';
import type { DesktopAdapter } from './desktop-adapter.js';
import type { NativePptPipeline } from '../../worker/src/native-pipeline.js';
import type { PptOutline, SlideSpec } from '../../worker/src/ppt-project.js';

export function NativeWorkspacePage({
  adapter,
  projectId,
  projectName,
  projectGoal,
  onBack,
}: {
  adapter: DesktopAdapter;
  projectId: string;
  projectName: string;
  projectGoal: string;
  onBack: () => void;
}) {
  const [pipeline, setPipeline] = useState<NativePptPipeline | null>(null);
  const [outlineText, setOutlineText] = useState('');
  const [detailsText, setDetailsText] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  const update = async (operation: () => Promise<NativePptPipeline>, success: string) => {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const next = await operation();
      setPipeline(next); setNotice(success);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setBusy(false); }
  };

  useEffect(() => {
    let active = true;
    setBusy(true);
    void adapter.loadProjectPipeline(projectId).then((loaded) => {
      if (active) setPipeline(loaded);
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : String(reason));
    }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [adapter, projectId]);

  useEffect(() => {
    if (pipeline?.outline) setOutlineText(JSON.stringify(pipeline.outline.value, null, 2));
    if (pipeline?.slideSpecs) setDetailsText(JSON.stringify(pipeline.slideSpecs.value, null, 2));
  }, [pipeline?.outline?.version.id, pipeline?.slideSpecs?.version.id]);

  const currentSpec = useMemo(() => pipeline?.slideSpecs?.value.find(
    ({ id }) => id === pipeline.currentSlideId,
  ) ?? null, [pipeline]);

  const attachFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.target.files ?? [])];
    for (const file of files) {
      await update(async () => adapter.attachSource(projectId, {
        fileName: file.name,
        mediaType: file.type || 'application/octet-stream',
        contentsBase64: bytesToBase64(new Uint8Array(await file.arrayBuffer())),
      }), `已安全附加 ${file.name}`);
    }
    event.target.value = '';
  };

  const replaceVisual = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !pipeline?.currentSlideId) return;
    const slideId = pipeline.currentSlideId;
    await update(async () => adapter.replaceVisual(
      projectId, slideId,
      bytesToBase64(new Uint8Array(await file.arrayBuffer())),
      `用户上传的完整幻灯片：${file.name}`,
    ), '替换 PNG 已保存，可批准当前页。');
    event.target.value = '';
  };

  if (!pipeline) {
    return <main id="main-content" className="workspace-unavailable"><h1>{projectName}</h1><p>{error || '正在恢复完整工作流检查点…'}</p></main>;
  }

  const status = pipeline.project.workflowStatus;
  const currentVisual = pipeline.currentSlideId
    ? pipeline.visuals[pipeline.currentSlideId]?.at(-1)
    : undefined;
  const canApproveCurrent = currentVisual?.version.status === 'draft' && currentVisual.byteLength > 0;

  return (
    <main id="main-content" className="workspace-shell native-workspace">
      <header className="workspace-header">
        <div>
          <button className="button button-secondary" onClick={onBack}>返回 PPT 项目</button>
          <h1>{projectName}</h1><p className="project-goal">{projectGoal}</p>
        </div>
        <div><strong>{stageLabel(status)}</strong><p>检查点 r{pipeline.revision}</p></div>
      </header>
      {(notice || error) && <p className={error ? 'app-notice is-error' : 'app-notice'} role={error ? 'alert' : 'status'}>{error || notice}</p>}
      <div className="workspace-layout">
        <aside className="workflow-rail" aria-label="PPT 工作流">
          <ol>{['intake','source_analysis','outline_review','detail_review','visual_review','conversion','qa','completed'].map((stage, index) => (
            <li key={stage} className={stage === status || (status === 'blocked' && stage === 'visual_review') ? 'is-current' : ''}>
              <span className="stage-mark">{index + 1}</span>{stageLabel(stage)}
            </li>
          ))}</ol>
          <h3>项目材料</h3>
          <ul className="source-list">{pipeline.sources.map((source) => <li key={source.id}>{source.fileName}<small>{source.byteLength} bytes</small></li>)}</ul>
          {status === 'intake' && <label className="button button-secondary">选择材料<input hidden type="file" multiple onChange={(event) => void attachFiles(event)} /></label>}
        </aside>

        <section className="canvas-area" aria-live="polite">
          {status === 'intake' && <StageCard title="1. 附加材料">
            <p>只会读取你主动选择的文件。附加后由 Codex 从项目 sources 目录进行可追溯分析。</p>
            <button className="button button-primary" disabled={busy || pipeline.sources.length === 0} onClick={() => void update(() => adapter.analyzeProject(projectId), '材料分析已保存。')}>用 Codex 分析材料</button>
          </StageCard>}
          {status === 'source_analysis' && <StageCard title="2. 材料分析">
            <pre>{JSON.stringify(pipeline.analysis?.output, null, 2)}</pre>
            <button className="button button-primary" disabled={busy} onClick={() => void update(() => adapter.generateOutline(projectId), '整份大纲已生成，等待你审核。')}>生成整份大纲</button>
          </StageCard>}
          {status === 'outline_review' && <StageCard title="3. 审核整份大纲">
            <textarea rows={22} value={outlineText} onChange={(event) => setOutlineText(event.target.value)} />
            <div className="review-actions">
              <button className="button button-secondary" disabled={busy || pipeline.outline?.version.status === 'frozen'} onClick={() => void update(() => adapter.saveOutline(projectId, parseJson<PptOutline>(outlineText)), '大纲修改已保存。')}>保存修改</button>
              <button className="button button-primary" disabled={busy || pipeline.outline?.version.status !== 'draft'} onClick={() => void update(() => adapter.approveOutline(projectId), '大纲已批准并冻结。')}>批准整份大纲</button>
            </div>
          </StageCard>}
          {status === 'detail_review' && !pipeline.slideSpecs && <StageCard title="4. 生成全部页面细化">
            <p>已批准大纲不会被后续操作覆盖。</p>
            <button className="button button-primary" disabled={busy} onClick={() => void update(() => adapter.generateDetails(projectId), '全部页面细化已生成。')}>生成逐页细化</button>
          </StageCard>}
          {status === 'detail_review' && pipeline.slideSpecs && <StageCard title="4. 审核全部页面细化">
            <textarea rows={24} value={detailsText} onChange={(event) => setDetailsText(event.target.value)} />
            <div className="review-actions">
              <button className="button button-secondary" disabled={busy || pipeline.slideSpecs.version.status === 'frozen'} onClick={() => void update(() => adapter.saveDetails(projectId, parseJson<SlideSpec[]>(detailsText)), '逐页细化修改已保存。')}>保存修改</button>
              <button className="button button-primary" disabled={busy || pipeline.slideSpecs.version.status !== 'draft'} onClick={() => void update(() => adapter.approveDetails(projectId), '全部页面细化已批准并冻结。')}>批准全部细化</button>
            </div>
          </StageCard>}
          {(status === 'visual_review' || status === 'blocked') && <StageCard title={`5. 逐页视觉·${currentSpec?.title ?? pipeline.currentSlideId}`}>
            <p>{currentSpec?.imageGenerationBrief}</p>
            {pipeline.blockedCondition && <p className="capability-note">{pipeline.blockedCondition.message}不会切换到收费 API。</p>}
            {currentVisual?.relativePath && <dl><dt>当前候选</dt><dd>{currentVisual.relativePath}</dd><dt>SHA-256</dt><dd>{currentVisual.sha256}</dd></dl>}
            <div className="review-actions">
              {!currentVisual && <button className="button button-secondary" disabled={busy} onClick={() => void update(() => adapter.requestVisual(projectId, pipeline.currentSlideId!), 'ImageGen 请求已处理。')}>生成当前页</button>}
              <label className="button button-secondary">上传替换 PNG<input hidden type="file" accept="image/png" onChange={(event) => void replaceVisual(event)} /></label>
              <button className="button button-primary" disabled={busy || !canApproveCurrent} onClick={() => void update(() => adapter.approveVisual(projectId, pipeline.currentSlideId!), '当前页已批准，检查点已保存。')}>批准当前页</button>
            </div>
          </StageCard>}
          {status === 'conversion' && <StageCard title="6. 转换可编辑 PPTX">
            <p>已批准规格是文字和数据真源，完整页 PNG 只作视觉参考。</p>
            <button className="button button-primary" disabled={busy} onClick={() => void update(async () => { await adapter.exportProject(projectId, projectName); return adapter.loadProjectPipeline(projectId); }, '可编辑 PPTX 已生成，正在等待 QA。')}>导出可编辑 PPTX</button>
          </StageCard>}
          {status === 'qa' && <StageCard title="7. 自动 QA">
            <p>导出产物：{pipeline.exportReceipt?.relativePath}</p>
            <p>尚未完成 LibreOffice 验证。工作流保持在 QA，不会显示虚假完成。</p>
          </StageCard>}
        </section>
        <aside className="review-inspector">
          <h2>真实检查点</h2>
          <p>状态：{status}</p><p>任务记录：{pipeline.tasks.length}</p>
          <p>审批记录：{pipeline.approvals.length}</p>
          <p>产物哈希：{pipeline.exportReceipt?.sha256 ?? '尚无'}</p>
          <button className="button button-secondary" disabled={busy || pipeline.approvals.length === 0} onClick={() => void (async () => {
            setBusy(true); setError('');
            try { const result = await adapter.proposeProjectMemory(projectId); setNotice(result.status); }
            catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
            finally { setBusy(false); }
          })()}>请 AI 提议可复用偏好</button>
        </aside>
      </div>
    </main>
  );
}

function StageCard({ title, children }: { title: string; children: ReactNode }) {
  return <article className="project-create"><h2>{title}</h2>{children}</article>;
}

function parseJson<T>(value: string): T {
  try { return JSON.parse(value) as T; }
  catch { throw new Error('JSON 格式不正确，已保留原检查点。'); }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function stageLabel(stage: string): string {
  return ({ intake: '材料', source_analysis: '材料分析', outline_review: '大纲审批',
    detail_review: '逐页细化', visual_review: '视觉审批', blocked: '可恢复阻塞',
    conversion: '可编辑转换', qa: '质量检查', completed: '已完成' } as Record<string, string>)[stage] ?? stage;
}
