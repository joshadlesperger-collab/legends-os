import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { withQueue,withQueueSnapshot } from '../lib/card-orchestrator-store.ts';
import { parseCardReconciliationReport,recordCardReportEvidence,type ReportEvidenceQueue } from '../lib/card-report-evidence.ts';

async function main() {
  const args=process.argv.slice(2),option=(key:string)=>{const i=args.indexOf(key);return i<0?undefined:args[i+1];};
  if(args.some(x=>x.startsWith('--')&&!['--report','--active','--orders','--queue','--apply'].includes(x)))throw Error('Unknown option');
  const reportFile=option('--report'),activeFile=option('--active'),ordersFile=option('--orders');
  if(!reportFile||!activeFile||!ordersFile)throw Error('Use --report FILE --active CSV --orders CSV [--queue DIR] [--apply]; default is non-persisting validation');
  const directory=path.resolve(option('--queue')??'artifacts/card-orchestrator'),sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
  const reportBytes=await fs.readFile(reportFile),raw=JSON.parse(reportBytes.toString('utf8')),report=parseCardReconciliationReport(raw);
  const csvBytes=await Promise.all([fs.readFile(activeFile),fs.readFile(ordersFile)]);
  ['active','orders'].forEach((kind,i)=>{if(report.provenance.find(s=>s.kind===kind)?.sha256!==sha(csvBytes[i]))throw Error('CSV bytes differ from reconciled report');});
  const apply=args.includes('--apply'),transaction=apply?withQueue:withQueueSnapshot;
  const result=await transaction(directory,async state=>recordCardReportEvidence(state as ReportEvidenceQueue,raw,{
    reportSha256:sha(reportBytes),currentStateSha256:sha(await fs.readFile(path.join(directory,'state.json'))),
  }),{lockWaitMs:30000});
  console.log(JSON.stringify({mode:apply?'applied-evidence-only':'validation-only',...result,liveObservationsCreated:0,receiptsCreated:0,jobsRetired:0,photoMoves:0}));
}
main().catch(()=>{console.error('Report evidence intake failed; verify exact source files, report schema and queue snapshot. No clearance or archive authority granted.');process.exitCode=1;});
