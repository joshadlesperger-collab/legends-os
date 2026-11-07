import {prisma} from "./prisma.ts";
import {summarizeLearningEvidence,baselineExecutionPolicy} from "./learning-evidence.ts";
export type {LearningActionSummary} from "./learning-evidence.ts";
export async function buildLearningSummary(now=new Date()){
 const since=new Date(now.getTime()-90*86_400_000);
 const observations=await prisma.outcomeObservation.findMany({where:{observedAt:{gte:since}},select:{decisionId:true,windowDays:true,observedAt:true,saleOccurred:true,viewsChange:true,watchersChange:true,decision:{select:{recommendedAction:true,doctrineVersion:true}}}});
 return{generatedAt:now.toISOString(),windowDays:90,summaries:summarizeLearningEvidence(observations)};
}
export async function deriveAdaptiveExecutionPolicy(now=new Date()){return baselineExecutionPolicy(now.toISOString());}
