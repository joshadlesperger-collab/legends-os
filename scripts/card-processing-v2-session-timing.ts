import {persistV2SessionTiming} from '../lib/card-processing-v2-session-timing.ts';
async function main(){const[file,sha256]=process.argv.slice(2);if(!file||!/^[a-f0-9]{64}$/.test(sha256??''))throw Error('Actual hash-bound session evidence required');console.log(JSON.stringify(await persistV2SessionTiming(process.cwd(),{path:file,sha256})));}
main().catch(()=>{console.error('Session timing import failed; retained evidence remains available. No inventory or saved draft verification was performed.');process.exitCode=1;});
