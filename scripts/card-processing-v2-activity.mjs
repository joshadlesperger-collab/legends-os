/** Exact-batch activity control. Child output stays in bounded local evidence;
 * owner elapsed and heartbeats never certify productive work or card completion. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {beginV2Activity,heartbeatV2Activity,checkpointV2Activity,endV2Activity,recordV2ActivityCheckpoint,readV2ActivitySnapshot,withV2Activity} from '../lib/card-processing-v2-activity-client.mjs';
const root=process.cwd();
async function artifact(file,existing=true){
 const base=await fs.realpath(path.join(root,'artifacts')),absolute=path.resolve(root,file),parent=await fs.realpath(path.dirname(absolute)),relative=path.relative(base,parent);
 if(relative.startsWith('..')||path.isAbsolute(relative))throw Error('Activity controls must remain inside artifacts');
 if(existing){const stat=await fs.lstat(absolute);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>262144)throw Error('Bounded regular activity packet required');}
 return absolute;
}
async function packet(file){return JSON.parse(await fs.readFile(await artifact(file),'utf8'));}
async function main(){
 const [command,file,extra,...args]=process.argv.slice(2);
 if(command==='--help'||!command){console.log('snapshot BATCH_ID | checkpoint PACKET | begin PACKET LEASE_FILE | heartbeat/progress/end LEASE_FILE PACKET | run PACKET SCRIPT [ARGS]. Use exact accepted-batch ownership. run defaults to120s, max300s; packet.runTimeoutMs controls this bound. No browser, provider, upload or publication replay.');return;}
 if(command==='snapshot'){console.log(JSON.stringify(await readV2ActivitySnapshot(root,file)));return;}
 if(command==='checkpoint'){const result=await recordV2ActivityCheckpoint(root,await packet(file));console.log(JSON.stringify({batchId:result.batchId,step:result.step,observedAt:result.observedAt}));return;}
 if(command==='begin'){const destination=await artifact(extra,false),lease=await beginV2Activity(root,await packet(file));try{await fs.writeFile(destination,JSON.stringify(lease),{flag:'wx',mode:0o600,flush:true});}catch(error){await endV2Activity(root,lease,{status:'failed',step:'Lease evidence could not be retained'});throw error;}console.log(JSON.stringify({batchId:lease.batchId,operationId:lease.operationId,leaseFile:path.relative(root,destination)}));return;}
 if(['heartbeat','progress','end'].includes(command)){const lease=await packet(file),body=await packet(extra),result=await(command==='heartbeat'?heartbeatV2Activity:command==='progress'?checkpointV2Activity:endV2Activity)(root,lease,body);console.log(JSON.stringify({batchId:lease.batchId,operationId:lease.operationId,status:result.status??command}));return;}
 if(command!=='run')throw Error('Unknown activity command');
 const request=await packet(file),timeout=request.runTimeoutMs??120000;
 if(!Number.isInteger(timeout)||timeout<50||timeout>300000)throw Error('Finite local operation deadline required');
 const {runTimeoutMs:_timeout,...activity}=request,script=await fs.realpath(path.resolve(root,extra)),relative=path.relative(root,script);
 if(relative.startsWith('..')||path.isAbsolute(relative)||!['scripts','artifacts'].includes(relative.split(path.sep)[0])||!['.ts','.mjs','.js','.cjs'].includes(path.extname(script)))throw Error('Existing workspace operation script required');
 const outputFile=path.join(path.dirname(await artifact(file)),`activity-command-${randomUUID()}.log`),output=await fs.open(outputFile,'wx',0o600);let code=null,timedOut=false;
 try{await withV2Activity(root,activity,async({checkpoint})=>{
  await checkpoint('Local operation launch');
  await new Promise((resolve,reject)=>{const child=spawn(process.execPath,['--experimental-strip-types',script,...args],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});let bytes=0,failure=null,writes=Promise.resolve();
   const timer=setTimeout(()=>{timedOut=true;failure=Error('Local operation deadline reached; inspect existing checkpoints before recovery');child.kill();},timeout);
   const retain=chunk=>{bytes+=chunk.length;if(bytes>1048576){failure=Error('Local operation output exceeded bound');child.kill();}else writes=writes.then(()=>output.write(chunk)).catch(error=>{failure=error;child.kill();});};
   child.stdout.on('data',retain);child.stderr.on('data',retain);child.on('error',error=>{clearTimeout(timer);reject(error);});child.on('close',async exitCode=>{clearTimeout(timer);await writes;code=exitCode;if(failure||exitCode!==0)reject(failure??Error('Local operation failed; retained evidence requires inspection'));else resolve();});
  });
  await checkpoint('Local operation returned');
 });}finally{await output.close();console.log(JSON.stringify({outputFile:path.relative(root,outputFile),exitCode:code,timedOut,productiveWorkClaimed:false}));}
}
main().catch(()=>{console.error('Activity operation stopped. Inspect its retained journal/output; do not replay provider, upload or seller writes.');process.exitCode=1;});
