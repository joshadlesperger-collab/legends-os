import {readFileSync,writeFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {kinds,matchKey,reviewedIdentity,type QueueState} from "../lib/card-orchestrator.ts";

const source="artifacts/card-orchestrator/state.json";
const text=readFileSync(source,"utf8"),state=JSON.parse(text) as QueueState;
const cards=Object.values(state.cards);
const identities=cards.map(reviewedIdentity).filter(i=>i!==undefined&&i!==null);
const count=(values:string[])=>values.reduce<Record<string,number>>((a,v)=>(a[v]=(a[v]??0)+1,a),{});
const stages=Object.fromEntries(kinds.map(kind=>{
  const jobs=cards.map(c=>c.jobs[kind]);
  const durations=jobs.filter(j=>j.state==="done"&&j.elapsedMs>0).map(j=>j.elapsedMs).sort((a,b)=>a-b);
  return [kind,{states:count(jobs.map(j=>j.state)),attempts:jobs.reduce((n,j)=>n+j.attempts,0),
    jobsWithMultipleAttempts:jobs.filter(j=>j.attempts>1).length,
    duration:{sampleCount:durations.length,medianMs:durations.length?(durations[Math.floor((durations.length-1)/2)]+durations[Math.floor(durations.length/2)])/2:null,p95Ms:durations.length?durations[Math.ceil(durations.length*.95)-1]:null,
      scope:"Saved cumulative elapsedMs for currently completed jobs; includes retries/waits, not a controlled benchmark"},
    topHolds:Object.entries(count(jobs.filter(j=>j.state==="held").map(j=>j.reason??"Unspecified"))).sort((a,b)=>b[1]-a[1]).slice(0,12)}];
}));
const report={asOf:new Date().toISOString(),source,sourceSha256:createHash("sha256").update(text).digest("hex"),revision:state.revision,
  cards:cards.length,reviewedCopies:identities.length,uniqueReviewedPricingIdentities:new Set(identities.map(i=>matchKey(i!))).size,
  uniqueOriginalFronts:new Set(cards.flatMap(c=>c.input.photos.filter(p=>p.side==="front").map(p=>p.sha256))).size,
  stages,evidence:{completedPricingWithComps:cards.filter(c=>c.jobs.pricing.state==="done"&&Array.isArray(c.jobs.pricing.result?.comps)&&c.jobs.pricing.result.comps.length>0).length,
    localTextPrepared:cards.filter(c=>c.jobs.listing.state==="done").length},
  limitations:{apiCostPerCard:null,reason:"Historical provider spend is unreconciled; job elapsed times do not contain billing",productionDatabasePersistence:"Unverified; local snapshot only",ebayDraftReadiness:"Not inferred from local text completion",uniqueIdentityScope:"Existing matchKey pricing identity; excludes per-copy serial and condition; not a physical inventory count",repeatAttempts:"Includes legitimate changed-input work and recovery, not proof of waste"}};
if(readFileSync(source,"utf8")!==text)throw Error("Queue changed during audit; retry against a stable snapshot");
const out=`artifacts/engineering-mission/pipeline-inventory-${Date.now()}.json`;
writeFileSync(out,JSON.stringify(report,null,2),{flag:"wx"});
console.log(JSON.stringify({out,...report},null,2));
