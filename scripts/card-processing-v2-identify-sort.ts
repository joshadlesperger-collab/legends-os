import env from '@next/env';
import { executeV2IdentifySort, watchV2IdentifySort, recoverV2IdentifySort, pauseV2IdentifySort, startV2UnsentIntakeRemainder } from '../lib/card-processing-v2-identify-sort.ts';
env.loadEnvConfig(process.cwd());
const watcher=process.argv[2]==='--watch';
(process.argv[2]==='--unsent-remainder'?startV2UnsentIntakeRemainder(process.cwd(),process.argv[3]).then(result=>{console.log(JSON.stringify(result));}):process.argv[2]==='--pause'?pauseV2IdentifySort(process.cwd(),process.argv[3],'provider-credit-exhausted').then(result=>{console.log(JSON.stringify(result));}):process.argv[2]==='--recover'?recoverV2IdentifySort(process.cwd()):watcher?watchV2IdentifySort(process.cwd(),process.argv[3]):executeV2IdentifySort(process.cwd(),process.argv[2])).catch(()=>{console.error('Identify and sort stopped; saved originals and checkpoints are preserved.');process.exitCode=1;});
