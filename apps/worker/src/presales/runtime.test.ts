import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { PresalesRuntime, type RuntimeJob, type RuntimeProvider } from './runtime.js';

const job = (n:number):RuntimeJob => ({kind:'image',job:{requestId:`request-${n}`,attemptId:`attempt-${n}`,epoch:1,target:{projectId:'synthetic',slideId:`page-${n}`,prompt:`中文 prompt ${n}`,promptVersion:'fixture',feedback:'',spec:{version:'v',sha256:'a'.repeat(64)},design:{version:'v',sha256:'b'.repeat(64)},skill:{version:'v',sha256:'c'.repeat(64)},palette:{version:'v',sha256:'d'.repeat(64)},parentVisual:null,references:[]}}});

describe('private async presales runtime',()=>{
  it('acknowledges status while actual private provider bootstrap awaits native RPC',async()=>{
    const lines:Record<string,unknown>[]=[];
    const runtime=new PresalesRuntime(undefined,line=>lines.push(JSON.parse(line) as Record<string,unknown>),true);
    await runtime.handle({id:'status',method:'presales/status',params:{generation:1}});
    expect(lines.find(l=>l.id==='status')?.result).toMatchObject({available:false});
    runtime.close();
  });
  it.each([1,2,4])('accepts %i native claims without blocking callbacks or RPC, preserving out-of-order identities',async count=>{
    const lines: Record<string,unknown>[]=[];
    const release: (()=>void)[]=[];
    const provider:RuntimeProvider={available:true,async execute(work,callbacks){
      await callbacks.identity({threadId:`t-${work.job.requestId}`,turnId:null});
      await new Promise<void>(resolve=>release.push(resolve));
      await callbacks.identity({threadId:`t-${work.job.requestId}`,turnId:`turn-${work.job.attemptId}`});
      return {kind:'image',pngBase64:'synthetic-bytes'};
    },async interrupt(){return {acknowledged:true};}};
    const runtime = new PresalesRuntime(provider,line=>{lines.push(JSON.parse(line) as Record<string,unknown>);});
    for(let n=0;n<count;n++) await runtime.handle({id:`start-${n}`,method:'presales/start',params:{generation:7,work:job(n)}});
    await runtime.handle({id:'snapshot',method:'presales/status',params:{generation:7}});
    expect(lines.find(l=>l.id==='snapshot')?.result).toMatchObject({active:count});
    expect(lines.filter(l=>l.method==='native/identity')).toHaveLength(count);
    for(const line of lines.filter(l=>l.method==='native/identity')) await runtime.handle({id:String(line.id),result:{persisted:true}});
    await new Promise(resolve=>setImmediate(resolve));
    expect(release).toHaveLength(count);
    for(let n=count-1;n>=0;n--){
      release[n]!();
      await new Promise(resolve=>setImmediate(resolve));
      const identity = lines.filter(l=>l.method==='native/identity').at(-1)!;
      await runtime.handle({id:String(identity.id),result:{persisted:true}});
      await new Promise(resolve=>setImmediate(resolve));
    }
    const completions=lines.filter(l=>l.method==='presales/result').map(l=>l.params as {work:RuntimeJob});
    expect(completions.map(c=>c.work.job.requestId)).toEqual(Array.from({length:count},(_,n)=>`request-${count-n-1}`));
    runtime.close();
  });
  it('gates both kinds before provider dispatch and rejects legacy methods',async()=>{
    const lines:Record<string,unknown>[]=[];
    const runtime=new PresalesRuntime(undefined,line=>lines.push(JSON.parse(line) as Record<string,unknown>));
    await runtime.handle({id:'start',method:'presales/start',params:{generation:1,work:job(0)}});
    expect(lines[0]?.error).toMatchObject({message:expect.stringContaining('route')});
    await runtime.handle({id:'legacy',method:'ppt/regenerate',params:{}});
    expect(lines[1]?.error).toBeDefined();
    runtime.close();
  });
  it('does not continue a provider after a negative persistence reply',async()=>{
    const lines:Record<string,unknown>[]=[];
    const runtime=new PresalesRuntime({available:true,async execute(work,callbacks){await callbacks.identity({threadId:'t',turnId:'turn'});return {kind:'image',pngBase64:'bytes'};},async interrupt(){return {acknowledged:true};}},line=>lines.push(JSON.parse(line) as Record<string,unknown>));
    await runtime.handle({id:'start',method:'presales/start',params:{generation:1,work:job(0)}});
    const identity=lines.find(l=>l.method==='native/identity')!;
    await runtime.handle({id:String(identity.id),result:{persisted:false}});
    await new Promise(resolve=>setImmediate(resolve));
    expect(lines.some(l=>l.method==='presales/result')).toBe(false);
    expect(lines.some(l=>l.method==='presales/unknown')).toBe(true);
    runtime.close();
  });
  it('real child stdin services a persistence callback, snapshot, and interrupt during a held job',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'v3-worker-'));
    const fixture=join(dir,'fixture.json');await writeFile(fixture,JSON.stringify({png:'bytes',outline:{},details:{},delayMs:10000}));
    const child=spawn(process.execPath,['--import',join(process.cwd(),'node_modules/tsx/dist/loader.mjs'),join(process.cwd(),'src/presales/runtime-child.test-support.ts'),fixture],{stdio:['pipe','pipe','pipe']});
    const lines:Record<string,unknown>[]=[];const reader=createInterface({input:child.stdout});
    reader.on('line',line=>lines.push(JSON.parse(line) as Record<string,unknown>));
    const wait=async(predicate:()=>boolean)=>{const deadline=Date.now()+4000;while(!predicate()){if(Date.now()>deadline)throw new Error('private child response timeout');await new Promise(resolve=>setTimeout(resolve,5));}};
    const send=(value:unknown)=>child.stdin.write(`${JSON.stringify(value)}\n`);
    try{
      // Split a Chinese UTF-8 code point across native writes.
      const bytes=Buffer.from(`${JSON.stringify({id:'start',method:'presales/start',params:{generation:2,work:job(1)}})}\n`);
      const split=bytes.indexOf(Buffer.from('中文'))+1;child.stdin.write(bytes.subarray(0,split));child.stdin.write(bytes.subarray(split));
      await wait(()=>lines.some(l=>l.method==='native/identity'));
      const identity=lines.find(l=>l.method==='native/identity')!;send({id:identity.id,result:{persisted:true}});
      send({id:'status',method:'presales/status',params:{generation:2}});
      send({id:'interrupt',method:'presales/interrupt',params:{generation:2,requestId:'request-1'}});
      await wait(()=>lines.some(l=>l.id==='status')&&lines.some(l=>l.id==='interrupt'));
      expect(lines.find(l=>l.id==='status')?.result).toMatchObject({active:1});
      expect(lines.find(l=>l.id==='interrupt')?.result).toEqual({acknowledged:true});
      expect(lines.some(l=>l.method==='presales/result')).toBe(false);
    }finally{child.kill('SIGKILL');await new Promise(resolve=>child.once('close',resolve));reader.close();await rm(dir,{recursive:true,force:true});}
  });
});
