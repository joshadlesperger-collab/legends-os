import { archiveV2DraftPhotos, recoverV2DraftArchives } from "../lib/card-processing-v2-draft-archive.ts";
import {archiveV2ListedPhotos} from "../lib/card-processing-v2-listed-archive.ts";
import {registerV2BatchContext} from "../lib/card-processing-v2-batch-context.ts";
import {reconcileV2AdvisoryWarnings} from "../lib/card-processing-v2-advisory-recovery.ts";
import env from "@next/env";
import { runV2, initializeV2, admitNewV2Cards } from "../lib/card-processing-v2-worker.ts";
import { publicV2Snapshot } from "../lib/card-processing-v2-store.ts";
import { v2PhotoHost } from "../lib/card-processing-v2-media.ts";
import fs from "node:fs/promises";
import { beginV2Draft, recordV2Import, verifyV2Draft, reviewV2DraftDescription } from "../lib/card-processing-v2-draft-lifecycle.ts";
import { reconcileV2Usage, reviewV2Identity } from "../lib/card-processing-v2-review.ts";
import { reviewV2Nonprice } from "../lib/card-processing-v2-nonprice-review.ts";
import { v2SellerAccess } from "../lib/card-processing-v2-connection.ts";
import { fetchV2Categories } from "../lib/card-processing-v2-category.ts";
import { resolveV2Selection } from "../lib/card-processing-v2-selection.ts";
import {inspectV2Readiness,activateV2PreparedContext,prepareV2NextBatchContext,V2ReadinessError} from '../lib/card-processing-v2-readiness.ts';
import {listV2Candidates} from '../lib/card-processing-v2-selection.ts';
import {v2Dir} from '../lib/card-processing-v2-store.ts';
import path from 'node:path';

env.loadEnvConfig(process.cwd());
async function main() {
  const [command = "status", jobId, selectionFile,executionMode] = process.argv.slice(2);
  if (command === "run") {
    if(executionMode&&!['end-to-end','prepare-only'].includes(executionMode))throw Error('Use end-to-end with an acknowledged browser consumer, or explicit prepare-only');
    const sellerAccess = v2SellerAccess();
    let selection;
    if (selectionFile) { const stat = await fs.stat(selectionFile); if (stat.size > 100000) throw Error("Selection request exceeds the bounded size limit."); selection = await resolveV2Selection(process.cwd(), JSON.parse(await fs.readFile(selectionFile, "utf8"))); }
    if(!selection)selection=await resolveV2Selection(process.cwd(),{mode:'all',token:(await listV2Candidates()).token});
    if(!selection.activationRequired){
      const readiness=await inspectV2Readiness(process.cwd(),{mode:'selected',token:selection.token,candidateIds:selection.candidateIds,...(selection.sourceTransferId?{sourceTransferId:selection.sourceTransferId}:{})},{verifySeller:sellerAccess});
      await fs.mkdir(v2Dir(),{recursive:true});await fs.writeFile(path.join(v2Dir(),`readiness-${jobId??crypto.randomUUID()}.json`),JSON.stringify(readiness.report,null,2),{flag:'wx'});
      if(!readiness.report.ready)throw new V2ReadinessError(readiness.report);
      await activateV2PreparedContext(process.cwd(),selection);
    }
    const state = await runV2(process.cwd(), jobId, { ...(selection ? { selection } : {}),requireUploaderAdmission:executionMode==='end-to-end', hostPhoto: v2PhotoHost(sellerAccess), categoryRequirements: async ids => fetchV2Categories(await sellerAccess(), ids) });
    console.log(JSON.stringify({ jobId: state.lastRun?.id, status: state.lastRun?.status }));
  }
  else if(command==='prepare-next-context'){
    if(!jobId)throw Error('Exact context packet required');const st=await fs.stat(jobId);if(st.size>262144)throw Error('Bounded context packet required');
    console.log(JSON.stringify(await prepareV2NextBatchContext(process.cwd(),JSON.parse(await fs.readFile(jobId,'utf8')))));
  }
  else if(command==='preflight'){
    if(!jobId)throw Error('Exact selection packet required');const st=await fs.stat(jobId);if(st.size>100000)throw Error('Bounded selection packet required');
    const r=await inspectV2Readiness(process.cwd(),JSON.parse(await fs.readFile(jobId,'utf8')),{verifySeller:v2SellerAccess()});console.log(JSON.stringify(r.report,null,2));if(!r.report.ready)process.exitCode=1;
  }
  else if (command === "recover-archives") console.log(JSON.stringify(await recoverV2DraftArchives(process.cwd())));
  else if (command === "initialize") console.log(JSON.stringify(await initializeV2()));
  else if (command === "admit") console.log(JSON.stringify(await admitNewV2Cards()));
  else if (command === "status") { const snapshot = await publicV2Snapshot(); console.log(JSON.stringify({ ...snapshot.summary, configuration: snapshot.configuration, running: snapshot.running, notices: snapshot.state.notices }, null, 2)); }
  else if (["begin", "record-import", "verify", "review-description", "review-identity", "reconcile-usage", "review-nonprice", "archive-drafts", "archive-inventory", "register-batch-context", "reconcile-advisory-warnings"].includes(command)) {
    if (!jobId) throw Error("A bounded operation packet file is required.");
    const stat = await fs.stat(jobId); if (stat.size > 1_000_000) throw Error("Operation packet exceeds the bounded size limit.");
    const packet = JSON.parse(await fs.readFile(jobId, "utf8"));
    const result = command === "reconcile-advisory-warnings" ? await reconcileV2AdvisoryWarnings(process.cwd(),packet)
      : command === "register-batch-context" ? await registerV2BatchContext(process.cwd(),packet)
      : command === "archive-inventory" ? await archiveV2ListedPhotos(process.cwd(),packet)
      : command === "archive-drafts" ? await archiveV2DraftPhotos(process.cwd(), packet.cardIds, packet.authority)
      : command === "begin" ? await beginV2Draft(process.cwd(), packet.groupId, packet.payload, packet.reconciliation, packet.options)
      : command === "record-import" ? await recordV2Import(process.cwd(), packet.key, packet.receipt)
      : command === "verify" ? await verifyV2Draft(process.cwd(), packet.key, packet.readback)
      : command === "review-description" ? await reviewV2DraftDescription(process.cwd(), packet.key, packet.review)
      : command === "review-identity" ? await reviewV2Identity(process.cwd(), packet)
      : command === "review-nonprice" ? await reviewV2Nonprice(process.cwd(), packet)
      : await reconcileV2Usage(process.cwd(), packet);
    console.log(JSON.stringify(result));
  } else throw Error("Use initialize, run, status, begin, record-import, verify, review-description, review-identity, review-nonprice or reconcile-usage.");
}
main().catch(error => { console.error(error instanceof V2ReadinessError?error.report.blockers.join(' '):"Card Processing V2 stopped. Review its dashboard and retained checkpoints; credentials and provider responses are suppressed."); process.exitCode = 1; }).finally(async()=>{ if(process.env.DATABASE_URL){const {prisma}=await import("../lib/prisma.ts");await prisma.$disconnect();} });
