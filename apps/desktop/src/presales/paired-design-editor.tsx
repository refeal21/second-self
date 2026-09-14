import type { PagePlan, PresalesModule, SceneStep, SlideDesignPlan } from '../../../worker/src/presales/contracts.js';
import type { SlideSpec } from '../../../worker/src/ppt-project.js';
import { visibleTextLeaves } from '../../../worker/src/presales/validation.js';

const references = { triggerRef: '触发', actionRef: '动作', responseRef: '响应', outcomeRef: '结果' } as const;

export function PairedDesignEditor({ spec, design, pagePlan, modules, readOnly, onChange }: {
  spec: SlideSpec; design: SlideDesignPlan; pagePlan: PagePlan; modules: PresalesModule[];
  readOnly: boolean; onChange: (design: SlideDesignPlan) => void;
}) {
  const leaves = visibleTextLeaves(spec);
  const availableModules = modules.filter(module => pagePlan.moduleIds.includes(module.id));
  const missing = [...leaves].filter(([path]) => !design.textBindings.some(binding => binding.path === path));
  const scene = design.scene;
  const textFor = (bindingId: string) => {
    const binding = design.textBindings.find(item => item.id === bindingId);
    return binding ? leaves.get(binding.path) ?? '绑定路径已失效，请重新选择' : '绑定不存在，请重新选择';
  };
  const updateStep = (id: string, patch: Partial<SceneStep>) => {
    if (scene) onChange({ ...design, scene: { ...scene, steps: scene.steps.map(step => step.id === id ? { ...step, ...patch } : step) } });
  };
  return <fieldset disabled={readOnly} className="presales-design-editor">
    <legend>设计、模块与场景</legend>
    <p>已批准页面计划：{pagePlan.pageType} · {pagePlan.keyMessage}</p>
    <ul>{availableModules.map(module => <li key={module.id}>{module.name}（{module.id}）· 分析依据 {module.findingIds.join('、')}</li>)}</ul>
    <label>布局<input value={design.layout} onChange={event => onChange({ ...design, layout: event.target.value })} /></label>
    <label>视觉重点<input value={design.visualFocus} onChange={event => onChange({ ...design, visualFocus: event.target.value })} /></label>
    <label>演讲备注（不显示在页面上）<textarea value={design.speakerNotes} onChange={event => onChange({ ...design, speakerNotes: event.target.value })} /></label>
    <h4>全部可见文字绑定</h4><p>绑定 ID 保持稳定。选择路径可修正对应文字；新增文字可以补齐绑定。演讲备注不参与绑定。</p>
    {design.textBindings.map((binding, index) => <div className="presales-workspace__row" key={binding.id}>
      <label>绑定 {binding.id} 的可见文字<select value={binding.path} onChange={event => onChange({ ...design, textBindings: design.textBindings.map((item, i) => i === index ? { ...item, path: event.target.value } : item) })}>
        {!leaves.has(binding.path) && <option value={binding.path}>{binding.path} · 路径失效</option>}
        {[...leaves].map(([path, text]) => <option key={path} value={path}>{path} · {text}</option>)}
      </select></label>
      <p>{textFor(binding.id)}</p>
      <button onClick={() => onChange({ ...design, textBindings: design.textBindings.filter((_, i) => i !== index) })}>删除绑定 {binding.id}</button>
    </div>)}
    {missing.length > 0 && <div><p>尚未绑定：{missing.map(([path, text]) => `${path} · ${text}`).join('；')}</p>
      <button onClick={() => onChange({ ...design, textBindings: [...design.textBindings, ...missing.map(([path]) => ({ id: `text-${crypto.randomUUID()}`, path }))] })}>补齐缺失的可见文字绑定</button></div>}
    <h4>场景步骤与交接</h4>
    {!scene && <p>此页没有场景。场景页保存时必须包含有效步骤与交接。</p>}
    {scene?.steps.map(step => <fieldset key={step.id}>
      <legend>步骤 {step.id}</legend>
      <label>步骤 {step.id} · 执行者<input value={step.actor} onChange={event => updateStep(step.id, { actor: event.target.value })} /></label>
      <label>步骤 {step.id} · 地点<input value={step.location} onChange={event => updateStep(step.id, { location: event.target.value })} /></label>
      <label>步骤 {step.id} · 关联模块<select value={step.moduleId} onChange={event => updateStep(step.id, { moduleId: event.target.value })}>
        {!availableModules.some(module => module.id === step.moduleId) && <option value={step.moduleId}>{step.moduleId} · 不在已批准页面计划中</option>}
        {availableModules.map(module => <option key={module.id} value={module.id}>{module.name} · {module.id}</option>)}
      </select></label>
      {Object.entries(references).map(([key, label]) => {
        const field = key as keyof typeof references;
        return <label key={field}>步骤 {step.id} · {label}<select aria-label={`步骤 ${step.id} · ${label}`} value={step[field]} onChange={event => updateStep(step.id, { [field]: event.target.value })}>
          {!design.textBindings.some(binding => binding.id === step[field]) && <option value={step[field]}>{step[field]} · 绑定不存在</option>}
          {design.textBindings.map(binding => <option key={binding.id} value={binding.id}>{binding.id} · {textFor(binding.id)}</option>)}
        </select><span>{label}：{textFor(step[field])}</span></label>;
      })}
      <button onClick={() => onChange({ ...design, scene: { ...scene, steps: scene.steps.filter(item => item.id !== step.id) } })}>删除步骤 {step.id}</button>
    </fieldset>)}
    <button onClick={() => {
      const first = design.textBindings[0]?.id ?? '';
      const step: SceneStep = { id: `step-${crypto.randomUUID()}`, actor: '', location: '', moduleId: availableModules[0]?.id ?? '', triggerRef: first, actionRef: first, responseRef: first, outcomeRef: first };
      onChange({ ...design, scene: { steps: [...scene?.steps ?? [], step], edges: scene?.edges ?? [] } });
    }}>添加场景步骤</button>
    {scene?.edges.map((edge, index) => <fieldset key={index}>
      <legend>连线 {index + 1}</legend>
      {(['from', 'to'] as const).map(endpoint => <label key={endpoint}>连线 {index + 1} · {endpoint === 'from' ? '起点' : '终点'}<select value={edge[endpoint]} onChange={event => onChange({ ...design, scene: { ...scene, edges: scene.edges.map((item, i) => i === index ? { ...item, [endpoint]: event.target.value } : item) } })}>
        {!scene.steps.some(step => step.id === edge[endpoint]) && <option value={edge[endpoint]}>{edge[endpoint]} · 步骤不存在</option>}
        {scene.steps.map(step => <option key={step.id} value={step.id}>{step.id} · {step.actor} · {step.location}</option>)}
      </select></label>)}
      <p>{edge.from} → {edge.to}</p>
      <button onClick={() => onChange({ ...design, scene: { ...scene, edges: scene.edges.filter((_, i) => i !== index) } })}>删除连线 {index + 1}</button>
    </fieldset>)}
    {scene && <button disabled={scene.steps.length < 2} onClick={() => onChange({ ...design, scene: { ...scene, edges: [...scene.edges, { from: scene.steps[0]!.id, to: scene.steps[1]!.id }] } })}>添加场景连线</button>}
  </fieldset>;
}
