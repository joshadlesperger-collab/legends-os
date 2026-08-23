import {loadEnvConfig} from "@next/env";
loadEnvConfig(process.cwd(),true);
import {loadSellActionCenter} from "../lib/sell-action-center.ts";
import {prisma} from "../lib/prisma.ts";
async function main() {
const data=await loadSellActionCenter();
const status=Object.fromEntries(["EXECUTABLE","EXECUTABLE WITH APPROVAL","REVIEW","BLOCKED","COMPLETED"].map(value=>[value,data.rows.filter(row=>row.status===value).length]));
const confidence=Object.fromEntries(["HIGH","MEDIUM","LOW"].map(value=>[value,data.rows.filter(row=>row.confidenceBand===value).length]));
console.log(JSON.stringify({generatedAt:data.generatedAt,total:data.rows.length-data.recentlyCompleted,counts:data.counts,status,confidence,conflicts:data.conflicts,executable:data.rows.filter(row=>row.status==="EXECUTABLE"||row.status==="EXECUTABLE WITH APPROVAL").map(row=>({itemId:row.itemId,action:row.actionType,title:row.title})),offers:data.rows.filter(row=>row.actionType==="SEND OFFER"&&row.status!=="COMPLETED").map(row=>({itemId:row.itemId,title:row.title,currentPrice:row.currentPrice,status:row.status,warning:row.warning,offer:row.offer})),blockedReasons:Object.entries(data.rows.filter(row=>row.status==="BLOCKED").reduce<Record<string,number>>((map,row)=>{map[row.warning]=(map[row.warning]??0)+1;return map;},{})).sort((a,b)=>b[1]-a[1]),probes:data.probes,top50:data.rows.filter(row=>row.status!=="COMPLETED").slice(0,50).map(row=>({itemId:row.itemId,title:row.title,price:row.currentPrice,action:row.actionType,confidence:row.confidence,status:row.status,source:row.source,reason:row.reason,alternatives:row.alternatives.map(item=>`${item.actionType} (${item.source})`)}))},null,2));
await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exitCode = 1;
});
