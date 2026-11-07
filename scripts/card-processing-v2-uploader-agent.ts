/** Active ChatGPT internal-browser consumer controls. These commands never
 * launch a browser, accept agreements, upload, publish or renew themselves. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {armV2Uploader,acknowledgeV2Uploader,waitV2Uploader,progressV2Uploader,consumeV2UploaderHandoff,closeV2Uploader,getV2UploaderStatus} from '../lib/card-processing-v2-uploader-admission.ts';
async function packet(file:string){const root=await fs.realpath(path.join(process.cwd(),'artifacts')),full=await fs.realpath(path.resolve(file)),relative=path.relative(root,full),st=await fs.lstat(full);if(!relative||relative.startsWith('..')||path.isAbsolute(relative)||!st.isFile()||st.isSymbolicLink()||st.size>262144)throw Error('Bounded packet inside artifacts required');return JSON.parse(await fs.readFile(full,'utf8'));}
async function main(){const [command='help',file,argument]=process.argv.slice(2),root=process.cwd();
 if(command==='help'||command==='--help'){console.log('status | arm PACKET LEASE_FILE | wait LEASE_FILE [0..30000ms] | acknowledge LEASE_FILE PACKET | progress LEASE_FILE PACKET | consume LEASE_FILE RUN_ID | close LEASE_FILE PACKET. Arm requires exact resolved selection and fresh actual internal-browser Uploads evidence. wait is observation only: no auto-ack or self-heartbeat. Active agent must acknowledge the button challenge, consume the actual prepared manifest, then use normal once-only uploader/verification/archive flows.');return;}
 if(command==='status'){console.log(JSON.stringify(await getV2UploaderStatus(root)));return;}
 if(!file)throw Error('Explicit consumer packet required');
 if(command==='arm'){if(!argument)throw Error('Explicit local lease destination required');const base=await fs.realpath(path.join(root,'artifacts')),full=path.resolve(argument),parent=await fs.realpath(path.dirname(full)),rel=path.relative(base,parent);if(rel.startsWith('..')||path.isAbsolute(rel))throw Error('Lease must remain in artifacts');const p=await packet(file);if(!p.selection?.captures)p.selection=await(await import('../lib/card-processing-v2-selection.ts')).resolveV2Selection(root,p.selection);const lease=await armV2Uploader(root,p);try{await fs.writeFile(full,JSON.stringify(lease),{flag:'wx',mode:0o600,flush:true});}catch(error){await closeV2Uploader(root,lease,'Consumer lease could not be retained; nothing was admitted');throw error;}console.log(JSON.stringify({owner:lease.owner,leaseFile:argument,expiresInMs:60000,automaticBrowserExecution:false}));return;}
 const lease=await packet(file),result=command==='wait'?await waitV2Uploader(root,lease,argument===undefined?20000:Number(argument))
 :command==='acknowledge'?await acknowledgeV2Uploader(root,lease,await packet(argument))
 :command==='progress'?await progressV2Uploader(root,lease,(await packet(argument)).step)
 :command==='consume'?await consumeV2UploaderHandoff(root,lease,argument)
 :command==='close'?await closeV2Uploader(root,lease,(await packet(argument)).reason):undefined;
 if(!result)throw Error('Unknown consumer command');console.log(JSON.stringify(result));
}
main().catch(error=>{console.error(error instanceof Error?error.message:'Uploader consumer stopped; retained jobs must resume without replay.');process.exitCode=1;});
