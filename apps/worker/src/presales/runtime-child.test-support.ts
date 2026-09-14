/** Synthetic child entrypoint; never imported by the bundled sidecar. */
import { readFileSync, writeFileSync } from 'node:fs';
import { runPresalesRuntime } from './runtime.js';
const fixture=JSON.parse(readFileSync(process.argv[2]!,'utf8')) as {png:string;outline:unknown;details:unknown;delayMs?:number;exitAfterResult?:boolean;resultMarker?:string;interruptMarker?:string;heldRequest?:string};
if(fixture.exitAfterResult||fixture.resultMarker){
  const write=process.stdout.write.bind(process.stdout);
  process.stdout.write=(chunk:string|Uint8Array)=>write(chunk,()=>{if(String(chunk).includes('"method":"presales/result"')){if(fixture.resultMarker)writeFileSync(fixture.resultMarker,'emitted');if(fixture.exitAfterResult)process.exit(0);}});
}
await runPresalesRuntime({available:true,async execute(work,callbacks){
  await callbacks.identity({threadId:`thread-${work.job.requestId}`,turnId:null});
  const index=Number(work.job.requestId.split('-').at(-1))||0;
  await new Promise(resolve=>setTimeout(resolve,work.job.requestId===fixture.heldRequest?10000:fixture.delayMs??Math.max(10,120-index*15)));
  await callbacks.identity({threadId:`thread-${work.job.requestId}`,turnId:`turn-${work.job.attemptId}`});
  callbacks.progress('Synthetic provider result ready');
  return work.kind==='text'?{kind:'text',text:JSON.stringify(fixture[work.job.target.stage])}:{kind:'image',pngBase64:fixture.png};
},async interrupt(work){if(fixture.interruptMarker)writeFileSync(fixture.interruptMarker,work.job.requestId);return {acknowledged:true};}});
