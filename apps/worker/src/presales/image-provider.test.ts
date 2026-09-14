import { describe, expect, it, vi } from 'vitest';
import { CodexAppServerClient, type AppServerExit, type AppServerTransport, type JsonRpcMessage } from '../app-server.js';
import { PrivateCodexProvider } from './image-provider.js';
import type { RuntimeJob } from './runtime.js';

class Protocol implements AppServerTransport {
  sent: JsonRpcMessage[]=[];
  lines=new Set<(line:string)=>void>();
  exits=new Set<(detail:AppServerExit)=>void>();
  account:unknown={account:{type:'chatgpt',email:'synthetic@example.invalid',planType:'pro'},requiresOpenaiAuth:true};
  config:unknown={config:{model_provider:'openai'},origins:{},layers:null};
  image=true; modalities=['text','image']; threadProvider='openai';
  onThread:(()=>void)|undefined;
  held=false;
  terminal='completed';
  imageItem:unknown={type:'imageGeneration',id:'image-1',status:'completed',failure:null,result:'cG5n'};
  accountReadGate:Promise<void>|undefined;
  ignoreMethods=new Set<string>();
  async start(){}
  onLine(fn:(line:string)=>void){this.lines.add(fn);return ()=>{this.lines.delete(fn);};}
  onExit(fn:(detail:AppServerExit)=>void){this.exits.add(fn);return ()=>{this.exits.delete(fn);};}
  emit(v:unknown){for(const fn of this.lines)fn(JSON.stringify(v));}
  async send(line:string){
    const m=JSON.parse(line) as JsonRpcMessage;this.sent.push(m);
    if(this.ignoreMethods.has(m.method??''))return;
    const p=m.params as Record<string,unknown>;
    let result:unknown={};
    switch(m.method){
      case 'account/read':result=this.account;if(this.accountReadGate)await this.accountReadGate;break;
      case 'config/read':result=this.config;break;
      case 'configRequirements/read':result={requirements:null};break;
      case 'model/list':result={data:[{id:'catalog-id',model:'synthetic-model',isDefault:true,inputModalities:this.modalities}],nextCursor:null};break;
      case 'modelProvider/capabilities/read':result={namespaceTools:true,imageGeneration:this.image,webSearch:false};break;
      case 'thread/start':result={thread:{id:'thread-1',modelProvider:this.threadProvider},modelProvider:this.threadProvider,model:'synthetic-model'};this.onThread?.();break;
      case 'turn/start':result={turn:{id:'turn-1'}};break;
    }
    if(m.id!==undefined)this.emit({id:m.id,result});
    if(m.method==='turn/start'&&!this.held){
      if(this.imageItem)this.emit({method:'item/completed',params:{threadId:p.threadId,turnId:'turn-1',item:this.imageItem}});
      this.emit({method:'turn/completed',params:{threadId:p.threadId,turn:{id:'turn-1',status:this.terminal,items:[]}}});
    }
  }
}
const work=():RuntimeJob=>({kind:'image',job:{requestId:'request',attemptId:'attempt',epoch:1,target:{projectId:'project',slideId:'slide',spec:{version:'v',sha256:'a'},design:{version:'v',sha256:'b'},skill:{version:'v',sha256:'c'},palette:{version:'v',sha256:'d'},promptVersion:'frozen',prompt:'只绘制冻结内容；备注不得成为可见文字。',feedback:'',parentVisual:null,references:[]}}});
const inputs={cwd:'/synthetic/assets',images:[] as {assetId:string;sha256:string;path:string;role:string}[]};
const setup=()=>{const protocol=new Protocol();const provider=new PrivateCodexProvider(new CodexAppServerClient(protocol),async()=>inputs,async()=>inputs.cwd);return {protocol,provider};};
const callbacks={async identity(){},progress(){}};

describe('private stock Codex provider',()=>{
  it('accepts documented stock route and sends exact frozen prompt with pinned model',async()=>{
    const {protocol,provider}=setup();await provider.prepare();
    expect(provider.available).toBe(true);expect(provider.capabilities).toEqual({generation:true,referenceEditing:true});
    const identities:unknown[]=[];
    const result=await provider.execute(work(),{...callbacks,async identity(v){identities.push(v);}});
    expect(result).toEqual({kind:'image',pngBase64:'cG5n'});
    expect(identities).toEqual([{threadId:'thread-1',turnId:null},{threadId:'thread-1',turnId:'turn-1'}]);
    expect(protocol.sent.find(m=>m.method==='thread/start')?.params).toMatchObject({modelProvider:'openai',model:'synthetic-model',allowProviderModelFallback:false});
    expect(protocol.sent.find(m=>m.method==='turn/start')?.params).toMatchObject({input:[{type:'text',text:'只绘制冻结内容；备注不得成为可见文字。',text_elements:[]}]});
  });
  it.each([null,{type:'apiKey'},{type:'amazonBedrock'},{type:'unexpected'}])('rejects unsupported account before thread: %j',async account=>{
    const {protocol,provider}=setup();protocol.account={account,requiresOpenaiAuth:true};await provider.prepare();
    expect(provider.available).toBe(false);await expect(provider.execute(work(),callbacks)).rejects.toThrow();
    expect(protocol.sent.some(m=>m.method==='thread/start')).toBe(false);
  });
  it.each([{model_provider:'custom'},{model_provider:'openai',openai_base_url:'https://synthetic.invalid'},{model_provider:'openai',chatgpt_base_url:'https://synthetic.invalid'},{}])('rejects custom or ambiguous private config without leaking it: %j',async config=>{
    const {protocol,provider}=setup();protocol.config={config,origins:{},layers:null};await provider.prepare();
    expect(provider.available).toBe(false);expect(JSON.stringify(provider.capabilities)).not.toContain('synthetic.invalid');
  });
  it('transmits actual parent and ordered references; missing inputs never become text regeneration',async()=>{
    const {protocol,provider}=setup();const job=work();if(job.kind!=='image')throw Error();
    job.job.target.parentVisual={assetId:'parent',sha256:'p'};job.job.target.references=[{assetId:'ref',sha256:'r'}];
    inputs.images=[{assetId:'parent',sha256:'p',path:'/synthetic/assets/parent.png',role:'parent'},{assetId:'ref',sha256:'r',path:'/synthetic/assets/ref.png',role:'style'}];
    try{await provider.prepare();await provider.execute(job,callbacks);
      expect((protocol.sent.find(m=>m.method==='turn/start')?.params as {input:unknown[]}).input).toEqual([{type:'text',text:job.job.target.prompt,text_elements:[]},{type:'localImage',path:'/synthetic/assets/parent.png'},{type:'localImage',path:'/synthetic/assets/ref.png'}]);
      inputs.images=[];await expect(provider.execute(job,callbacks)).rejects.toThrow();
      expect(protocol.sent.filter(m=>m.method==='turn/start')).toHaveLength(1);
    }finally{inputs.images=[];}
  });
  it('text readiness survives missing image tool but reference requests reject',async()=>{
    const {protocol,provider}=setup();protocol.image=false;await provider.prepare();expect(provider.available).toBe(true);expect(provider.capabilities.generation).toBe(false);
    await expect(provider.execute(work(),callbacks)).rejects.toThrow();expect(protocol.sent.some(m=>m.method==='thread/start')).toBe(false);
  });
  it('rejects returned provider mismatch and lease revocation before turn',async()=>{
    for(const changed of [false,true]){const {protocol,provider}=setup();await provider.prepare();
      if(changed)protocol.onThread=()=>protocol.emit({method:'account/updated',params:{authMode:'chatgpt',planType:'pro'}});else protocol.threadProvider='custom';
      await expect(provider.execute(work(),callbacks)).rejects.toThrow();expect(protocol.sent.some(m=>m.method==='turn/start')).toBe(false);
    }
  });
  it('holds completion until native turn persistence and preserves interrupt uncertainty',async()=>{
    const {protocol,provider}=setup();await provider.prepare();let release:(()=>void)|undefined;let done=false;
    const result=provider.execute(work(),{...callbacks,async identity(v){if(v.turnId)await new Promise<void>(r=>{release=r;});}}).then(r=>{done=true;return r;});
    while(!release)await new Promise(r=>setImmediate(r));expect(done).toBe(false);
    expect(await provider.interrupt(work())).toEqual({acknowledged:true});expect(done).toBe(false);release();await result;
    expect(protocol.sent.filter(m=>m.method==='turn/start')).toHaveLength(1);
  });
  it('cannot revive a capability from a delayed account read after any account update',async()=>{
    const {protocol,provider}=setup();let release!:()=>void;
    protocol.accountReadGate=new Promise<void>(r=>{release=r;});const prepare=provider.prepare();
    while(!protocol.sent.some(m=>m.method==='account/read'))await new Promise(r=>setImmediate(r));
    protocol.emit({method:'account/updated',params:{authMode:'chatgpt'}});release();await prepare;
    expect(provider.available).toBe(false);expect(protocol.sent.some(m=>m.method==='thread/start')).toBe(false);
  });
  it('revokes readiness when private route validation rejects a later job',async()=>{
    const {protocol,provider}=setup();await provider.prepare();protocol.config={config:{model_provider:'custom'}};
    await expect(provider.execute(work(),callbacks)).rejects.toThrow();expect(provider.available).toBe(false);
  });
  it.each([
    ['interrupted',null,{kind:'cancelled'}],
    ['failed',null,{kind:'failed',error:'Codex 已确认任务失败'}],
    ['completed',null,{kind:'failed',error:'Codex 已完成但未返回图片'}],
    ['completed',{type:'imageGeneration',id:'image',status:'failed',failure:{type:'usageLimitExceeded'},result:''},{kind:'failed',error:'Codex 图片额度已用尽'}],
  ])('settles only correlated terminal proof: %s',async(status,item,result)=>{
    const {protocol,provider}=setup();protocol.terminal=status as string;protocol.imageItem=item;await provider.prepare();expect(await provider.execute(work(),callbacks)).toEqual(result);
  });
  it('post-dispatch account invalidation and child exit retain unknown without another turn',async()=>{
    for(const account of [true,false]){const {protocol,provider}=setup();protocol.held=true;await provider.prepare();
      const outcome=provider.execute(work(),callbacks);const rejected=expect(outcome).rejects.toThrow();
      while(!protocol.sent.some(m=>m.method==='turn/start'))await new Promise(r=>setImmediate(r));
      if(account)protocol.emit({method:'account/updated',params:{authMode:'apiKey'}});else for(const fn of protocol.exits)fn({code:1,signal:null});
      await rejected;expect(provider.available).toBe(false);expect(protocol.sent.filter(m=>m.method==='turn/start')).toHaveLength(1);
    }
  });
  it('model without image modality rejects parent before opening a thread',async()=>{
    const {protocol,provider}=setup();protocol.modalities=['text'];await provider.prepare();
    expect(provider.capabilities.referenceEditing).toBe(false);const job=work();if(job.kind!=='image')throw Error();job.job.target.parentVisual={assetId:'parent',sha256:'p'};
    await expect(provider.execute(job,callbacks)).rejects.toThrow();expect(protocol.sent.some(m=>m.method==='thread/start')).toBe(false);
  });
  it('bounds an unanswered private start RPC without retrying the turn',async()=>{
    vi.useFakeTimers();
    try{const protocol=new Protocol();const client=new CodexAppServerClient(protocol);await client.connect();protocol.ignoreMethods.add('turn/start');
      const response=client.privateV3Request('turn/start',{threadId:'thread',input:[]});const rejected=expect(response).rejects.toThrow('Private Codex');
      await vi.advanceTimersByTimeAsync(15_001);await rejected;expect(protocol.sent.filter(m=>m.method==='turn/start')).toHaveLength(1);
    }finally{vi.useRealTimers();}
  });
  it('accepts an unset disk provider when the dedicated child already pins openai',async()=>{
    const {protocol,provider}=setup();protocol.config={config:{model_provider:null,openai_base_url:null,chatgpt_base_url:null}};
    await provider.prepare();expect(provider.available).toBe(true);
  });
  it('bounds private initialization even before an account capability exists',async()=>{
    vi.useFakeTimers();const protocol=new Protocol();protocol.ignoreMethods.add('initialize');
    const client=new CodexAppServerClient(protocol,15_000);let settled=false;
    const pending=client.connect().catch(()=>{settled=true;});
    try{await vi.advanceTimersByTimeAsync(15_001);expect(settled).toBe(true);}
    finally{client.dispose();await pending;vi.useRealTimers();}
  });
});
