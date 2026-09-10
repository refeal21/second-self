import type { SlideSpec } from '../ppt-project.js';
import type { OutlineEnvelope, SlideDesignPlan } from './contracts.js';
import { PRESALES_SKILL } from './skill.generated.js';
import { resolveVisibleBindings } from './validation.js';

/** Supplied by the future trusted native snapshot loader; this is not approval authority. */
export interface PresalesPromptOptions { outline?: OutlineEnvelope }

export const PRESALES_SKILL_METADATA = {
  id: PRESALES_SKILL.id,
  version: PRESALES_SKILL.version,
  sha256: PRESALES_SKILL.sha256,
} as const;

const outlineContract = [
  '只返回严格 JSON 对象 OutlineEnvelope（不是旧版裸大纲），结构：{schemaVersion:1,outline:{title:string,slides:[{id:string,title:string,purpose:string,sourceIds:string[],findingIds:string[],dataPointIds:string[]}]},plan:{schemaVersion:1,modules:[{id:string,name:string,findingIds:string[]}],pages:[{slideId:string,pageType:"cover"|"goals"|"architecture"|"overview"|"module"|"scenario"|"closing",keyMessage:string,moduleIds:string[]}]}}。',
  'plan.pages 与 outline.slides 的页数、ID、顺序必须一致。模块证据 findingIds 来自当前分析；架构或总览包含全部模块，每个模块都要被后续 module/scenario 页面覆盖。',
].join('\n');

const detailsContract = [
  '只返回严格 JSON 对象 DetailsEnvelope：{schemaVersion:1,specs:SlideSpec[],designs:SlideDesignPlan[]}。保持 approvedOutline 的页数、页序、id、标题和目的；designs 与 specs 按 slideId 一一对应。',
  'SlideSpec 结构：{id:string,title:string,body:string[],findingIds:string[],dataPointIds:string[],tables:[],charts:[],shapes:[],sourceMap:[],imageGenerationBrief:string}。body 必须为字符串数组。',
  'tables 每项仅包含 {id:string,headers:string[],rows:string[][]}；每行与 headers 等长，数值单元格也写为字符串。表名和需要上屏的备注只能写入 body 或其他可见文字字段。',
  'charts 每项仅包含 {id:string,type:"bar"|"line"|"pie",categories:string[],series:[{name:string,values:number[]}]}；每组 values 与 categories 等长，数字必须有限。',
  'shapes 仅用于已有确定坐标的基础形状：{id:string,type:"rect"|"ellipse"|"line",x:number,y:number,w:number,h:number,fill?:string,line?:string,text?:string}；非负英寸，16:9 画布 13.333×7.5。概念构图关系写入设计计划，不虚构基础形状坐标。',
  'sourceMap 每项仅包含 {sourceId:string,title:string,locator:string,url?:string}，使用当前分析来源；findingIds、dataPointIds 使用当前分析编号。',
  'SlideDesignPlan 结构：{slideId:string,layout:string,visualFocus:string,speakerNotes:string,textBindings:[{id:string,path:string}],scene:null|{steps:[{id:string,moduleId:string,actor:string,location:string,triggerRef:string,actionRef:string,responseRef:string,outcomeRef:string}],edges:[{from:string,to:string}]}}。场景功能 moduleId 必须属于 approvedPresalesPlan 中本页的 moduleIds，edge 连接本页不同的有效步骤。',
  '每个可见叶值恰好一个唯一 textBinding；path 仅允许 /title、/body/0、/tables/0/headers/0、/tables/0/rows/0/0、/charts/0/categories/0、/charts/0/series/0/name、/charts/0/series/0/values/0、/shapes/0/text 这些路径形式，以实际无前导零的非负索引替换 0。包括图表数字，不能绑定 speakerNotes、来源或 brief。',
  '所有 *Ref 使用本页 binding id，场景及构图按引用安排可见文字，不能再复制另一套文案。actor/location 仅为非上屏的示意角色和场所；需要显示的角色和地点文字必须先进入 SlideSpec 并绑定。',
  'imageGenerationBrief、layout、visualFocus 只描述完整成品页的表达方式与引用关系，不能承载额外标签、事实或数据。长讲稿只写 speakerNotes，不能转移或替换上屏正文；逐页审核后才可冻结。',
  '以上为结构说明，不是需添加的字段。不要返回模型生成的哈希、批准状态、额外声明或未定义字段。无需内容的集合填 []，无场景填 null。最多 100 页、100 模块，每页最多 100 个文字绑定/步骤、400 条边；单个描述字符串最多 20,000 字符，完整响应最多 2 MiB UTF-8。',
].join('\n');

export function buildPresalesStageInstructions(stage: 'outline' | 'details'): string {
  return [PRESALES_SKILL.stages[stage], stage === 'outline' ? outlineContract : detailsContract].join('\n\n');
}

/** Validates references defensively; callers must separately establish joint approval. */
export function buildPresalesVisualContext(spec: SlideSpec, design: SlideDesignPlan) {
  const bindings = resolveVisibleBindings(spec, design);
  return {
    presalesSkill: { ...PRESALES_SKILL_METADATA },
    approvedDesign: {
      slideId: design.slideId,
      layout: design.layout,
      visualFocus: design.visualFocus,
      // Keep text only in approvedSlideSpec; the resolver verifies these paths.
      textBindings: bindings.map(({ id, path }) => ({ id, path })),
      scene: structuredClone(design.scene),
    },
  };
}
