import {readFileSync, existsSync} from 'node:fs';
import {assessBulkImportTrial} from '../lib/bulk-import-acceptance.mjs';

// Read-only, explicitly scoped: unrelated paused backlog cannot trigger execution.
const ids=process.argv.slice(2);
if(!ids.length || new Set(ids).size!==ids.length) {
  console.error('Supply distinct task IDs for the active user request.');
  process.exit(2);
}
const queue=JSON.parse(readFileSync('artifacts/engineering-mission/work-queue.json','utf8'));
const results=ids.map(id=>{
  const task=queue.tasks.find(t=>t.id===id);
  const evidencePresent=!!task?.checkpoint && existsSync(task.checkpoint);
  let acceptance=null;
  if(task?.acceptanceKind==='bulk-import') {
    try { acceptance=assessBulkImportTrial(JSON.parse(readFileSync(task.measurableOutcome?.acceptanceEvidence,'utf8')),existsSync); }
    catch { acceptance={passed:false,failures:['Valid retained acceptanceEvidence JSON required']}; }
  }
  return {id,status:task?.status??'missing',evidencePresent,
    complete:task?.status==='done'&&evidencePresent&&(!acceptance||acceptance.passed),acceptance,
    blocker:task?.failureReason??null,
    action:task?.status==='done'&&evidencePresent?'Review completion evidence':'Continue eligible work; only an explicit pause or genuine external blocker justifies stopping'};
});
console.log(JSON.stringify({canReportComplete:results.every(r=>r.complete),results,
  note:'File presence is not proof of outcome. Inspect evidence; re-evaluate stale blockers against latest user decisions.'},null,2));
process.exitCode=results.every(r=>r.complete)?0:1;
