import { readFile, writeFile, mkdir, readdir, rename } from "node:fs/promises";
import { createHash } from "node:crypto";
import { validateCatalog } from "../lib/card-knowledge.ts";
import { reviewCompsApiPilot } from "../lib/compsapi-pilot.ts";
import { addMarketIndexObservation, summarizeMarketIndex } from "../lib/market-collection.ts";
import type { MarketIndexEntry } from "../lib/market-collection.ts";

const root = "artifacts/knowledge-graph", dir = `${root}/compsapi-collection`;
const request = {q:"2025 topps chrome basketball",size:"240",days:"365",site:"US",best_offer:"1",cards:"1"};
const target = 10000, maxPages = 50, budget = 98, spacingMs = 7000;
const hash = (s:string) => createHash("sha256").update(s).digest("hex");
const signature = hash(JSON.stringify(request));
const atomic = async (path:string, value:unknown) => { await writeFile(`${path}.tmp`,JSON.stringify(value,null,2)); await rename(`${path}.tmp`,path); };
type Page = {page:number; providerPage?:number; request:typeof request & {start?:string;end?:string}; fetchedAt:string; fetchSeconds:number; rawPath:string; digest:string; nextPage:boolean; returnedRows:number};
type State = {signature:string; startedAt:string; attempts:number; nextPage:number; pages:Page[]; inFlight:number|null; lastRequestAt:number; status:string; lastHttpStatus?:number; consecutiveFailures?:number; paginationMode?:"pages"|"date-windows";windowEnd?:string;partialDayWindows?:string[]};
const previousDay=(date:string)=>new Date(Date.parse(`${date}T00:00:00Z`)-86400000).toISOString().slice(0,10);
async function main() {
  await mkdir(`${dir}/pages`,{recursive:true});
  const catalog = validateCatalog(JSON.parse(await readFile("data/card-catalog/topps-chrome-basketball-2025-26.json","utf8")));
  const index = new Map<string,MarketIndexEntry>();
  const savedPath = `${root}/saved-pages-index.json`;
  const saved = JSON.parse(await readFile(savedPath,"utf8")) as {rows:{observations:{itemId:string;title:string;flags:string[];sourceSha256:string}[]}[]};
  for (const row of saved.rows) for (const obs of row.observations) addMarketIndexObservation(index,{...obs,sourceRef:`${savedPath}#${obs.itemId}:${obs.sourceSha256}`},catalog);
  for (const name of (await readdir(root)).filter(n=>n.startsWith("compsapi-") && n!=="compsapi-collection")) {
    const path = `${root}/${name}/report.json`;
    let previous:{rows:{item_id:string;title:string;flags:string[]}[]};
    try { previous=JSON.parse(await readFile(path,"utf8")); } catch(e) { if((e as NodeJS.ErrnoException).code==="ENOENT")continue;throw e; }
    for(const row of previous.rows) addMarketIndexObservation(index,{itemId:row.item_id,title:row.title,flags:row.flags,sourceRef:`${path}#${row.item_id}`},catalog);
  }
  const baselineIds = new Set(index.keys()), baselineCount = index.size;
  let state:State;
  try { state=JSON.parse(await readFile(`${dir}/checkpoint.json`,"utf8")); }
  catch(e) { if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e; state={signature,startedAt:new Date().toISOString(),attempts:0,nextPage:1,pages:[],inFlight:null,lastRequestAt:0,status:"prepared"}; }
  if(state.signature!==signature)throw Error("Request differs from checkpoint");
  const ingest = async (page:Page) => {
    const body=await readFile(page.rawPath,"utf8");
    if(hash(body)!==page.digest)throw Error("Saved response checksum mismatch");
    const parsed=JSON.parse(body);
    if(parsed.page !== undefined && Number(parsed.page)!==(page.providerPage??page.page))throw Error("Response page mismatch");
    const report=reviewCompsApiPilot(parsed,catalog,new Set(),new Set(index.keys()));
    if(report.summary.malformedRows)throw Error("Malformed rows need review before continuing");
    for(const row of report.rows) addMarketIndexObservation(index,{itemId:row.item_id,title:row.title,flags:row.flags,sourceRef:`${page.rawPath}#${row.item_id}`},catalog);
    await atomic(`${dir}/pages/page-${page.page}-review.json`,report);
    return report.summary;
  };
  for(const page of state.pages)await ingest(page);
  // Workbook titles are constructed descriptions, not original eBay titles.
  // Preserve the complete source packet and never replace an existing title.
  const workbookDir = `${root}/workbook-sources`;
  let workbookFiles: string[] = [];
  try { workbookFiles = await readdir(workbookDir); }
  catch(e) { if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e; }
  let workbookNewListings = 0;
  for (const name of workbookFiles.filter(n=>/^[a-f0-9]{64}\.json$/.test(n)).sort()) {
    const path = `${workbookDir}/${name}`;
    const packet = JSON.parse(await readFile(path,"utf8"));
    if(packet.sourceSha256 !== name.slice(0,-5))throw Error("Workbook source hash mismatch");
    for(const row of packet.rows) {
      const itemId = String(row.ebay_item_id);
      if(row.listing_url !== `https://www.ebay.com/itm/${itemId}`)throw Error("Workbook listing identity mismatch");
      const existing = index.get(itemId);
      const flags = ["workbook_clector_source", "source_title_constructed", "source_date_approximate", "shipping_unknown", "sale_type_unknown", "condition_not_verified", "parallel_not_verified", "own_purchase_not_checked"];
      if(row.best_offer_status === "accepted")flags.push("accepted_price_unknown");
      if(addMarketIndexObservation(index,{itemId,title:existing?.title ?? row.full_title,flags,sourceRef:`${path}#${itemId}`},catalog))workbookNewListings++;
    }
  }
  if(state.status==="date-boundary-needs-review" && state.windowEnd && state.pages.length) {
    const last=state.pages[state.pages.length-1];
    const body=JSON.parse(await readFile(last.rawPath,"utf8"));
    const dates=body.items.map((r:{last_sold?:string})=>r.last_sold?.slice(0,10)).filter((d:unknown)=>typeof d==="string" && /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
    if(dates[0]!==state.windowEnd)throw Error("Unexpected date boundary; do not skip");
    state.partialDayWindows=Array.from(new Set([...(state.partialDayWindows??[]),state.windowEnd]));
    state.windowEnd=previousDay(state.windowEnd);state.status="ready";
  }
  // Recover a completed disk receipt without repeating an uncertain network request.
  if(state.inFlight!==null && state.lastHttpStatus===503 && state.status==="request-stopped-check-response") {
    if((state.consecutiveFailures??0)>=3 && !state.paginationMode && state.pages.length) {
      const last=JSON.parse(await readFile(state.pages[state.pages.length-1].rawPath,"utf8"));
      const dates=last.items.map((r:{last_sold?:string})=>r.last_sold?.slice(0,10)).filter((d:unknown)=>typeof d==="string" && /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
      if(!dates.length)throw Error("No reliable date cursor");
      state.paginationMode="date-windows";state.windowEnd=dates[0];state.consecutiveFailures=0;
    } else if((state.consecutiveFailures??0)>=3)throw Error("Repeated provider failure; no more automatic retries");
    state.inFlight=null;state.status="ready";
  }
  if(state.inFlight!==null) {
    let receipt:Page;
    try { receipt=JSON.parse(await readFile(`${dir}/pages/page-${state.inFlight}-receipt.json`,"utf8")); }
    catch { throw Error("Interrupted request has no receipt; check quota before retrying"); }
    if(receipt.page!==state.inFlight)throw Error("Receipt page mismatch");
    await ingest(receipt);state.pages.push(receipt);state.nextPage=receipt.page+1;state.inFlight=null;
    state.status=receipt.nextPage?"ready":"search-exhausted";
  }
  const save = async () => {
    const summary={...summarizeMarketIndex(index),target,baselineUniqueListings:baselineCount,newUniqueListings:index.size-baselineCount,workbookNewListings,
      pagesFetched:state.pages.length,requestsAttempted:state.attempts,quotaBudget:budget,status:state.status,
      paginationMode:state.paginationMode??"pages",partialDayWindows:state.partialDayWindows??[],completeMarketCoverage:false,
      fetchSeconds:Number(state.pages.reduce((n,p)=>n+p.fetchSeconds,0).toFixed(3)),startedAt:state.startedAt,updatedAt:new Date().toISOString()};
    await atomic(`${dir}/index.json`,{summary,rows:Array.from(index.values()).map(row=>({...row,newInCollection:!baselineIds.has(row.itemId)}))});
    await atomic(`${dir}/checkpoint.json`,state);
    return summary;
  };
  if(process.argv.includes("--report-only")){ console.log(JSON.stringify(await save()));return; }
  if(index.size>=target){state.status="target-reached";console.log(JSON.stringify(await save()));return;}
  if(!process.argv.includes("--confirmed-free-tier"))throw Error("Confirm free plan before collection");
  const key=process.env.COMPSAPI_API_KEY?.trim()||(await readFile(".env.compsapi-key","utf8")).trim();
  if(!key || /\s/.test(key))throw Error("Key unavailable");
  const get = async (url:URL) => {
    const res=await fetch(url,{headers:{"X-API-Key":key,"User-Agent":"LegendsOS-market-collection/1.0"},signal:AbortSignal.timeout(60000),redirect:"error"});
    if(!res.ok)throw Error(`CompsAPI HTTP ${res.status}`);
    const body=await res.text();if(body.includes(key))throw Error("Credential in response");return body;
  };
  const usage=JSON.parse(await get(new URL("https://api.compsapi.com/v1/usage")));
  if(usage.ok===false)throw Error("Usage unavailable");
  let emptyNewPages=0;
  while(index.size<target && state.nextPage<=(state.paginationMode==="date-windows"?budget:maxPages) && state.attempts<budget && state.status!=="search-exhausted") {
    const delay=Math.max(0,spacingMs-(Date.now()-state.lastRequestAt));
    if(delay)await new Promise(resolve=>setTimeout(resolve,delay));
    state.inFlight=state.nextPage;state.attempts++;state.lastRequestAt=Date.now();state.status="requesting";delete state.lastHttpStatus;await save();
    const page=state.nextPage,providerPage=state.paginationMode==="date-windows"?1:page;
    const pageRequest:Page["request"]={...request};
    if(state.paginationMode==="date-windows") {
      pageRequest.start=new Date(new Date(state.startedAt).getTime()-365*86400000).toISOString().slice(0,10);
      pageRequest.end=state.windowEnd;
    }
    const url=new URL("https://api.compsapi.com/v1/sold");url.search=new URLSearchParams({...pageRequest,page:String(providerPage)} as Record<string,string>).toString();
    const started=performance.now();let body:string;
    try {body=await get(url);}catch(e){
      state.status="request-stopped-check-response";
      const status=e instanceof Error ? /^CompsAPI HTTP (\d+)$/.exec(e.message) : null;
      if(status)state.lastHttpStatus=Number(status[1]);
      state.consecutiveFailures=(state.consecutiveFailures??0)+1;
      await save();
      if(state.lastHttpStatus===503 && state.consecutiveFailures<3) {
        state.inFlight=null;state.status="ready";await save();
        console.log(JSON.stringify({page,status:"temporary-503",retry:state.consecutiveFailures}));
        await new Promise(resolve=>setTimeout(resolve,15000));continue;
      }
      throw e;
    }
    const digest=hash(body),rawPath=`${dir}/pages/page-${page}-${digest}.json`;
    await writeFile(rawPath,body);
    const parsed=JSON.parse(body);
    if(parsed.ok!==true || !Array.isArray(parsed.items) || typeof parsed.next_page!=="boolean") {state.status="invalid-response";await save();throw Error("Invalid response");}
    const receipt:Page={page,providerPage,request:pageRequest,fetchedAt:new Date().toISOString(),fetchSeconds:Number(((performance.now()-started)/1000).toFixed(3)),rawPath,digest,nextPage:parsed.next_page,returnedRows:parsed.items.length};
    await atomic(`${dir}/pages/page-${page}-receipt.json`,receipt);
    const summary=await ingest(receipt);state.pages.push(receipt);state.nextPage=page+1;state.inFlight=null;state.consecutiveFailures=0;
    state.status=receipt.nextPage?"ready":"search-exhausted";
    if(state.paginationMode==="date-windows" && receipt.nextPage) {
      const dates=parsed.items.map((r:{last_sold?:string})=>r.last_sold?.slice(0,10)).filter((d:unknown)=>typeof d==="string" && /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
      if(!dates.length || dates[0]>state.windowEnd!)state.status="date-boundary-needs-review";
      else if(dates[0]===state.windowEnd) {
        const boundary=state.windowEnd!;
        state.partialDayWindows=Array.from(new Set([...(state.partialDayWindows??[]),boundary]));
        state.windowEnd=previousDay(boundary);
      } else state.windowEnd=dates[0];
    }
    emptyNewPages=summary.newListings?0:emptyNewPages+1;
    if(emptyNewPages>=3)state.status="no-new-listings-review-needed";
    await save();console.log(JSON.stringify({page,returned:summary.returnedRows,newListings:summary.newListings,totalUnique:index.size,seconds:receipt.fetchSeconds,status:state.status}));
    if(emptyNewPages>=3 || state.status==="date-boundary-needs-review")break;
  }
  if(index.size>=target)state.status="target-reached";
  else if(state.nextPage>(state.paginationMode==="date-windows"?budget:maxPages))state.status="free-page-limit";
  else if(state.attempts>=budget)state.status="free-request-budget";
  console.log(JSON.stringify(await save()));
}
main().catch(e=>{const msg=e instanceof Error && /^CompsAPI HTTP \d+$/.test(e.message)?e.message:"Collection stopped; inspect checkpoint and saved responses before retrying. No credentials logged.";console.error(msg);process.exitCode=1;});
