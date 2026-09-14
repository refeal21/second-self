/** Synthetic child entrypoint; never imported by the bundled sidecar. */
import { readFileSync } from 'node:fs';
import { runPresalesRuntime } from './runtime.js';
const fixture=JSON.parse(readFileSync(process.argv[2]!,'utf8')) as {png:string;outline:unknown;details:unknown;delayMs?:number;exitAfterResult?:boolean};
if(fixture.exitAfterResult){
  const write=process.stdout.write.bind(process.stdout);
  process.stdout.write=(chunk:string|Uint8Array)=>write(chunk,()=>{if(String(chunk).includes('"method":"presales/result"'))process.exit(0);});
}
await runPresalesRuntime({available:true,async execute(work,callbacks){
  await callbacks.identity({threadId:`thread-${work.job.requestId}`,turnId:null});
  const index=Number(work.job.requestId.split('-').at(-1))||0;
  await new Promise(resolve=>setTimeout(resolve,fixture.delayMs??Math.max(10,120-index*15)));
  await callbacks.identity({threadId:`thread-${work.job.requestId}`,turnId:`turn-${work.job.attemptId}`});
  callbacks.progress('Synthetic provider result ready');
  return work.kind==='text'?{kind:'text',text:JSON.stringify(fixture[work.job.target.stage])}:{kind:'image',pngBase64:fixture.png};
},async interrupt(){return {acknowledged:true};}});
