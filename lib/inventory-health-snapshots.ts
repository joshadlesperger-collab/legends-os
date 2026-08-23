import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { loadInventoryHealth } from "@/lib/inventory-health-data";

export function inventoryHealthSnapshotDate(now:Date){return new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()));}
export function buildInventoryHealthSnapshot(data:Awaited<ReturnType<typeof loadInventoryHealth>>){
  const count=(field:"velocityTrend"|"saleLikelihood",value:string)=>data.rows.filter(row=>row[field]===value).length;
  return{listingWeightedHealth:Math.round(data.portfolio.listingWeightedHealth),economicallyWeightedHealth:Math.round(data.portfolio.economicallyWeightedHealth),activeListings:data.portfolio.total,listedExposure:new Prisma.Decimal(data.portfolio.listedExposure.toFixed(2)),states:data.portfolio.states,pareto:data.portfolio.pareto,velocity:Object.fromEntries(["accelerating","healthy","flat","slowing","no_recent_sales","insufficient_history"].map(value=>[value,count("velocityTrend",value)])),saleLikelihood:Object.fromEntries(["high","moderate","low","unknown"].map(value=>[value,count("saleLikelihood",value)]))};
}
export async function ensureDailyInventoryHealthSnapshot(now=new Date()){
  const snapshotDate=inventoryHealthSnapshotDate(now);const existing=await prisma.inventoryHealthSnapshot.findUnique({where:{snapshotDate},select:{id:true}});if(existing)return{created:false,id:existing.id};
  const payload=buildInventoryHealthSnapshot(await loadInventoryHealth(now));
  try{const created=await prisma.inventoryHealthSnapshot.create({data:{snapshotDate,...payload},select:{id:true}});return{created:true,id:created.id};}catch(error){if(error instanceof Prisma.PrismaClientKnownRequestError&&error.code==="P2002"){const raced=await prisma.inventoryHealthSnapshot.findUniqueOrThrow({where:{snapshotDate},select:{id:true}});return{created:false,id:raced.id};}throw error;}
}
