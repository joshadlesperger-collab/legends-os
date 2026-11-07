import env from '@next/env';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {readV2PdcaRegister} from '../lib/card-processing-v2-pdca-store.ts';
import {readV2State} from '../lib/card-processing-v2-store.ts';
import {listV2ProcessingBatches} from '../lib/card-processing-v2-processing-batches.ts';
import {scoreV2PdcaRun,makeV2PdcaCompletionReference} from '../lib/card-processing-v2-pdca.ts';
import {replaceV2Checkpoint} from '../lib/card-processing-v2-atomic-replace.ts';
env.loadEnvConfig(process.cwd());
async function main(){
 const root=process.cwd(),runId=z.string().uuid().parse(process.argv[2]),packet=process.argv[3];if(!packet)throw Error('Evidence ref packet required');const st=await fs.lstat(packet);if(!st.isFile()||st.isSymbolicLink()||st.size>8192)throw Error('Invalid evidence packet');
 const evidence=z.object({path:z.string().min(1),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(JSON.parse(await fs.readFile(packet,'utf8')));
 if(path.isAbsolute(evidence.path)||!evidence.path.replaceAll('\\','/').startsWith('artifacts/')||evidence.path.split(/[\\/]/).includes('..'))throw Error('Artifact evidence required');const base=await fs.realpath(path.join(root,'artifacts')),actual=await fs.realpath(path.join(root,evidence.path)),relative=path.relative(base,actual),auditStat=await fs.lstat(path.join(root,evidence.path));if(!relative||relative.startsWith('..')||path.isAbsolute(relative)||!auditStat.isFile()||auditStat.isSymbolicLink()||auditStat.size>2000000)throw Error('Invalid audit evidence');const audit=await fs.readFile(actual);if(createHash('sha256').update(audit).digest('hex')!==evidence.sha256)throw Error('Audit evidence changed');
 const directory=path.join(root,'artifacts/card-processing-v2/pdca'),lockFile=path.join(directory,'freeze.lock'),lock=await fs.open(lockFile,'wx');
 try{
  const registry=await readV2PdcaRegister(root),run=registry?.runs.find(r=>r.id===runId);if(!run)throw Error('Registered whole run required');if(run.completion){console.log(JSON.stringify({alreadyFrozen:true,baselineRef:run.completion.evidence,endedAt:run.completion.endedAt}));return;}
  const state=await readV2State(root),batches=await listV2ProcessingBatches(root),score=scoreV2PdcaRun(state,run,batches),body=makeV2PdcaCompletionReference(score,evidence),relativeFile=`artifacts/card-processing-v2/pdca/completed-${runId}.json`,bytes=JSON.stringify(body,null,2);await fs.writeFile(path.join(root,relativeFile),bytes,{flag:'wx',flush:true});
  const baselineRef={path:relativeFile,sha256:createHash('sha256').update(bytes).digest('hex')},registerFile=path.join(directory,'register.json'),raw=JSON.parse(await fs.readFile(registerFile,'utf8')),entry=raw.runs.find((r:{id:string})=>r.id===runId);if(!entry||entry.baselineRef||entry.scopeRef.sha256!==run.source.sha256||entry.startedAt!==run.startedAt)throw Error('Register changed; immutable reference retained for reconciliation');entry.baselineRef=baselineRef;entry.role='observed-reference';raw.updatedAt=new Date().toISOString();const temporary=registerFile+'.'+randomUUID()+'.tmp';await fs.writeFile(temporary,JSON.stringify(raw,null,2),{flag:'wx',flush:true});await replaceV2Checkpoint(temporary,registerFile);
  console.log(JSON.stringify({frozen:true,runId,physicalCards:score.totalCards,endedAt:score.endedAt,fullCycleMs:score.fullCycleMs,role:'observed-reference',classification:run.classification,unknownCostCalls:score.cost.unknownCostCalls,baselineRef,cardStateWrites:0,photoReads:0}));
 }finally{await lock.close();await fs.unlink(lockFile);}
}
main().catch(()=>{console.error('The completed reference was not frozen. Preserve the saved evidence and review its exact scope; card records and photos were not changed.');process.exitCode=1;});
