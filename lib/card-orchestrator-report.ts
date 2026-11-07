import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { withQueueSnapshot } from "./card-orchestrator-store.ts";
import type { QueueState } from "./card-orchestrator.ts";

export class ReportSnapshotChanged extends Error {}
export type ReportReview = {revision:number;reviewStamp:string;approvalStamp:string};
export type ReportSnapshot = {queueRevision:number;asOf:string;reportId:string;reviewStamp:string;approvalStamp:string};
type ReportFiles = {"status.json":string;"status.html":string;"review-listings.json":string};

/** Retry only transient sharing failures; never delete a destination to force replacement. */
export async function renameReportFile(source:string,destination:string,check:()=>Promise<void>,
  rename:(source:string,destination:string)=>Promise<void>=fs.rename,
  wait:(milliseconds:number)=>Promise<void>=ms=>new Promise(resolve=>setTimeout(resolve,ms))) {
  for(let attempt=0;;attempt++) {
    await check();
    try {await rename(source,destination);return;}
    catch(error) {
      if(!["EPERM","EBUSY"].includes((error as NodeJS.ErrnoException).code??"")||attempt>=2)throw error;
      await wait(attempt===0?50:150);
    }
  }
}

/** Only capture and publication hold the queue lock. Rendering never mutates the durable queue. */
export async function writeQueueReport<Review extends ReportReview,Result>(directory:string,
  reviews:{read:()=>Promise<Review>;isCurrent:(review:Review)=>Promise<boolean>},
  render:(state:QueueState,review:Review,snapshot:ReportSnapshot)=>Promise<{files:ReportFiles;result:Result}>|{files:ReportFiles;result:Result}) {
  for(let attempt=0;;attempt++) {
    let staging:string|undefined;
    try {
      const review=await reviews.read();
      const check=async(state:QueueState)=>{
        if(state.revision!==review.revision||!await reviews.isCurrent(review))throw new ReportSnapshotChanged("Report sources changed; refresh the report again");
      };
      const captured=await withQueueSnapshot(directory,async state=>{
        await check(state);
        return {state,snapshot:{queueRevision:state.revision,asOf:new Date().toISOString(),reportId:randomUUID(),reviewStamp:review.reviewStamp,approvalStamp:review.approvalStamp}};
      });
      const output=await render(captured.state,review,captured.snapshot);
      staging=await fs.mkdtemp(path.join(directory,"report-stage-"));
      // Prepare every file before taking the publication lock. status.json is the generation marker.
      const names=["review-listings.json","status.html","status.json"] as const;
      for(const name of names) {
        const file=await fs.open(path.join(staging,name),"wx");
        try {await file.writeFile(output.files[name]);await file.sync();}finally{await file.close();}
      }
      const reportPublished=await withQueueSnapshot(directory,async state=>{
        await check(state);
        try {
          const previous=JSON.parse(await fs.readFile(path.join(directory,"status.json"),"utf8"));
          if(previous.reportSnapshot?.queueRevision===captured.snapshot.queueRevision
            &&previous.reportSnapshot.reviewStamp===review.reviewStamp&&previous.reportSnapshot.approvalStamp===review.approvalStamp
            &&previous.reportSnapshot.asOf>captured.snapshot.asOf)return false;
        } catch(error) {
          // Reports are replaceable projections. Corrupt durable queue/review sources still fail closed.
          if(!(error instanceof SyntaxError)&&(error as NodeJS.ErrnoException).code!=="ENOENT")throw error;
        }
        for(const name of names)await renameReportFile(path.join(staging!,name),path.join(directory,name),()=>check(state));
        return true;
      });
      return {result:output.result,reportSnapshot:captured.snapshot,reportPublished};
    } catch(error) {
      if(!(error instanceof ReportSnapshotChanged)||attempt>=2)throw error;
    } finally {
      if(staging)await fs.rm(staging,{recursive:true,force:true});
    }
  }
}
