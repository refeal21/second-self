/** One private account-route adapter for text and image work. Native schedules. */
import { CodexAppServerClient, type JsonRpcMessage } from '../app-server.js';
import type { ProviderIdentity, RuntimeJob, RuntimeProvider, RuntimeResult } from './runtime.js';

export type ImageCapabilities={generation:boolean;referenceEditing:boolean;reason?:string};
export type NativeInputs={cwd:string;images:{assetId:string;sha256:string;path:string;role:string}[]};
type Callbacks=Parameters<RuntimeProvider['execute']>[1];
const unavailable=(reason:string):ImageCapabilities=>({generation:false,referenceEditing:false,reason});
const record=(v:unknown):Record<string,unknown>|undefined=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:undefined;
const identity=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=256&&[...v].every(c=>c.charCodeAt(0)>=32);

export class PrivateCodexProvider implements RuntimeProvider {
  available=false;
  capabilities:ImageCapabilities=unavailable('尚未验证 ChatGPT 账户执行配置');
  private revision=0;
  private model:string|null=null;
  private preparing:Promise<void>|null=null;
  private readonly active=new Map<string,{identity:ProviderIdentity;cancel:boolean;invalidate():void}>();
  constructor(private readonly client:CodexAppServerClient,
    private readonly resolve:(work:RuntimeJob)=>Promise<NativeInputs>,
    private readonly cwd:()=>Promise<string>,
    private readonly changed:()=>void=()=>{}) {
    client.onServerMessage(m=>{if(m.method==='account/updated')this.invalidate();});
    client.onExit(()=>this.invalidate());
  }
  private invalidate():void {
    ++this.revision;this.available=false;this.model=null;
    this.capabilities=unavailable('账户或连接已变化，等待重新验证');this.changed();
    for(const entry of this.active.values()){
      entry.invalidate();entry.cancel=true;
      if(entry.identity.turnId)void this.client.privateV3Request('turn/interrupt',{threadId:entry.identity.threadId,turnId:entry.identity.turnId}).catch(()=>{});
    }
  }
  async prepare():Promise<void>{
    if(this.preparing)return this.preparing;
    const task=this.prepareOnce();this.preparing=task;
    try{await task;}finally{if(this.preparing===task)this.preparing=null;}
  }
  private async prepareOnce():Promise<void>{
    const revision=this.revision;
    try{
      await this.client.connect();
      await this.validate(await this.cwd(),revision);
    }catch{
      if(revision===this.revision){this.available=false;this.model=null;this.capabilities=unavailable('当前配置未通过 ChatGPT 账户路由或模型检查');this.changed();}
    }
  }
  private assertLease(revision:number):void{if(revision!==this.revision)throw new Error('Private account capability lease was revoked');}
  private async validate(cwd:string,revision:number):Promise<void>{
    const req=this.client.privateV3Request.bind(this.client);
    const a=record(await req('account/read',{refreshToken:false}));this.assertLease(revision);
    if(record(a?.account)?.type!=='chatgpt'||a?.requiresOpenaiAuth!==true)throw Error('ChatGPT account required');
    const config=record(record(await req('config/read',{includeLayers:false,cwd}))?.config);this.assertLease(revision);
    if(!config||(config.model_provider!=='openai'&&config.model_provider!==null)||config.openai_base_url!=null||config.chatgpt_base_url!=null
      ||(config.forced_login_method!=null&&config.forced_login_method!=='chatgpt')
      ||record(config.model_providers)?.openai!=null)throw Error('Stock route required');
    const requirements=record(await req('configRequirements/read',{}));this.assertLease(revision);
    if(!requirements||!('requirements' in requirements)||(requirements.requirements!==null&&!record(requirements.requirements))
      ||record(requirements.requirements)?.chatgptBaseUrl!=null)throw Error('Stock managed route required');
    const models:Record<string,unknown>[]=[];let cursor:unknown=null;
    for(let page=0;page<8;page++){
      const result=record(await req('model/list',{limit:100,includeHidden:false,...(cursor?{cursor}: {})}));this.assertLease(revision);
      if(!Array.isArray(result?.data)||!(result?.nextCursor===null||typeof result?.nextCursor==='string'))throw Error('Model catalog malformed');
      for(const value of result.data){const model=record(value);if(model)models.push(model);}
      cursor=result.nextCursor;if(cursor===null)break;
    }
    const defaults=models.filter(m=>m.isDefault===true);
    if(cursor!==null||defaults.length!==1||!identity(defaults[0]?.model)||!Array.isArray(defaults[0]?.inputModalities)||!defaults[0].inputModalities.includes('text'))throw Error('Unambiguous text model required');
    const cap=record(await req('modelProvider/capabilities/read',{}));this.assertLease(revision);
    this.model=defaults[0].model;this.available=true;
    const generation=cap?.imageGeneration===true&&typeof cap.namespaceTools==='boolean'&&typeof cap.webSearch==='boolean';
    const referenceEditing=generation&&defaults[0].inputModalities.includes('image');
    this.capabilities={generation,referenceEditing,...(!generation?{reason:'当前提供方未提供可验证的图片工具'}:!referenceEditing?{reason:'当前模型未声明图片输入支持'}:{})};this.changed();
  }
  async execute(work:RuntimeJob,callbacks:Callbacks):Promise<RuntimeResult>{
    const revision=this.revision;
    const inputs=await this.resolve(work);this.assertLease(revision);
    try{await this.client.connect();await this.validate(inputs.cwd,revision);}
    catch{this.invalidate();throw Error('Private route validation failed');}
    if(!this.available||!this.model)throw Error('Private route unavailable');
    const images=inputs.images;
    if(work.kind==='image'){
      if(!this.capabilities.generation)throw Error('Image generation unavailable');
      const expected=[...(work.job.target.parentVisual?[work.job.target.parentVisual]:[]),...work.job.target.references];
      if(expected.length>0&&!this.capabilities.referenceEditing)throw Error('Reference input unavailable; no text fallback');
      if(images.length!==expected.length||images.some((v,i)=>v.assetId!==expected[i]?.assetId||v.sha256!==expected[i]?.sha256||!v.path.startsWith('/')||(i===0&&work.job.target.parentVisual&&v.role!=='parent')))throw Error('Verified image inputs mismatch');
    }else if(images.length!==0)throw Error('Unexpected text image inputs');
    this.assertLease(revision);
    return this.turn(work,inputs,callbacks,revision,this.model);
  }
  private async turn(work:RuntimeJob,inputs:NativeInputs,callbacks:Callbacks,revision:number,model:string):Promise<RuntimeResult>{
    let thread:string|null=null;let turn:string|null=null;let persisted=false;let expired=false;
    const pending:JsonRpcMessage[]=[];const items=new Map<string,Record<string,unknown>>();
    let settle!:(v:RuntimeResult)=>void;let fail!:(e:Error)=>void;
    const result=new Promise<RuntimeResult>((resolve,reject)=>{settle=resolve;fail=reject;});
    // An early disconnect may reject before setup reaches await result.
    void result.catch(()=>{});
    const consume=(m:JsonRpcMessage)=>{
      const p=record(m.params);if(!p||p.threadId!==thread)return;
      if(!persisted){if(pending.length>=100){fail(Error('Provider event buffer exceeded'));return;}pending.push(m);return;}
      if(m.method==='item/started'&&p.turnId===turn)callbacks.progress('Codex 正在处理当前任务');
      if(m.method==='item/completed'&&p.turnId===turn){const item=record(p.item);if(identity(item?.id)&&(item.type==='imageGeneration'||item.type==='agentMessage')){if(items.size>=100){fail(Error('Provider item bound exceeded'));return;}items.set(item.id,item);}}
      if(m.method!=='turn/completed')return;
      const completed=record(p.turn);if(completed?.id!==turn)return;
      if(completed.status==='interrupted'){settle({kind:'cancelled'});return;}
      if(completed.status==='failed'){settle({kind:'failed',error:'Codex 已确认任务失败'});return;}
      if(completed.status!=='completed'){fail(Error('Unknown provider terminal status'));return;}
      if(work.kind==='text'){
        const text=[...items.values()].filter(i=>i.type==='agentMessage'&&(i.phase===null||i.phase===undefined||i.phase==='final_answer')).map(i=>i.text);
        if(text.length!==1||typeof text[0]!=='string'||Buffer.byteLength(text[0])>2*1024*1024){settle({kind:'failed',error:'Codex 未返回唯一完整的配对文本结果'});return;}
        settle({kind:'text',text:text[0]});return;
      }
      const images=[...items.values()].filter(i=>i.type==='imageGeneration');
      if(images.length!==1){settle({kind:'failed',error:images.length===0?'Codex 已完成但未返回图片':'Codex 返回多张图片，无法确定唯一结果'});return;}
      const image=images[0]!;
      if(record(image.failure)?.type==='usageLimitExceeded'){settle({kind:'failed',error:'Codex 图片额度已用尽'});return;}
      const png=typeof image.result==='string'?image.result.replace(/^data:image\/png;base64,/, ''):'';
      if(image.status!=='completed'||image.failure!==null||png.length>Math.ceil(32*1024*1024/3)*4||!png||png.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(png)){settle({kind:'failed',error:'Codex 图片结果失败或格式无效'});return;}
      settle({kind:'image',pngBase64:png});
    };
    const unsubscribe=this.client.onServerMessage(consume);
    const exit=this.client.onExit(()=>fail(Error('Private provider exited; outcome unknown')));
    const timer=setTimeout(()=>{expired=true;fail(Error('Private turn timed out; outcome unknown'));void this.interrupt(work).catch(()=>{});},10*60*1000);
    const check=()=>{this.assertLease(revision);if(expired)throw Error('Private turn setup expired');};
    try{
      const started=record(await this.client.privateV3Request('thread/start',{cwd:inputs.cwd,modelProvider:'openai',model,allowProviderModelFallback:false,approvalPolicy:'never',approvalsReviewer:'user',sandbox:'read-only',ephemeral:true}));
      const t=record(started?.thread);if(!identity(t?.id))throw Error('Private thread identity missing');thread=t.id;
      await callbacks.identity({threadId:thread,turnId:null});check();
      if(started?.modelProvider!=='openai'||t.modelProvider!=='openai'||started?.model!==model)throw Error('Private thread route mismatch');
      const entry={identity:{threadId:thread,turnId:null} as ProviderIdentity,cancel:false,invalidate:()=>fail(Error('Account changed during provider work; outcome unknown'))};
      this.active.set(work.job.requestId,entry);
      const start=record(await this.client.privateV3Request('turn/start',{threadId:thread,model,input:[{type:'text',text:work.job.target.prompt,text_elements:[]},...inputs.images.map(i=>({type:'localImage',path:i.path}))]}));
      const id=record(start?.turn)?.id;if(!identity(id))throw Error('Private turn identity missing');turn=id;entry.identity.turnId=id;
      await callbacks.identity(entry.identity);
      if(entry.cancel||expired)void this.client.privateV3Request('turn/interrupt',{threadId:thread,turnId:turn}).catch(()=>{});
      check();persisted=true;for(const event of pending.splice(0))consume(event);
      return await result;
    }finally{clearTimeout(timer);unsubscribe();exit();this.active.delete(work.job.requestId);}
  }
  async interrupt(work:RuntimeJob):Promise<{acknowledged:boolean}>{
    const entry=this.active.get(work.job.requestId);if(!entry)return {acknowledged:false};entry.cancel=true;
    if(!entry.identity.turnId)return {acknowledged:false};
    try{await this.client.privateV3Request('turn/interrupt',{threadId:entry.identity.threadId,turnId:entry.identity.turnId});return {acknowledged:true};}catch{return {acknowledged:false};}
  }
}
