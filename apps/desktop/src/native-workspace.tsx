import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
  type SyntheticEvent,
} from 'react';
import type { DesktopAdapter } from './desktop-adapter.js';
import type { NativePptPipeline, NativePromptContext } from '../../worker/src/native-pipeline.js';
import type { PptOutline } from '../../worker/src/ppt-project.js';
import type { ProjectGeneration } from './project-generation.js';
import type { ProjectEdit } from './project-edits.js';
import { DetailPageIndex } from './detail-editor.js';
import { NativeDetailReview, useNativeDetailDraft } from './native-detail-review.js';
import { OutlineEditor, outlineDraftError } from './outline-editor.js';
import {
  buildPptPrompt,
  getPromptContext,
  promptContextError,
  type PptPromptStage,
} from './ppt-prompts.js';

export function NativeWorkspacePage({
  adapter,
  projectId,
  projectName,
  projectGoal,
  onBack,
  onDirtyChange,
}: {
  adapter: DesktopAdapter;
  projectId: string;
  projectName: string;
  projectGoal: string;
  onBack: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [pipeline, setPipeline] = useState<NativePptPipeline | null>(null);
  const [outlineDraft, setOutlineDraft] = useState<PptOutline | null>(null);
  const [edit, setEdit] = useState<ProjectEdit | null>(() => adapter.getProjectEdit(projectId));
  const detailState = useNativeDetailDraft(pipeline, edit);
  const [localBusy, setLocalBusy] = useState(false);
  const [generation, setGeneration] = useState<ProjectGeneration | null>(
    () => adapter.getProjectGeneration(projectId),
  );
  const [elapsedNow, setElapsedNow] = useState(() => Date.now());
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [visualFeedback, setVisualFeedback] = useState('');
  const [previewSrc, setPreviewSrc] = useState('');
  const [previewState, setPreviewState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [promptContext, setPromptContext] = useState<NativePromptContext>({
    taskBrief: '', sourceInstructions: {}, outlineRequirements: '',
  });
  const [contextConfirmation, setContextConfirmation] = useState('');
  const [promptContextExpanded, setPromptContextExpanded] = useState(false);
  const mounted = useRef(true);
  const pipelineRef = useRef<NativePptPipeline | null>(null);
  const busy = localBusy || generation?.status === 'running' || edit?.status === 'running';
  const editUncertain = edit?.status === 'failed' && /尚未核实/.test(edit.error ?? '');

  const applyPipeline = (next: NativePptPipeline, onlyIfNewer = false) => {
    const current = pipelineRef.current;
    if (onlyIfNewer && current?.project.id === next.project.id && next.revision <= current.revision) return false;
    pipelineRef.current = next;
    setPipeline(next);
    return true;
  };

  const update = async (operation: () => Promise<NativePptPipeline>, success: string) => {
    if (busy) return false;
    setLocalBusy(true); setError(''); setNotice('');
    try {
      const next = await operation();
      if (!mounted.current) return true;
      applyPipeline(next); setNotice(success);
      return true;
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason));
      return false;
    } finally { if (mounted.current) setLocalBusy(false); }
  };

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => adapter.subscribeProjectGeneration(projectId, (next) => {
    setGeneration(next);
    if (next?.status === 'running') {
      setError('');
      setNotice('');
    } else if (next?.status === 'completed' && next.kind === 'memory') {
      const status = memoryGenerationStatus(next);
      if (status) {
        setError('');
        setNotice(status);
      }
    } else if (next?.status === 'completed' && next.pipeline) {
      if (applyPipeline(next.pipeline, true)) {
        setError('');
        setNotice(generationSuccessLabel(next.kind));
      }
    } else if (next?.status === 'failed' && generationMatchesPipeline(next, pipelineRef.current)) {
      setNotice('');
      setError(next.error || '生成失败，请重试。');
    }
  }), [adapter, projectId]);

  useEffect(() => {
    if (generation?.status !== 'running') return;
    setElapsedNow(Date.now());
    const timer = window.setInterval(() => setElapsedNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [generation?.operationId, generation?.status]);

  useEffect(() => adapter.subscribeProjectEdit(projectId, (next) => {
    setEdit(next);
    if (next?.status === 'completed' && next.pipeline) applyPipeline(next.pipeline, true);
    if (next?.status === 'failed') setError(next.error ?? '编辑操作失败，请重试。');
  }), [adapter, projectId]);

  useEffect(() => {
    let active = true;
    setLocalBusy(true);
    void adapter.loadProjectPipeline(projectId).then((loaded) => {
      if (active) {
        if (applyPipeline(loaded, true)) {
          setPromptContext(normalizePromptContext(loaded, getPromptContext(loaded)));
          const savedEdit = adapter.getProjectEdit(projectId);
          const relevantEditFailure = savedEdit?.status === 'failed' &&
            (savedEdit.identity.expectedRevision === loaded.revision || /尚未核实/.test(savedEdit.error ?? ''));
          if (!generationMatchesPipeline(adapter.getProjectGeneration(projectId), loaded) && !relevantEditFailure) {
            setError('');
            setNotice('');
          }
        }
      }
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : String(reason));
    }).finally(() => { if (active) setLocalBusy(false); });
    return () => { active = false; };
  }, [adapter, projectId]);

  const savedOutlineKey = JSON.stringify(pipeline?.outline?.value ?? null);
  useEffect(() => {
    // Saving a draft retains its version ID. Sync only when persisted content
    // changes, never when an unrelated checkpoint response refreshes the page.
    setOutlineDraft(JSON.parse(savedOutlineKey) as PptOutline | null);
  }, [projectId, savedOutlineKey]);

  const savedPromptContextKey = pipeline ? JSON.stringify(getPromptContext(pipeline)) : '';
  useEffect(() => {
    if (!pipeline) return;
    setPromptContext(normalizePromptContext(pipeline, getPromptContext(pipeline)));
    setContextConfirmation('');
  }, [projectId, savedPromptContextKey]);

  const workflowStatus = pipeline?.project.workflowStatus;
  useEffect(() => {
    setPromptContextExpanded(workflowStatus === 'intake');
  }, [projectId, workflowStatus]);

  const currentSpec = useMemo(() => pipeline?.slideSpecs?.value.find(
    ({ id }) => id === pipeline.currentSlideId,
  ) ?? null, [pipeline]);
  const currentVisual = useMemo(() => pipeline?.currentSlideId
    ? pipeline.visuals[pipeline.currentSlideId]?.at(-1)
    : undefined, [pipeline]);
  const approvedVisuals = useMemo(() => (pipeline?.slideSpecs?.value ?? []).flatMap((spec, index) => {
    const visual = pipeline?.visuals[spec.id]?.at(-1);
    return visual?.version.status === 'frozen' ? [{ spec, visual, page: index + 1 }] : [];
  }), [pipeline]);

  useEffect(() => {
    let active = true;
    setPreviewSrc('');
    setPreviewState(currentVisual?.relativePath ? 'loading' : 'idle');
    if (!currentVisual?.relativePath) return () => { active = false; };
    void adapter.readProjectVisual(projectId, currentVisual.relativePath).then((contents) => {
      if (!active) return;
      setPreviewSrc(contents.startsWith('data:') ? contents : `data:image/png;base64,${contents}`);
    }).catch((reason: unknown) => {
      if (!active) return;
      setPreviewState('error');
      setError(`无法加载当前 PNG：${reason instanceof Error ? reason.message : String(reason)}`);
    });
    return () => { active = false; };
  }, [adapter, projectId, currentVisual?.relativePath, currentVisual?.sha256]);

  useEffect(() => {
    setVisualFeedback('');
  }, [pipeline?.currentSlideId]);

  const outlineDirty = pipeline?.project.workflowStatus === 'outline_review' &&
    outlineDraft !== null && JSON.stringify(outlineDraft) !== savedOutlineKey;
  const promptContextDirty = pipeline !== null &&
    JSON.stringify(normalizePromptContext(pipeline, promptContext)) !==
    JSON.stringify(normalizePromptContext(pipeline, getPromptContext(pipeline)));
  useEffect(() => {
    onDirtyChange?.(outlineDirty || promptContextDirty || detailState.dirty);
  }, [onDirtyChange, outlineDirty, promptContextDirty, detailState.dirty]);
  useEffect(() => () => { onDirtyChange?.(false); }, [onDirtyChange]);

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
    return <main id="main-content" className="workspace-unavailable"><h1>{projectName}</h1><p role={error ? 'alert' : 'status'}>{error || generationRunningLabel(generation) || '正在恢复完整工作流检查点…'}</p>
      {editUncertain && <button className="button button-primary" disabled={busy} onClick={() => void update(() => adapter.retryProjectEdit(projectId), '已核实原编辑提交。')}>核实并重试原操作</button>}</main>;
  }

  const status = pipeline.project.workflowStatus;
  const visualBlocked = status === 'blocked' && pipeline.blockedCondition?.resumeStage === 'visual_review';
  const visualGenerationRunning = generation?.status === 'running' && generation.kind === 'visual';
  const qaBlocked = status === 'blocked' && pipeline.blockedCondition?.resumeStage === 'qa';
  const canApproveCurrent = currentVisual?.version.status === 'draft' &&
    currentVisual.byteLength > 0 && previewState === 'ready';
  const savedPromptContext = normalizePromptContext(pipeline, getPromptContext(pipeline));
  const normalizedPromptContext = normalizePromptContext(pipeline, promptContext);
  const outlineValidationError = outlineDraft ? outlineDraftError(outlineDraft) : '尚无可审核的大纲。';
  const outlineEditable = status === 'outline_review' && pipeline.outline?.version.status === 'draft';
  const contextValidationError = promptContextError(pipeline, normalizedPromptContext);
  const contextEditable = status === 'intake' || status === 'source_analysis' ||
    (status === 'outline_review' && pipeline.outline?.version.status !== 'frozen');
  const promptStage = promptStageFor(status);
  const showPromptPreview = status === 'intake' || status === 'source_analysis' ||
    status === 'outline_review' || status === 'detail_review';

  const savePromptContext = async (confirmed = false) => {
    if (!promptContextDirty || contextValidationError || !contextEditable || busy || outlineDirty) return;
    const confirmation = promptInvalidationMessage(pipeline, savedPromptContext, normalizedPromptContext);
    if (confirmation && !confirmed) {
      setContextConfirmation(confirmation);
      return;
    }
    setContextConfirmation('');
    await update(
      () => adapter.saveProjectContext(projectId, normalizedPromptContext),
      '生成说明已保存；不会自动开始 AI 生成。',
    );
  };

  const updatePromptContext = (next: NativePromptContext) => {
    setPromptContext(next);
    setContextConfirmation('');
  };

  const backToProjects = () => {
    // App handles sidebar/history navigation too; standalone consumers still
    // get a local guard without displaying a second confirmation in App.
    if (!onDirtyChange && (promptContextDirty || outlineDirty || detailState.dirty) &&
      !window.confirm('大纲、逐页细化、结构修订或生成说明尚未保存。返回 PPT 项目将丢弃这些修改，是否继续？')) return;
    onBack();
  };

  const validatePreview = (event: SyntheticEvent<HTMLImageElement>) => {
    const { naturalWidth: width, naturalHeight: height } = event.currentTarget;
    const reasonable = width >= 640 && height >= 360;
    const ratio = height > 0 ? width / height : 0;
    if (!reasonable || Math.abs(ratio - 16 / 9) > 0.02) {
      setPreviewState('error');
      setError('当前 PNG 必须是合理尺寸的 16:9 图片（至少 640×360）。');
      return;
    }
    setError('');
    setPreviewState('ready');
  };

  const proposeMemory = async () => {
    if (busy) return;
    setError(''); setNotice('');
    try {
      const result = await adapter.proposeProjectMemory(projectId);
      if (mounted.current) setNotice(result.status);
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  return (
    <main id="main-content" className="workspace-shell native-workspace">
      <header className="workspace-header">
        <div>
          <button className="button button-secondary" onClick={backToProjects}>返回 PPT 项目</button>
          <h1>{projectName}</h1><p className="project-goal">{projectGoal}</p>
        </div>
        <div><strong>{stageLabel(status)}</strong><p>检查点 r{pipeline.revision}</p></div>
      </header>
      {generation?.status === 'running' && <p className="app-notice" role="status">
        {generationRunningLabel(generation)}。
        {generationProgress(generation) && <> {generationProgress(generation)}。</>}
        {' '}已用时 {generationElapsed(generation.startedAt, elapsedNow)}，离开本页后仍会继续。
      </p>}
      {edit?.status === 'running' && <p className="app-notice" role="status">正在保存或确认编辑，请等待持久化结果。离开本页后仍会继续。</p>}
      {editUncertain && <div className="app-notice"><p>原编辑提交结果尚未核实，输入及操作身份已保留。请核实后再继续。</p>
        <button className="button button-primary" disabled={busy} onClick={() => void update(() => adapter.retryProjectEdit(projectId), '已核实原编辑提交。')}>核实并重试原操作</button></div>}
      {(notice || error) && <p className={error ? 'app-notice is-error' : 'app-notice'} role={error ? 'alert' : 'status'}>{error || notice}</p>}
      <div className="workspace-layout">
        <aside className="workflow-rail" aria-label="PPT 工作流">
          <ol>{['intake','source_analysis','outline_review','detail_review','visual_review','conversion','qa','completed'].map((stage, index) => (
            <li key={stage} className={stage === status || (visualBlocked && stage === 'visual_review') || (qaBlocked && stage === 'qa') ? 'is-current' : ''}>
              <span className="stage-mark">{index + 1}</span>{stageLabel(stage)}
            </li>
          ))}</ol>
          {status === 'detail_review' && detailState.draft && <DetailPageIndex value={detailState.draft.value} />}
          <h3>项目材料</h3>
          <ul className="source-list">{pipeline.sources.map((source) => <li key={source.id}>{source.fileName}<small>{source.byteLength} bytes</small></li>)}</ul>
          {status === 'intake' && <label className={`button button-secondary${busy || promptContextDirty ? ' is-disabled' : ''}`} aria-disabled={busy || promptContextDirty}>选择材料<input hidden type="file" multiple disabled={busy || promptContextDirty} onChange={(event) => void attachFiles(event)} /></label>}
        </aside>

        <section className="canvas-area" aria-label="PPT 阶段内容" tabIndex={0} aria-live="polite">
          <details className="native-prompt-context" open={promptContextExpanded}
            onToggle={(event) => setPromptContextExpanded(event.currentTarget.open)}>
            <summary><strong>项目说明与提示词</strong><span>{status === 'intake' ? '填写并保存本次生成说明' : contextEditable ? '展开可编辑本次说明与大纲要求' : '展开查看已保存说明'}</span></summary>
            <div className="native-prompt-context-body">
              <div className="native-prompt-context-heading">
                <p>先保存这里的说明，再继续分析、生成或人工审批。</p>
                <button className="button button-secondary" disabled={busy || outlineDirty || !contextEditable || !promptContextDirty || Boolean(contextValidationError)}
                  onClick={() => void savePromptContext()}>保存说明</button>
              </div>
              <p className="native-carried-goal"><strong>项目目标（自动携带）</strong><span>{projectGoal}</span></p>
              <label>本次任务说明
                <span className="field-help">补充背景、受众和关键信息。</span>
                <textarea aria-label="本次任务说明" rows={4} value={promptContext.taskBrief}
                  readOnly={!contextEditable} disabled={busy}
                  onChange={(event) => updatePromptContext({ ...promptContext, taskBrief: event.target.value })} />
              </label>
              {pipeline.sources.map((source) => <label key={source.id}>{source.fileName} 文件用途说明
                <span className="field-help">说明该文件用于事实、风格或结构，以及需要排除的内容。</span>
                <textarea aria-label={`${source.fileName} 文件用途说明`} rows={3}
                  value={promptContext.sourceInstructions[source.id] ?? ''}
                  readOnly={!contextEditable} disabled={busy}
                  onChange={(event) => {
                    const sourceInstructions = { ...promptContext.sourceInstructions };
                    if (event.target.value) sourceInstructions[source.id] = event.target.value;
                    else delete sourceInstructions[source.id];
                    updatePromptContext({ ...promptContext, sourceInstructions });
                  }} />
              </label>)}
              <label>本次大纲要求（可选）
                <span className="field-help">例如页数、章节顺序、必须包含或避免的内容。</span>
                <textarea aria-label="本次大纲要求（可选）" rows={4} value={promptContext.outlineRequirements}
                  readOnly={!contextEditable} disabled={busy}
                  onChange={(event) => updatePromptContext({ ...promptContext, outlineRequirements: event.target.value })} />
              </label>
              {contextValidationError && <p className="native-context-warning" role="alert">{contextValidationError}</p>}
              {outlineDirty && <p className="native-save-hint">请先保存大纲修改，再更改生成说明。</p>}
              {promptContextDirty && !contextValidationError && <p className="native-save-hint">请先保存说明，再继续生成或审批。</p>}
              {contextConfirmation && <div className="native-context-confirmation" role="alert">
                <p>{contextConfirmation}</p>
                <div className="review-actions">
                  <button className="button button-secondary" disabled={busy} onClick={() => setContextConfirmation('')}>取消保存</button>
                  <button className="button button-primary" disabled={busy || outlineDirty} onClick={() => void savePromptContext(true)}>确认保存并清除</button>
                </div>
              </div>}
              {showPromptPreview && <details className="native-prompt-preview">
                <summary>{promptPreviewLabel(promptStage)}</summary>
                {promptContextDirty && <p>提示词预览只使用已保存的说明。</p>}
                <pre data-testid="native-prompt-preview">{buildPptPrompt(pipeline, promptStage)}</pre>
              </details>}
            </div>
          </details>
          {status === 'intake' && <StageCard title="1. 附加材料">
            <p>只会读取你主动选择的文件。附加后由 Codex 从项目 sources 目录进行可追溯分析。</p>
            <button className="button button-primary" disabled={busy || promptContextDirty || pipeline.sources.length === 0} onClick={() => void update(() => adapter.analyzeProject(projectId), '材料分析已保存。')}>{generationActionLabel('analysis', generation, '用 Codex 分析材料')}</button>
          </StageCard>}
          {status === 'source_analysis' && <StageCard title="2. 材料分析" actions={
            <button className="button button-primary" disabled={busy || promptContextDirty} onClick={() => void update(() => adapter.generateOutline(projectId), '整份大纲已生成，等待你审核。')}>{generationActionLabel('outline', generation, '生成整份大纲')}</button>
          }>
            <pre>{JSON.stringify(pipeline.analysis?.output, null, 2)}</pre>
          </StageCard>}
          {status === 'outline_review' && <StageCard title="3. 审核整份大纲" actions={<div className="review-actions">
            <button className="button button-secondary" disabled={busy || !outlineEditable || !outlineDirty || Boolean(outlineValidationError)}
              onClick={() => { if (outlineDraft && outlineDirty && !outlineValidationError) void update(
                () => adapter.saveOutline(projectId, outlineDraft), '大纲修改已保存。'); }}>保存修改</button>
            <button className="button button-primary" disabled={busy || promptContextDirty || outlineDirty || !outlineEditable || Boolean(outlineValidationError)}
              onClick={() => { if (!outlineDirty && !promptContextDirty && !outlineValidationError) void update(
                () => adapter.approveOutline(projectId), '大纲已批准并冻结。'); }}>批准整份大纲</button>
          </div>}>
            <p className="native-outline-save-state">{outlineDirty ? '有未保存的修改，请先保存，再批准。' : '正在审核已保存的大纲。批准后将冻结，并进入逐页细化。'}</p>
            {outlineValidationError && <p className="native-context-warning">{outlineValidationError}</p>}
            {outlineDraft && <OutlineEditor outline={outlineDraft} analysis={pipeline.analysis?.output ?? null}
              sources={pipeline.sources} readOnly={!outlineEditable} disabled={busy}
              onChange={(next) => { setOutlineDraft(next); setNotice(''); setError(''); }} />}
          </StageCard>}
          {status !== 'outline_review' && pipeline.outline?.version.status === 'frozen' &&
            <details className="native-approved-outline">
              <summary>已批准大纲（只读）</summary>
              <OutlineEditor outline={pipeline.outline.value} analysis={pipeline.analysis?.output ?? null}
                sources={pipeline.sources} readOnly disabled={busy} onChange={() => {}} />
            </details>}
          {status === 'detail_review' && !pipeline.slideSpecs && <StageCard title="4. 生成全部页面细化">
            <p>已批准大纲不会被后续操作覆盖。</p>
            <button className="button button-primary" disabled={busy} onClick={() => void update(() => adapter.generateDetails(projectId), '全部页面细化已生成。')}>{generationActionLabel('details', generation, '生成逐页细化')}</button>
          </StageCard>}
          {status === 'detail_review' && pipeline.slideSpecs && <NativeDetailReview pipeline={pipeline} adapter={adapter} state={detailState}
            busy={busy || editUncertain} promptContextDirty={promptContextDirty} run={update} onReload={applyPipeline} />}
          {status !== 'detail_review' && pipeline.slideSpecs && <details className="native-approved-details">
            <summary>已批准细化（只读）</summary>
            <NativeDetailReview pipeline={pipeline} adapter={adapter} state={detailState}
              busy={busy || editUncertain} promptContextDirty={promptContextDirty} run={update} onReload={applyPipeline} />
          </details>}
          {(status === 'visual_review' || visualBlocked) && <StageCard title={`5. 逐页视觉·${currentSpec?.title ?? pipeline.currentSlideId}`}>
            {!currentVisual && !visualGenerationRunning && <p className="native-outline-save-state">
              当前阶段正在等待生成视觉候选。批准前必须检查完整的 PNG；仅有提示词或任务完成状态不能批准。
            </p>}
            {currentSpec?.imageGenerationBrief && <details className="native-prompt-preview native-visual-prompt">
              <summary>查看完整技术提示词</summary>
              <pre>{currentSpec.imageGenerationBrief}</pre>
            </details>}
            {pipeline.blockedCondition && <p className="capability-note">{pipeline.blockedCondition.message}不会切换到收费 API。</p>}
            {currentVisual?.relativePath && <dl><dt>当前候选</dt><dd>{currentVisual.relativePath}</dd><dt>SHA-256</dt><dd>{currentVisual.sha256}</dd></dl>}
            {currentVisual && previewSrc && <figure className="native-visual-preview">
              <img
                src={previewSrc}
                alt={currentVisual.altText || `第 ${Math.max(1, (pipeline.slideSpecs?.value.findIndex(({ id }) => id === currentVisual.slideId) ?? 0) + 1)} 页视觉候选`}
                onLoad={validatePreview}
                onError={() => {
                  setPreviewState('error');
                  setError('无法加载当前 PNG；请重新生成或上传有效的 16:9 PNG。');
                }}
              />
              <figcaption>{previewState === 'loading' ? '正在安全读取完整 PNG…' : '完整 PNG 预览（16:9）'}</figcaption>
            </figure>}
            {currentVisual && !previewSrc && previewState === 'loading' && <p role="status">正在安全读取完整 PNG…</p>}
            <label className="native-feedback">修改意见
              <textarea aria-label="修改意见" rows={3} value={visualFeedback}
                disabled={busy} onChange={(event) => setVisualFeedback(event.target.value)}
                placeholder="例如：减少装饰，突出数据；不要在图中生成标题文字。" />
            </label>
            <div className="review-actions">
              {!currentVisual && <button className="button button-secondary" disabled={busy} onClick={() => void update(
                () => adapter.requestVisual(projectId, pipeline.currentSlideId!),
                '视觉候选已生成并保存，请检查完整 PNG。',
              )}>{visualActionLabel(generation, false)}</button>}
              {currentVisual && <button className="button button-secondary" disabled={busy || !visualFeedback.trim()} onClick={() => void update(
                () => adapter.requestVisual(projectId, pipeline.currentSlideId!, visualFeedback),
                '视觉候选已生成并保存，请重新检查完整 PNG。',
              )}>{visualActionLabel(generation, true)}</button>}
              <label className={`button button-secondary${busy ? ' is-disabled' : ''}`} aria-disabled={busy}>上传替换 PNG<input hidden type="file" accept="image/png" disabled={busy} onChange={(event) => void replaceVisual(event)} /></label>
              <button className="button button-primary" disabled={busy || !canApproveCurrent} onClick={() => void update(() => adapter.approveVisual(projectId, pipeline.currentSlideId!), '当前页已批准，检查点已保存。')}>批准当前页</button>
            </div>
          </StageCard>}
          {status === 'conversion' && <StageCard title="6. 转换可编辑 PPTX">
            <p>已批准规格是文字和数据真源；完整 PNG 的文字与可编辑对象区域会被清除后作为视觉层写入 PPTX。</p>
            <div className="approved-visuals" aria-label="已批准视觉">
              {approvedVisuals.map(({ spec, page }) => <button key={spec.id} className="button button-secondary"
                disabled={busy} onClick={() => void update(
                  () => adapter.reopenVisual(projectId, spec.id),
                  `第 ${page} 页已重新打开；后续页审批不会被跳过。`,
                )}>重新打开第 {page} 页</button>)}
            </div>
            <button className="button button-primary" disabled={busy} onClick={() => void update(async () => { await adapter.exportProject(projectId, projectName); return adapter.loadProjectPipeline(projectId); }, '可编辑 PPTX 已生成，正在等待 QA。')}>导出可编辑 PPTX</button>
          </StageCard>}
          {(status === 'qa' || qaBlocked) && <StageCard title="7. 自动 QA">
            <p>导出产物：{pipeline.exportReceipt?.relativePath}</p>
            {pipeline.qaReport && <pre>{JSON.stringify(pipeline.qaReport, null, 2)}</pre>}
            {qaBlocked && <p className="capability-note">{pipeline.blockedCondition?.message}</p>}
            <button className="button button-primary" disabled={busy} onClick={() => void update(
              () => adapter.runProjectQa(projectId),
              'LibreOffice QA 已执行并保存报告。',
            )}>{qaBlocked ? '修复环境后重试 QA' : '运行 LibreOffice 自动 QA'}</button>
          </StageCard>}
          {status === 'completed' && <StageCard title="交付完成">
            <p>可编辑 PPTX：{pipeline.exportReceipt?.relativePath}</p>
            <p>QA 报告：{pipeline.qaReport?.textReportPath}</p>
            <p>逐页比较、字体、越界、裁切、空白页和缺失资源检查均已通过。</p>
          </StageCard>}
        </section>
        <aside className="review-inspector">
          <h2>真实检查点</h2>
          <p>状态：{status}</p><p>任务记录：{pipeline.tasks.length}</p>
          <p>审批记录：{pipeline.approvals.length}</p>
          <p>逐页细化审核：{pipeline.slideSpecs
            ? '已就绪'
            : '未就绪（detail_review 仅表示已进入该阶段，不代表细化内容已生成）'}</p>
          <p>产物哈希：{pipeline.exportReceipt?.sha256 ?? '尚无'}</p>
          <button className="button button-secondary" disabled={busy || pipeline.approvals.length === 0}
            onClick={() => void proposeMemory()}>{memoryActionLabel(generation)}</button>
        </aside>
      </div>
    </main>
  );
}

function StageCard({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return <article className="project-create">
    <header className="native-stage-header"><h2>{title}</h2>{actions}</header>
    {children}
  </article>;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function normalizePromptContext(
  pipeline: NativePptPipeline,
  context: NativePromptContext,
): NativePromptContext {
  const sourceInstructions: Record<string, string> = {};
  for (const source of pipeline.sources) {
    const instructions = context.sourceInstructions[source.id];
    if (instructions) sourceInstructions[source.id] = instructions;
  }
  return {
    taskBrief: context.taskBrief,
    sourceInstructions,
    outlineRequirements: context.outlineRequirements,
  };
}

function promptInvalidationMessage(
  pipeline: NativePptPipeline,
  saved: NativePromptContext,
  next: NativePromptContext,
): string {
  const analysisInputsChanged = saved.taskBrief !== next.taskBrief ||
    JSON.stringify(saved.sourceInstructions) !== JSON.stringify(next.sourceInstructions);
  const outlineRequirementsChanged = saved.outlineRequirements !== next.outlineRequirements;
  const hasDraftOutline = pipeline.outline?.version.status === 'draft';
  if (analysisInputsChanged && (pipeline.analysis || hasDraftOutline)) {
    if (pipeline.analysis && hasDraftOutline) {
      return '保存后将清除已有材料分析；当前未批准大纲将被清除，需重新生成；工作流返回材料阶段。此操作不会自动开始 AI 生成。';
    }
    if (pipeline.analysis) return '保存后将清除已有材料分析，并返回材料阶段。此操作不会自动开始 AI 生成。';
    return '保存后当前未批准大纲将被清除，需重新生成；工作流返回材料阶段。此操作不会自动开始 AI 生成。';
  }
  if (!analysisInputsChanged && outlineRequirementsChanged && hasDraftOutline) {
    return '保存后将保留材料分析；当前未批准大纲将被清除，需重新生成；工作流返回材料分析阶段。此操作不会自动开始 AI 生成。';
  }
  return '';
}

function promptStageFor(status: string): PptPromptStage {
  if (status === 'intake') return 'analysis';
  if (status === 'source_analysis' || status === 'outline_review') return 'outline';
  return 'details';
}

function promptPreviewLabel(stage: PptPromptStage): string {
  return ({ analysis: '查看材料分析提示词', outline: '查看大纲生成提示词', details: '查看逐页细化提示词' })[stage];
}

function stageLabel(stage: string): string {
  return ({ intake: '材料', source_analysis: '材料分析', outline_review: '大纲审批',
    detail_review: '逐页细化', visual_review: '视觉审批', blocked: '可恢复阻塞',
    conversion: '可编辑转换', qa: '质量检查', completed: '已完成' } as Record<string, string>)[stage] ?? stage;
}

function generationRunningLabel(generation: ProjectGeneration | null): string {
  if (generation?.status !== 'running') return '';
  return ({ analysis: '正在分析材料', outline: '正在生成整份大纲', details: '正在生成逐页细化',
    visual: '正在生成当前页视觉候选', memory: '正在提议可复用偏好' } as Record<string, string>)[generation.kind] ?? '正在生成';
}

function generationSuccessLabel(kind: ProjectGeneration['kind']): string {
  return ({ analysis: '材料分析已保存。', outline: '整份大纲已生成，等待你审核。',
    details: '全部页面细化已生成。', visual: '视觉候选已生成并保存，请检查完整 PNG。',
    memory: '偏好建议已提交。' } as Record<string, string>)[kind] ?? '生成结果已保存。';
}

function generationActionLabel(
  kind: ProjectGeneration['kind'],
  generation: ProjectGeneration | null,
  idle: string,
): string {
  if (generation?.kind !== kind) return idle;
  if (generation.status === 'running') return ({ analysis: '正在分析材料…', outline: '正在生成整份大纲…',
    details: '正在生成逐页细化…', visual: '正在生成当前页…', memory: '正在提议可复用偏好…' })[kind];
  if (generation.status === 'failed') return ({ analysis: '重试分析材料', outline: '重试生成整份大纲',
    details: '重试生成逐页细化', visual: '重试生成当前页', memory: '重试提议可复用偏好' })[kind];
  return idle;
}

function visualActionLabel(generation: ProjectGeneration | null, replacing: boolean): string {
  if (generation?.kind !== 'visual') return replacing ? '按意见重新生成' : '生成当前页';
  if (generation.status === 'running') return '正在生成当前页…';
  if (generation.status === 'failed') return replacing ? '重试按意见重新生成' : '重试生成当前页';
  return replacing ? '按意见重新生成' : '生成当前页';
}

function generationProgress(generation: ProjectGeneration): string {
  return generation.progress?.trim() ?? '';
}

function generationElapsed(startedAt: string, now: number): string {
  const started = Date.parse(startedAt);
  const elapsedSeconds = Number.isFinite(started) ? Math.max(0, Math.floor((now - started) / 1_000)) : 0;
  if (elapsedSeconds < 60) return `${elapsedSeconds} 秒`;
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  return seconds ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分`;
}

function memoryActionLabel(generation: ProjectGeneration | null): string {
  return generationActionLabel('memory', generation, '请 AI 提议可复用偏好');
}

function memoryGenerationStatus(generation: ProjectGeneration): string {
  return generation.kind === 'memory' ? generation.result?.status ?? '' : '';
}

function generationMatchesPipeline(
  generation: ProjectGeneration | null,
  pipeline: NativePptPipeline | null,
): boolean {
  if (!generation || !pipeline) return Boolean(generation);
  if (generation.kind === 'memory') return true;
  const expected = pipeline.project.workflowStatus === 'intake' ? 'analysis'
    : pipeline.project.workflowStatus === 'source_analysis' ? 'outline'
      : pipeline.project.workflowStatus === 'detail_review' && !pipeline.slideSpecs ? 'details'
        : pipeline.project.workflowStatus === 'visual_review' ||
          (pipeline.project.workflowStatus === 'blocked' && pipeline.blockedCondition?.resumeStage === 'visual_review')
          ? 'visual'
          : null;
  return generation.kind === expected;
}
