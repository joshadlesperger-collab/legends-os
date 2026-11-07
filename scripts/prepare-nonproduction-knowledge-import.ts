import {readFileSync,mkdirSync,writeFileSync} from "node:fs";
import {createHash,randomUUID} from "node:crypto";
import {validateCatalog} from "../lib/card-knowledge.ts";
import {catalogDigest,prepareLegacyImport,reconcileLegacyEntries} from "../lib/card-knowledge-import.ts";

// Preparation only: intentionally never constructs a Prisma client or reads credentials.
const sourcePaths=["data/card-catalog/topps-chrome-basketball-2025-26.json","artifacts/knowledge-graph/recovered-records.json",
  "prisma/schema.prisma","artifacts/knowledge-graph/enrichment-isolated-20261025.json","artifacts/knowledge-graph/blank-variant-split-plan.json"];
const inputs=sourcePaths.map(path=>({path,bytes:readFileSync(path)}));
const digest=(bytes:Buffer)=>createHash("sha256").update(bytes).digest("hex");
const catalog=validateCatalog(JSON.parse(inputs[0].bytes.toString("utf8")));
const legacy=prepareLegacyImport(JSON.parse(inputs[1].bytes.toString("utf8")));
const links=reconcileLegacyEntries(catalog,JSON.parse(inputs[1].bytes.toString("utf8")));
const isolated=JSON.parse(inputs[3].bytes.toString("utf8")),split=JSON.parse(inputs[4].bytes.toString("utf8"));
for(const input of inputs)if(digest(readFileSync(input.path))!==digest(input.bytes))throw Error("Source changed while preparing import");
const directory=`artifacts/knowledge-graph/nonproduction-import-${randomUUID()}`;
mkdirSync(directory);
writeFileSync(`${directory}/catalog.json`,inputs[0].bytes,{flag:"wx"});
writeFileSync(`${directory}/recovered-records.json`,inputs[1].bytes,{flag:"wx"});
writeFileSync(`${directory}/checklist-link-proposals.json`,JSON.stringify(links,null,2),{flag:"wx"});
const plan={preparedAt:new Date().toISOString(),target:{environment:"non-production",designation:null,connectionVerified:false,schemaVerified:false},
  sourceBindings:inputs.map(({path,bytes})=>({path,sha256:digest(bytes)})),
  catalog:{digest:catalogDigest(catalog),entries:catalog.cards.length,product:catalog.product.id},
  legacy:{importId:legacy.importId,records:legacy.records.length,counts:legacy.counts},
  supportedImport:[{function:"importCardCatalog",module:"lib/card-knowledge-import.ts",input:`${directory}/catalog.json`},
    {function:"importLegacyKnowledge",module:"lib/card-knowledge-import.ts",input:`${directory}/recovered-records.json`}],
  transactions:"Serializable; catalog changes refuse overwrite; identical catalog/legacy imports are idempotent. Catalog and legacy imports are separate resumable transactions.",
  excluded:{reviewedEnrichmentCandidates:isolated.reviewCandidates?.length??null,blankVariantSplitPlan:"Retain proposal only; shared blank variant must not be filled. No supported semantic-apply path verified.",splitPlanKeys:Object.keys(split)},
  executionGates:["User designates non-production target and configures access without sharing secrets in chat","Verify target identity and existing required Knowledge schema read-only; missing schema remains a separate migration decision","Recheck packet SHA-256 bindings and review exact import counts","Obtain explicit permission for actual database import; preparation is not import authorization"],
  validationAfterAuthorizedImport:["Read back catalog digest, entry count and legacy import counts","Replay identical inputs and verify unchanged results","Verify existing unrelated rows and physical inventory remain unchanged"],
  databaseCalls:0,databaseApplied:false,migrationRun:false,physicalInventoryChanged:false,pricingRulesChanged:false};
writeFileSync(`${directory}/plan.json`,JSON.stringify(plan,null,2),{flag:"wx"});
console.log(JSON.stringify({directory,...plan},null,2));
