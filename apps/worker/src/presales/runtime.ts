/** Private application-owned mode. Native owns claims, slots, epochs and files. */
import type { JsonRpcMessage } from '../app-server.js';
import { buildPairedAuthoringPrompt, parsePairedAuthoringResult, type PairedAuthoringContext } from './authoring.js';

type VersionHash={version:string;sha256:string};
type ImageReference={assetId:string;sha256:string};
export interface ImageTarget {
  projectId:string;slideId:string;spec:VersionHash;design:VersionHash;skill:VersionHash;palette:VersionHash;
  parentVisual:ImageReference|null;references:ImageReference[];
  referenceContext?:{image:ImageReference;relativePath:string;byteLength:number;purpose:'style'|'layout'|'composition'}[];
  promptVersion:string;prompt:string;feedback:string;
}
export interface V3TextTarget extends PairedAuthoringContext {
  schemaVersion:number;projectId:string;expectedRevision:number;draftSha256:string;stage:'outline'|'details';
  origin:unknown;importId:string;outlineApproval:unknown;promptVersion:string;prompt:string;
}
type Attempt={requestId:string;attemptId:string;epoch:number};
export type RuntimeJob = {kind:'image';job:Attempt & {target:ImageTarget}} |
  {kind:'text';job:Attempt & {operationId:string;target:V3TextTarget;targetSha256:string}};
export type RuntimeResult={kind:'image';pngBase64:string}|{kind:'text';text:string}|{kind:'cancelled'}|{kind:'failed';error:string};
export type ProviderIdentity={threadId:string;turnId:string|null};
export interface RuntimeProvider {
  readonly available:boolean;
  execute(work:RuntimeJob,callbacks:{identity(identity:ProviderIdentity):Promise<void>;progress(detail:string):void}):Promise<RuntimeResult>;
  interrupt(work:RuntimeJob):Promise<{acknowledged:boolean}>;
}
const closedProvider:RuntimeProvider={available:false,async execute(){throw new Error('Common stock-account route has not been validated');},async interrupt(){return {acknowledged:false};}};
type Pending={resolve(value:unknown):void;reject(error:Error):void;timer:ReturnType<typeof setTimeout>};

export class PresalesRuntime {
  private readonly provider:RuntimeProvider;
  private readonly active=new Map<string,RuntimeJob>();
  private readonly pending=new Map<string,Pending>();
  private generation:number|null=null;
  private sequence=0;
  private closed=false;
  constructor(provider:RuntimeProvider|undefined,private readonly emit:(line:string)=>void){this.provider=provider??closedProvider;}
  private send(message:unknown):void {
    if(this.closed) throw new Error('Private runtime is closed');
    const line=JSON.stringify(message);
    if(Buffer.byteLength(line)>72*1024*1024) throw new Error('Private output exceeds frame limit');
    this.emit(line);
  }
  private native(method:string,params:unknown):Promise<unknown>{
    if(this.pending.size>=32) return Promise.reject(new Error('Private native callback capacity exceeded'));
    const id=`native:${++this.sequence}`;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('Native persistence response timed out'));},15_000);
      this.pending.set(id,{resolve,reject,timer});
      try{this.send({id,method,params});}catch(error){clearTimeout(timer);this.pending.delete(id);reject(error);}
    });
  }
  async handle(message:JsonRpcMessage):Promise<void>{
    if(this.closed) throw new Error('Private runtime is closed');
    if(typeof message.id==='string' && message.id.startsWith('native:') && message.method===undefined){
      const pending=this.pending.get(message.id);
      if(!pending) throw new Error('Unknown native reply');
      this.pending.delete(message.id);clearTimeout(pending.timer);
      if(message.error) pending.reject(new Error(message.error.message)); else pending.resolve(message.result);
      return;
    }
    try{
      if(typeof message.id!=='string' || message.id.startsWith('native:')) throw new Error('Native request identity required');
      const params=message.params as {generation?:number;work?:RuntimeJob;requestId?:string}|undefined;
      if(!Number.isSafeInteger(params?.generation) || params!.generation!<1) throw new Error('Invalid process generation');
      if(this.generation===null) this.generation=params!.generation!;
      if(this.generation!==params!.generation) throw new Error('Old process generation');
      switch(message.method){
        case 'presales/status': this.send({id:message.id,result:{available:this.provider.available,active:this.active.size,generation:this.generation}});return;
        case 'presales/start': {
          if(!this.provider.available) throw new Error('Common stock-account route has not been validated');
          const work=params!.work;
          if(!work || !['image','text'].includes(work.kind) || !work.job || !work.job.requestId || !work.job.attemptId || !Number.isSafeInteger(work.job.epoch)) throw new Error('Invalid native attempt');
          if(this.active.has(work.job.requestId)) throw new Error('Attempt is already active');
          if(this.active.size>=16) throw new Error('Private protocol active buffer exceeded');
          if(work.kind==='text' && (work.job.operationId!==work.job.requestId || buildPairedAuthoringPrompt(work.job.target.stage,work.job.target)!==work.job.target.prompt)) throw new Error('Native paired prompt mismatch');
          this.active.set(work.job.requestId,work);
          this.send({id:message.id,result:{accepted:true}});
          // Deliberately not awaited: stdin must service persistence replies and
          // interrupts while any provider promise remains outstanding.
          void this.run(work);
          return;
        }
        case 'presales/interrupt': {
          const work=this.active.get(params!.requestId??'');
          if(!work) throw new Error('Attempt is not active in this process');
          void this.provider.interrupt(work).then(result=>this.send({id:message.id,result}),error=>this.send({id:message.id,error:{message:String(error)}}));
          return;
        }
        default: throw new Error('Unknown private runtime method');
      }
    }catch(error){this.send({id:message.id,error:{message:error instanceof Error?error.message:String(error)}});}
  }
  private async run(work:RuntimeJob):Promise<void>{
    let provider:ProviderIdentity|undefined;
    try{
      const result=await this.provider.execute(work,{
        identity:async identity=>{
          const reply=await this.native('native/identity',{generation:this.generation,work,identity});
          if(!reply || typeof reply!=='object' || !('persisted' in reply) || reply.persisted!==true) throw new Error('Native did not confirm provider identity persistence');
          if(!provider?.turnId) provider=identity;
        },
        progress:detail=>this.send({method:'presales/progress',params:{generation:this.generation,requestId:work.job.requestId,attemptId:work.job.attemptId,detail:detail.slice(0,1024)}}),
      });
      if(!provider?.turnId) throw new Error('Provider result has no persisted turn identity');
      if(result.kind==='failed'||result.kind==='cancelled'){
        this.send({method:'presales/terminal',params:{generation:this.generation,work,provider,result}});
        return;
      }
      if(work.kind!==result.kind) throw new Error('Provider result kind mismatch');
      const payload=work.kind==='text' && result.kind==='text'
        ? {kind:'text',envelope:parsePairedAuthoringResult(work.job.target.stage,result.text,work.job.target)} : result;
      this.send({method:'presales/result',params:{generation:this.generation,work,provider,result:payload}});
    }catch(error){
      if(!this.closed) this.send({method:'presales/unknown',params:{generation:this.generation,work,reason:(error instanceof Error?error.message:String(error)).slice(0,4096)}});
    }finally{this.active.delete(work.job.requestId);}
  }
  close():void{
    this.closed=true;
    for(const pending of this.pending.values()){clearTimeout(pending.timer);pending.reject(new Error('Private host disconnected'));}
    this.pending.clear();
  }
}

export async function runPresalesRuntime(provider?:RuntimeProvider):Promise<void>{
  const runtime=new PresalesRuntime(provider,line=>{
    if(process.stdout.writableLength+Buffer.byteLength(line)>80*1024*1024) throw new Error('Private output backpressure limit exceeded');
    process.stdout.write(`${line}\n`);
  });
  let pending=Buffer.alloc(0);
  try{
    for await(const chunk of process.stdin){
      pending=Buffer.concat([pending,Buffer.from(chunk as Uint8Array)]);
      let newline:number;
      while((newline=pending.indexOf(10))!==-1){
        if(newline>9*1024*1024) throw new Error('Private input frame exceeds limit');
        const line=new TextDecoder('utf-8',{fatal:true}).decode(pending.subarray(0,newline));
        pending=pending.subarray(newline+1);
        await runtime.handle(JSON.parse(line) as JsonRpcMessage);
      }
      if(pending.length>9*1024*1024) throw new Error('Private input frame exceeds limit');
    }
    if(pending.length) throw new Error('Private input frame is incomplete');
  }finally{runtime.close();}
}
