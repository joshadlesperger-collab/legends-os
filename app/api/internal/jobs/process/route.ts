import { NextRequest, NextResponse } from "next/server";
import { processAvailableJobs } from "@/lib/sync-jobs";
import { ensureDailyInventoryHealthSnapshot } from "@/lib/inventory-health-snapshots";
import { observeDueOperatorOutcomes } from "@/lib/action-outcomes";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let healthSnapshot:{created:boolean;id:string}|{error:true};
  try{healthSnapshot=await ensureDailyInventoryHealthSnapshot();}catch(error){console.error("Inventory Health snapshot failed",error);healthSnapshot={error:true};}
  let actionOutcomes:{observed:number}|{error:true};
  try{actionOutcomes=await observeDueOperatorOutcomes();}catch(error){console.error("Operator outcome observation failed",error);actionOutcomes={error:true};}
  const results = await processAvailableJobs(1);
  return NextResponse.json({ processed: results.length, results, healthSnapshot, actionOutcomes });
}
