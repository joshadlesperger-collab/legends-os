import fs from 'node:fs/promises';
import { planV2FutureBatch } from '../lib/card-processing-v2-future-flow.ts';
async function main(){
const packet=process.argv[2];
if(!packet){console.error('Provide an explicit selected-group observation packet. This command only prints a read-only workplan.');process.exitCode=1;}
else{try{console.log(JSON.stringify(planV2FutureBatch(JSON.parse(await fs.readFile(packet,'utf8'))),null,2));}catch{console.error('Future-batch packet refused; no state, price, photo or external operation changed.');process.exitCode=1;}}

}
void main();
