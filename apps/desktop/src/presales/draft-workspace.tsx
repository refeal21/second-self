import { useEffect, useMemo, useRef, useState } from 'react';
import { OutlineEditor } from '../outline-editor.js';
import { DetailEditor } from '../detail-editor.js';
import { PairedDesignEditor } from './paired-design-editor.js';
import { detailDocumentError } from '../detail-document.js';
import { parseVisualStyleProfile, type VisualStyleProfile } from '../../../worker/src/visual-style.js';
import { parseOutlineEnvelope, parseDetailsEnvelope } from '../../../worker/src/presales/validation.js';
import type { OutlineEnvelope, DetailsEnvelope, PagePlan, PresalesModule, SlideDesignPlan } from '../../../worker/src/presales/contracts.js';
import type { PptOutline, SlideSpec, SourceAnalysis } from '../../../worker/src/ppt-project.js';
import type { PresalesAdapter, V3ImportedDraft, V3PromptContext, V3QueueSnapshot, V3Stage, V3TextOperation } from './adapter.js';

const emptyOutline = (): OutlineEnvelope => ({ schemaVersion: 1, outline: { title: '', slides: [{ id: 'slide-1', title: '', purpose: '' }] }, plan: { schemaVersion: 1, modules: [], pages: [{ slideId: 'slide-1', pageType: 'cover', keyMessage: '', moduleIds: [] }] } });
const emptyProfile = (): VisualStyleProfile => ({ primaryColor: '#24355b', backgroundColor: '#ffffff', textColor: '#202838', accentColors: [], instructions: '', template: null });
function makeDesign(spec: SlideSpec): SlideDesignPlan {
  return { slideId: spec.id, layout: '请描述页面布局', visualFocus: '请描述视觉重点', speakerNotes: '',
    textBindings: [{ id: 'title', path: '/title' }, ...spec.body.map((_, index) => ({ id: `body-${index}`, path: `/body/${index}` }))], scene: null };
}
function initialDetails(outline: OutlineEnvelope): DetailsEnvelope {
  const specs: SlideSpec[] = outline.outline.slides.map(slide => ({ id: slide.id, title: slide.title, body: [''], tables: [], charts: [], shapes: [], sourceMap: [], imageGenerationBrief: '' }));
  return { schemaVersion: 1, specs, designs: specs.map(makeDesign) };
}
function analysisOf(draft: V3ImportedDraft): SourceAnalysis | null {
  const value = draft.analysis as { output?: SourceAnalysis } | null;
  return value?.output && Array.isArray(value.output.findings) && Array.isArray(value.output.dataPoints) && Array.isArray(value.output.sourceMap) ? value.output : null;
}
function sourcesOf(draft: V3ImportedDraft) { return draft.sources.flatMap(source => {
  const item = source as { id?: string; fileName?: string };
  return item.id && item.fileName ? [{ id: item.id, fileName: item.fileName }] : [];
}); }
function alignPlan(outline: PptOutline, previous: OutlineEnvelope['plan']): OutlineEnvelope['plan'] {
  return { ...previous, pages: outline.slides.map(slide => previous.pages.find(page => page.slideId === slide.id) ?? { slideId: slide.id, pageType: 'module', keyMessage: slide.purpose, moduleIds: [] }) };
}
function explain(error: unknown) { return error instanceof Error ? error.message : typeof error === 'string' ? error : '操作未完成'; }
const activeStatuses = new Set(['queued', 'dispatching', 'running', 'result_ready', 'committing', 'cancel_requested', 'outcome_unknown']);
type AuthorInput = Parameters<PresalesAdapter['author']>[0];
const uncertainTextRequests = new Map<string, AuthorInput>();

export function DraftWorkspace({ adapter, project, queue, refresh, onDirtyChange }: { adapter: PresalesAdapter; project: V3ImportedDraft; queue: V3QueueSnapshot; refresh: () => Promise<void>; onDirtyChange: (dirty: boolean) => void }) {
  const saved = project.authored?.checkpoint;
  const approvedOutline = Boolean(saved?.approvalBindings.some(binding => binding.stage === 'outline'));
  const approvedDetails = Boolean(saved?.approvalBindings.some(binding => binding.stage === 'details'));
  const [outline, setOutline] = useState<OutlineEnvelope>(() => saved?.draft.outline ?? emptyOutline());
  const [details, setDetails] = useState<DetailsEnvelope>(() => saved?.draft.details ?? initialDetails(saved?.draft.outline ?? emptyOutline()));
  const settings = project.authored?.settings;
  const [brief, setBrief] = useState(settings?.brief ?? project.brief);
  const [context, setContext] = useState<V3PromptContext>(settings?.context ?? { taskBrief: '', sourceInstructions: {}, outlineRequirements: '' });
  const [manualPalette, setManualPalette] = useState(false);
  const [profile, setProfile] = useState<VisualStyleProfile>(settings?.palette.profile ?? emptyProfile());
  const [operations, setOperations] = useState<V3TextOperation[]>([]);
  const [uncertainRequest, setUncertainRequest] = useState<AuthorInput | null>(() => uncertainTextRequests.get(project.summary.projectId) ?? null);
  const [selectedOperationId, setSelectedOperationId] = useState<string | null>(null);
  const [designReviewed, setDesignReviewed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [dirtySections, setDirtySections] = useState<Record<string, boolean>>({});
  const priorRevision = useRef(project.summary.revision);
  const analysis = analysisOf(project);
  const sources = useMemo(() => sourcesOf(project), [project.sources]);
  const dirty = Object.values(dirtySections).some(Boolean);
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => { let active = true; void adapter.textHistory(project.summary.projectId).then(items => { if (!active) return; setOperations(items); const pendingInput = uncertainTextRequests.get(project.summary.projectId); if (pendingInput && items.some(item => item.operationId === pendingInput.operationId && item.attemptId === pendingInput.attemptId)) { uncertainTextRequests.delete(project.summary.projectId); setUncertainRequest(null); } }, caught => { if (active) setError(explain(caught)); }); return () => { active = false; }; }, [adapter, project.summary.projectId, project.summary.revision, queue.jobs]);
  useEffect(() => {
    if (priorRevision.current !== project.summary.revision && dirty) setError('项目已被其他操作更新；本地未保存输入保留。请核对最新版本后明确保存，系统不会覆盖或自动重发。');
    priorRevision.current = project.summary.revision;
    if (!dirtySections.outline && saved?.draft.outline) setOutline(saved.draft.outline);
    if (!dirtySections.details && saved?.draft.outline) setDetails(saved.draft.details ?? initialDetails(saved.draft.outline));
    if (!dirtySections.settings && settings) { setBrief(settings.brief); setContext(settings.context); setProfile(settings.palette.profile ?? emptyProfile()); }
  }, [project.summary.revision]);
  async function perform(label: string, run: () => Promise<unknown>, clears?: string) {
    if (pending) return;
    setPending(label); setError(null); setNotice(null);
    try { await run(); if (clears) setDirtySections(previous => ({ ...previous, [clears]: false })); await refresh(); setNotice(`${label}已保存；模型结果未自动批准，仍须人工审核。`); }
    catch (caught) { setError(`${explain(caught)}。输入保留；请核对最新权威版本后再明确重试。`); try { await refresh(); } catch { /* keep original error */ } }
    finally { setPending(null); }
  }
  const operation = operations.find(item => item.operationId === selectedOperationId) ?? operations.at(-1) ?? null;
  const unfinished = Boolean(uncertainRequest) || operations.some(item => activeStatuses.has(item.status));
  async function submitAuthor(input: AuthorInput, label: string) {
    await perform(label, async () => {
      const result = await adapter.author(input);
      if (result.operationId !== input.operationId || result.attemptId !== input.attemptId) throw new Error('文本任务回执身份不匹配');
      uncertainTextRequests.delete(project.summary.projectId); setUncertainRequest(null);
      setOperations(previous => [...previous.filter(item => item.operationId !== result.operationId), result]); setSelectedOperationId(result.operationId);
    });
  }
  async function author(stage: V3Stage) {
    if (unfinished) { setError('该项目已有未结束的文本任务，请先核对状态。'); return; }
    if (!analysis) { setError('副本缺少可验证的分析，未向本机提交文本任务；请核对副本资料后重试。'); return; }
    const input = { projectId: project.summary.projectId, expectedRevision: project.summary.revision, operationId: crypto.randomUUID(), attemptId: crypto.randomUUID(), stage };
    uncertainTextRequests.set(project.summary.projectId, input); setUncertainRequest(input);
    await submitAuthor(input, stage === 'outline' ? '大纲与计划请求' : '细化与设计请求');
  }
  async function reconcileUncertain() {
    const input = uncertainRequest;
    if (!input || pending) return;
    setPending('核对并恢复'); setError(null); setNotice(null);
    try {
      // Native text admission checks the captured draft revision in its writer transaction.
      // These reads must remain ordered: a newer draft revision first, then full history.
      const current = await adapter.load(input.projectId);
      if (current.kind !== 'draft' || current.project.summary.projectId !== input.projectId) throw new Error('当前副本类型或身份已变化，仍需人工核对');
      if (current.project.summary.revision <= input.expectedRevision) {
        setNotice('副本修订尚未超过原请求修订；旧请求仍可能入队，继续保留占位。');
        return;
      }
      const items = await adapter.textHistory(input.projectId);
      const matching = items.find(item => item.operationId === input.operationId && item.attemptId === input.attemptId);
      if (!matching && items.some(item => item.operationId === input.operationId)) throw new Error('原任务 ID 存在但尝试身份不匹配，继续保留占位');
      await refresh();
      setOperations(items);
      if (matching) setSelectedOperationId(matching.operationId);
      uncertainTextRequests.delete(input.projectId); setUncertainRequest(null);
      setNotice(matching ? '已在本机历史中找到原任务；未创建新请求。' : '新修订与随后读取的完整历史确认旧请求未入队；可在新修订上明确创建请求。');
    } catch (caught) { setError(`${explain(caught)}。原请求占位仍保留，可用同一请求标识重试确认。`); }
    finally { setPending(null); }
  }
  async function savePair(stage: V3Stage) {
    if (!analysis) { setError('副本没有可验证的分析，无法保存配对内容。'); return; }
    try {
      const envelope = stage === 'outline' ? parseOutlineEnvelope(outline, analysis) : parseDetailsEnvelope(details, parseOutlineEnvelope(saved?.draft.outline, analysis), analysis);
      if (stage === 'details' && !designReviewed) { setError('可见文字已变更，请逐页核对设计与文字绑定并勾选已重新审核。'); return; }
      await perform(stage === 'outline' ? '大纲与计划' : '细化与设计', () => adapter.savePair({ projectId: project.summary.projectId, expectedRevision: project.summary.revision, stage, envelope }), stage);
    } catch (caught) { setError(explain(caught)); }
  }
  function updateModule(index: number, update: (module: PresalesModule) => PresalesModule) {
    setOutline(previous => ({ ...previous, plan: { ...previous.plan, modules: previous.plan.modules.map((item, i) => i === index ? update(item) : item) } }));
    setDirtySections(previous => ({ ...previous, outline: true }));
  }
  return <main id="main-content" className="presales-workspace presales-draft">
    <header className="presales-workspace__intro"><div><p>售前 v3 · 内容修订副本</p><h1>{project.summary.name}</h1><small>来源 {project.origin.sourceProjectId} 修订 {project.origin.sourceRevision} · 对照图只读，新的页面将单独生成</small></div><button onClick={() => void refresh()}>重新读取副本</button></header>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    <section className="presales-workspace__panel"><h2>目标项目说明与配色</h2><p>这些是此副本的生成上下文；第一次大纲联合批准后锁定。原项目与全局偏好不变。</p>
      <label>项目简介<textarea aria-label="项目简介" disabled={approvedOutline} value={brief} onChange={event => { setBrief(event.target.value); setDirtySections(previous => ({ ...previous, settings: true })); }} /></label>
      <label>任务说明<textarea aria-label="任务说明" disabled={approvedOutline} value={context.taskBrief} onChange={event => { setContext({ ...context, taskBrief: event.target.value }); setDirtySections(previous => ({ ...previous, settings: true })); }} /></label>
      <label>大纲要求<textarea aria-label="大纲要求" disabled={approvedOutline} value={context.outlineRequirements} onChange={event => { setContext({ ...context, outlineRequirements: event.target.value }); setDirtySections(previous => ({ ...previous, settings: true })); }} /></label>
      {sources.map(source => <label key={source.id}>{source.fileName} 的用途说明<textarea disabled={approvedOutline} value={context.sourceInstructions[source.id] ?? ''} onChange={event => { setContext({ ...context, sourceInstructions: { ...context.sourceInstructions, [source.id]: event.target.value } }); setDirtySections(previous => ({ ...previous, settings: true })); }} /></label>)}
      {settings?.palette.profile ? <p>已保存配色 · {settings.paletteOrigin === 'imported' ? '从已验证模板复制' : '手工指定'}：{settings.palette.profile.primaryColor} / {settings.palette.profile.backgroundColor}</p> : <p>尚无已验证配色。不能声称已从模板提取；请明确选择手工配色后保存。</p>}
      {!settings?.palette.profile && !approvedOutline && <label><input type="checkbox" checked={manualPalette} onChange={event => setManualPalette(event.target.checked)} />手工指定配色（不代表模板提取）</label>}
      {manualPalette && !approvedOutline && <div className="presales-workspace__palette">{(['primaryColor', 'backgroundColor', 'textColor'] as const).map(key => <label key={key}>{({ primaryColor: '主色', backgroundColor: '背景色', textColor: '文字色' })[key]}<input aria-label={key} type="color" value={profile[key]} onChange={event => { setProfile({ ...profile, [key]: event.target.value }); setDirtySections(previous => ({ ...previous, settings: true })); }} /></label>)}<label>辅助色（逗号分隔）<input value={profile.accentColors.join(',')} onChange={event => { setProfile({ ...profile, accentColors: event.target.value.split(',').map(item => item.trim()).filter(Boolean) }); setDirtySections(previous => ({ ...previous, settings: true })); }} /></label><label>配色说明<textarea value={profile.instructions} onChange={event => { setProfile({ ...profile, instructions: event.target.value }); setDirtySections(previous => ({ ...previous, settings: true })); }} /></label></div>}
      <button disabled={approvedOutline || Boolean(pending)} onClick={() => void perform('目标项目说明与配色', () => adapter.draftSettings({ projectId: project.summary.projectId, expectedRevision: project.summary.revision, brief, context, manualPalette: manualPalette ? parseVisualStyleProfile(profile) : null }), 'settings')}>保存副本上下文</button>
      {approvedOutline && <p>大纲已联合批准，此处不可再修改。</p>}
    </section>
    <section className="presales-workspace__panel"><h2>模型配对生成与历史</h2><p>生成操作和完整请求由本机持久化；完成后填入未批准的配对草稿，绝不自动批准。</p>
      <div className="presales-workspace__actions"><button disabled={Boolean(pending || unfinished || approvedOutline || !queue.dispatchAvailable || dirty)} onClick={() => void author('outline')}>生成大纲与售前计划</button><button disabled={Boolean(pending || unfinished || !approvedOutline || approvedDetails || !queue.dispatchAvailable || dirty)} onClick={() => void author('details')}>生成细化与设计</button></div>
      {!queue.dispatchAvailable && <p>文本模型运行环境当前不可用；仍可手工编辑已保存草稿。</p>}
      {uncertainRequest && <div><p role="alert">文本提交结果待核对（{uncertainRequest.operationId}）；不会自动创建新请求。返回此页仍会保持占位，直到权威历史确认同一任务。</p><div className="presales-workspace__actions"><button disabled={Boolean(pending)} onClick={() => void submitAuthor(uncertainRequest, '原请求重试确认')}>用原请求标识重试确认</button><button disabled={Boolean(pending)} onClick={() => void reconcileUncertain()}>核对并恢复</button></div><p>原请求可用相同项目、修订、阶段、任务 ID 和尝试 ID 明确重试。恢复操作会先读取本机新修订，再读取完整任务历史；没有新修订或读取失败时不会解除占位。</p></div>}
      {operations.length > 0 && <label>生成历史<select value={operation?.operationId ?? ''} onChange={event => setSelectedOperationId(event.target.value)}>{operations.map(item => <option key={item.operationId} value={item.operationId}>{item.target.stage} · {item.status} · {item.operationId}</option>)}</select></label>}
      {operation && <div><p>状态：{operation.status}{operation.error ? ` · ${operation.error}` : ''}{operation.commit ? ' · 已保存配对结果，未自动批准' : ''}</p><details><summary>查看实际保存的请求与上下文</summary><p>提示词版本：{operation.target.promptVersion}</p><h4>提交时的项目简介</h4><p>{operation.target.brief}</p><h4>提交时的任务上下文</h4><p>{operation.target.context.taskBrief}</p><p>大纲要求：{operation.target.context.outlineRequirements}</p>{Object.entries(operation.target.context.sourceInstructions).map(([id, instruction]) => <p key={id}>材料 {id}：<span>{instruction}</span></p>)}<p>提交时的配色：{operation.target.palette.profile ? `${operation.target.palette.profile.primaryColor} / ${operation.target.palette.profile.backgroundColor}` : '未提供已验证配色'}</p><h4>实际保存的完整请求</h4><pre>{operation.target.prompt}</pre></details>{operation.status === 'conflict' && <p>模型结果与新手工修改冲突；结果证据保留，当前输入不会被覆盖。</p>}{['outcome_unknown', 'cancel_requested'].includes(operation.status) && <button onClick={() => { if (window.confirm('远端可能仍会完成并计费。确认承担重复执行风险并放弃占位？')) void perform('放弃文本任务', () => adapter.abandon('text', operation.operationId)); }}>确认风险并放弃占位</button>}{['queued', 'running'].includes(operation.status) && <button onClick={() => void perform('取消文本任务', () => adapter.cancel('text', operation.operationId))}>取消任务</button>}</div>}
    </section>
    <section className="presales-workspace__panel"><h2>大纲与售前计划 · 联合审核</h2><p>大纲与计划同一次保存、同一次批准；页面 ID 和顺序必须严格一致。</p>
      <OutlineEditor outline={outline.outline} analysis={analysis} sources={sources} readOnly={approvedOutline} disabled={Boolean(pending)} onChange={next => { setOutline(previous => ({ ...previous, outline: next, plan: alignPlan(next, previous.plan) })); setDirtySections(previous => ({ ...previous, outline: true })); }} />
      <h3>模块与逐页计划</h3>{outline.plan.modules.map((module, index) => <div className="presales-workspace__row" key={module.id}><label>模块 ID<input disabled={approvedOutline} value={module.id} onChange={event => updateModule(index, item => ({ ...item, id: event.target.value }))} /></label><label>模块名称<input disabled={approvedOutline} value={module.name} onChange={event => updateModule(index, item => ({ ...item, name: event.target.value }))} /></label><fieldset><legend>引用的分析发现</legend>{analysis?.findings.map(finding => <label key={finding.id}><input type="checkbox" disabled={approvedOutline} checked={module.findingIds.includes(finding.id)} onChange={event => updateModule(index, item => ({ ...item, findingIds: event.target.checked ? [...item.findingIds, finding.id] : item.findingIds.filter(id => id !== finding.id) }))} />{finding.id}</label>)}</fieldset><button disabled={approvedOutline} onClick={() => { setOutline(previous => ({ ...previous, plan: { ...previous.plan, modules: previous.plan.modules.filter((_, i) => i !== index) } })); setDirtySections(previous => ({ ...previous, outline: true })); }}>删除模块</button></div>)}
      <button disabled={approvedOutline} onClick={() => { setOutline(previous => ({ ...previous, plan: { ...previous.plan, modules: [...previous.plan.modules, { id: `module-${crypto.randomUUID()}`, name: '', findingIds: [] } as PresalesModule] } })); setDirtySections(previous => ({ ...previous, outline: true })); }}>添加模块</button>
      {outline.plan.pages.map((page, index) => <div className="presales-workspace__row" key={page.slideId}><strong>第 {index + 1} 页 {page.slideId}</strong><label>页面类型<select disabled={approvedOutline} value={page.pageType} onChange={event => { setOutline(previous => ({ ...previous, plan: { ...previous.plan, pages: previous.plan.pages.map((item, i) => i === index ? { ...item, pageType: event.target.value as PagePlan['pageType'] } : item) } })); setDirtySections(previous => ({ ...previous, outline: true })); }}>{(['cover', 'goals', 'architecture', 'overview', 'module', 'scenario', 'closing'] as const).map(item => <option key={item} value={item}>{item}</option>)}</select></label><label>关键论点<input disabled={approvedOutline} value={page.keyMessage} onChange={event => { setOutline(previous => ({ ...previous, plan: { ...previous.plan, pages: previous.plan.pages.map((item, i) => i === index ? { ...item, keyMessage: event.target.value } : item) } })); setDirtySections(previous => ({ ...previous, outline: true })); }} /></label><fieldset><legend>关联模块</legend>{outline.plan.modules.map(module => <label key={module.id}><input type="checkbox" disabled={approvedOutline} checked={page.moduleIds.includes(module.id)} onChange={event => { setOutline(previous => ({ ...previous, plan: { ...previous.plan, pages: previous.plan.pages.map((item, i) => i === index ? { ...item, moduleIds: event.target.checked ? [...item.moduleIds, module.id] : item.moduleIds.filter(id => id !== module.id) } : item) } })); setDirtySections(previous => ({ ...previous, outline: true })); }} />{module.name || module.id}</label>)}</fieldset></div>)}
      <div className="presales-workspace__actions"><button disabled={approvedOutline || Boolean(pending)} onClick={() => void savePair('outline')}>保存大纲与计划</button><button disabled={approvedOutline || !saved?.draft.outline || Boolean(pending || dirtySections.outline) || !settings?.palette.profile} onClick={() => void perform('大纲与计划联合批准', () => adapter.approvePair(project.summary.projectId, project.summary.revision, 'outline'))}>联合批准大纲与计划</button></div>
      {!settings?.palette.profile && <p>批准前必须先保存明确配色；不能使用未知模板配色。</p>}
    </section>
    {approvedOutline && <section className="presales-workspace__panel"><h2>逐页细化与设计 · 联合审核</h2><p>已批准的大纲保持冻结。可见文字变化后必须重新核对绑定和设计；演讲备注永远不是页面文字。</p>
      <DetailEditor value={{ outline: saved!.draft.outline.outline, specs: details.specs }} analysis={analysis} sources={sources} readOnly={approvedDetails} disabled={Boolean(pending)} onChange={next => { if (JSON.stringify(next.outline) !== JSON.stringify(saved!.draft.outline.outline)) { setError('已批准大纲不可修改；请保持页面 ID、顺序和标题。'); return; } setDetails(previous => ({ ...previous, specs: [...next.specs] })); setDesignReviewed(false); setDirtySections(previous => ({ ...previous, details: true })); }} />
      {details.designs.map((design, index) => {
        const spec = details.specs.find(item => item.id === design.slideId);
        const pagePlan = saved!.draft.outline.plan.pages.find(item => item.slideId === design.slideId);
        if (!spec || !pagePlan) return <p role="alert" key={design.slideId}>页面 {design.slideId} 的内容或批准计划缺失，不能联合批准。</p>;
        return <section className="presales-workspace__row" key={design.slideId}>
          <h3>第 {index + 1} 页设计 · {design.slideId}</h3>
          <PairedDesignEditor spec={spec} design={design} pagePlan={pagePlan} modules={saved!.draft.outline.plan.modules} readOnly={approvedDetails || Boolean(pending)} onChange={next => {
            setDetails(previous => ({ ...previous, designs: previous.designs.map(item => item.slideId === design.slideId ? next : item) }));
            setDesignReviewed(false);
            setDirtySections(previous => ({ ...previous, details: true }));
          }} />
        </section>;
      })}
      <label><input type="checkbox" disabled={approvedDetails} checked={designReviewed} onChange={event => setDesignReviewed(event.target.checked)} />已逐页重新核对设计与可见文字绑定</label>
      <div className="presales-workspace__actions"><button disabled={approvedDetails || Boolean(pending)} onClick={() => { const validation = detailDocumentError({ outline: saved!.draft.outline.outline, specs: details.specs }); if (validation) setError(validation); else void savePair('details'); }}>保存细化与设计</button><button disabled={approvedDetails || !saved?.draft.details || Boolean(pending || dirtySections.details)} onClick={() => void perform('细化与设计联合批准', () => adapter.approvePair(project.summary.projectId, project.summary.revision, 'details'))}>联合批准细化与设计</button></div>
    </section>}
    {approvedDetails && <section className="presales-workspace__panel"><h2>发布为独立冻结项目</h2><p>仅新配对页面进入生成流程；原图仍是只读对照证据。</p><button disabled={Boolean(pending || dirty)} onClick={() => { if (window.confirm('确认将已联合批准的配对内容发布为新的冻结页面？原项目保持不变。')) void perform('发布售前副本', () => adapter.promote(project.summary.projectId, project.summary.revision)); }}>发布新页面</button></section>}
    {project.comparisonPages.length > 0 && <section className="presales-workspace__panel"><h2>原项目视觉对照（只读）</h2>{project.comparisonPages.map(page => <p key={page.slideId}>第 {page.ordinal + 1} 页 {page.slideId} · {page.versions.length} 个历史版本</p>)}</section>}
  </main>;
}
