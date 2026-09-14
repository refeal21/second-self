import type { AppServerExit, AppServerTransport } from '../app-server.js';

/** JSONL proxy to the native owner's child; no spawn, file, or legacy lane. */
export class PrivateAppServerTransport implements AppServerTransport {
  private lines=new Set<(line:string)=>void>();
  private exits=new Set<(detail:AppServerExit)=>void>();
  private started=false;
  private root:string|null=null;
  constructor(private readonly native:(method:string,params:unknown)=>Promise<unknown>){}
  async start():Promise<void>{
    if(this.started)return;
    const result=await this.native('native/provider/start',{}) as {cwd?:unknown};
    if(typeof result?.cwd!=='string'||!result.cwd.startsWith('/'))throw Error('Native provider root missing');
    this.root=result.cwd;this.started=true;
  }
  async cwd():Promise<string>{await this.start();return this.root!;}
  async send(line:string):Promise<void>{
    if(!this.started||Buffer.byteLength(line)>9*1024*1024||/[\r\n]/.test(line))throw Error('Private provider frame rejected');
    await this.native('native/provider/send',{line});
  }
  onLine(fn:(line:string)=>void){this.lines.add(fn);return ()=>{this.lines.delete(fn);};}
  onExit(fn:(detail:AppServerExit)=>void){this.exits.add(fn);return ()=>{this.exits.delete(fn);};}
  receive(line:string):void{for(const fn of this.lines)fn(line);}
  lost():void{this.started=false;this.root=null;for(const fn of this.exits)fn({code:null,signal:null});}
}
