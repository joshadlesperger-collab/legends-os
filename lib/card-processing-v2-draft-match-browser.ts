import{digest}from'./card-processing-v2.ts';
import type{Locator,Page}from'playwright-core';
import type{V2MergeDraft,V2MergeEvidence}from'./card-processing-v2-draft-merge-plan.ts';
export type V2DraftQuantityTarget={draftId:string;sku:string;expectedQuantity:number;targetQuantity:number;expectedProtectedHash:string;sourcePageUrl?:string};
const sha=digest;
export const draftMatchProtectedHash=(row:Pick<V2MergeDraft,'protectedValues'>)=>sha(row.protectedValues);
/** Visible drafts-list fields only. No active item links or hidden editor data. */
export function collectV2DraftMatchPageDOM(body:HTMLElement|SVGElement){
 const text=(e:Element)=>(e as HTMLElement).innerText?.replace(/\s+/g,' ').trim()??e.textContent?.replace(/\s+/g,' ').trim()??'';
 const tables=Array.from(body.querySelectorAll('table,[role=table]'));
 const table=tables.find(t=>Array.from(t.querySelectorAll('th,[role=columnheader]')).some(h=>/custom label|sku/i.test(text(h))));
 // Native pagination can change before the old tbody is replaced. A visible
 // loading signal is never evidence that the next page's rows have arrived.
 const visible=(e:Element)=>{const r=e.getBoundingClientRect(),style=getComputedStyle(e);return r.width>0&&r.height>0&&style.display!=='none'&&style.visibility!=='hidden';};
 if(Array.from(body.querySelectorAll('[aria-busy="true"],[role="progressbar"]')).some(visible))throw Error('Draft list is still loading');
 const empty=/No (?:drafts|listings|results)|You (?:don't|do not) have any drafts/i.test(text(body));
 const m=/(\d+)\s*[–—-]\s*(\d+)\s+of\s+([\d,]+)/i.exec(text(body));
 const pagination=m?{start:Number(m[1]),end:Number(m[2]),total:Number(m[3].replaceAll(',',''))}:null;
 if(!table){if(empty)return{rows:[],pagination,empty:true};throw Error('Actual draft list table unavailable');}
 const headers=Array.from(table.querySelectorAll('th,[role=columnheader]')).map(h=>text(h).replace(/\s+Sort (?:ascending|descending)$/i,''));
 const col=(pattern:RegExp)=>{const matches=headers.flatMap((h,n)=>pattern.test(h)?[n]:[]);if(matches.length!==1)throw Error('One actual draft column required: '+pattern.source);return matches[0];};
 const optionalCol=(pattern:RegExp)=>{const matches=headers.flatMap((h,n)=>pattern.test(h)?[n]:[]);if(matches.length>1)throw Error('Ambiguous actual draft price column');return matches[0]??-1;};
 const index={title:col(/^Title$/i),sku:col(/custom label|sku/i),quantity:col(/^(?:available )?quantity$/i),price:optionalCol(/^(?:Buy It Now(?: price)?|Price)$/i),startPrice:optionalCol(/^(?:Start(?:ing)? price|Starting bid)$/i),format:col(/^Format$/i),duration:col(/^Duration$/i),shipping:col(/^(?:Shipping|Shipping cost|Shipping policy)$/i)};
 if(index.price<0&&index.startPrice<0)throw Error('Actual saved draft price columns unavailable');
 const rows=Array.from(table.querySelectorAll('tbody tr,[role=row]')).flatMap(tr=>{
  const cells=Array.from(tr.querySelectorAll('td,[role=cell]'));if(!cells.length)return[];
  const links=Array.from(tr.querySelectorAll('a[href]')).flatMap(a=>{try{const u=new URL((a as HTMLAnchorElement).href);if(u.origin!=='https://www.ebay.com'||!['/lstng','/sl/list','/sl/sell'].includes(u.pathname))return[];const ids=['draftId','draft_id'].flatMap(k=>u.searchParams.getAll(k));return ids.length===1&&/^\d+$/.test(ids[0])?[{id:ids[0],url:u.href}]:[];}catch{return[];}});
  const ids=Array.from(new Set(links.map(l=>l.id)));if(!ids.length)return[];if(ids.length!==1)throw Error('Ambiguous draft list identity');
  const value=(n:number)=>{if(!cells[n])throw Error('Draft list cell unavailable');const control=cells[n].querySelector('input:not([type=hidden]):not([type=checkbox]),textarea');return control?(control as HTMLInputElement).value.trim():text(cells[n]);};
  const quantity=value(index.quantity);if(!/^[1-9]\d*$/.test(quantity)||!Number.isSafeInteger(Number(quantity)))throw Error('Actual saved draft quantity unavailable');
  const money=(rawPrice:string)=>{if(rawPrice===''||rawPrice==='-')return null;if(!/^(?:US\s*)?\$\s*\d[\d,]*(?:\.\d{2})?$/.test(rawPrice))throw Error('Actual USD draft price unavailable');return Number(rawPrice.replace(/[^\d.]/g,'')).toFixed(2);};
  const buyItNow=index.price<0?null:money(value(index.price)),startPrice=index.startPrice<0?null:money(value(index.startPrice)),amount=buyItNow??startPrice;
  if(/auction/i.test(value(index.format))&&index.startPrice<0)throw Error('Auction starting price column unavailable');
  const protectedValues={title:value(index.title),sku:value(index.sku),price:amount??'',buyItNowPrice:buyItNow??'',startingPrice:startPrice??'',currency:'USD',format:value(index.format),duration:value(index.duration),shipping:value(index.shipping)};
  if(!protectedValues.title)throw Error('Actual draft title unavailable');
  return[{draftId:ids[0],sku:protectedValues.sku,quantity:Number(quantity),price:{amount,currency:'USD'},protectedValues,url:links[0].url}];
 });
 if(new Set(rows.map(r=>r.draftId)).size!==rows.length)throw Error('Duplicate draft list row');
 return{rows,pagination,empty:rows.length===0&&empty};
}
/** Every visible bulk field is protected while native quantity controls change. */
export function collectV2DraftQuantityBulkDOM(table:HTMLElement|SVGElement){
 const headers=Array.from(table.querySelectorAll('th')).map(e=>(e as HTMLElement).innerText.trim());
 const q=headers.findIndex(h=>h==='Available quantity');if(q<0)throw Error('Actual Available quantity column required');
 return Array.from(table.querySelectorAll('tbody tr')).flatMap(tr=>{const ids=Array.from(tr.querySelectorAll('input[type=checkbox]')).flatMap(e=>/^draft-checkbox-(\d+)$/.exec(e.id)?.[1]??[]);if(!ids.length)return[];if(ids.length!==1)throw Error('Exact bulk draft identity required');const cells=Array.from(tr.querySelectorAll('td'));const controls=(e:Element)=>Array.from(e.querySelectorAll('input:not([type=checkbox]):not([type=hidden]),textarea,select')).map(e=>({name:(e as HTMLInputElement).name,value:(e as HTMLInputElement).value}));const qc=controls(cells[q]);if(qc.length!==1||!/^\d+$/.test(qc[0].value))throw Error('Actual bulk quantity required');return[{draftId:ids[0],quantity:Number(qc[0].value),protectedValues:cells.flatMap((cell,n)=>n===q?[]:[{column:headers[n]??String(n),text:(cell as HTMLElement).innerText.replace(/\s+/g,' ').trim(),controls:controls(cell)}])}];});
}
/** Only native noneditable modification timestamps are presentation metadata.
 * Every control and every other column remains byte-for-byte protected. */
export function sameV2DraftQuantityProtected(before:Array<{column:string;text:string;controls:unknown[]}>,after:Array<{column:string;text:string;controls:unknown[]}>){
 const values=(rows:typeof before)=>rows.filter(c=>!(['Last modified','Last updated date'].includes(c.column)&&c.controls.length===0));
 return digest(values(before))===digest(values(after));
}
export function collectV2DraftQuantityNativeDOM(body:HTMLElement|SVGElement){const allowed=new Set(['title','customLabel','quantity','price','itemPrice','shippingPolicyId','returnPolicyId','paymentPolicyId','condition','40001','categoryId','description','scheduleListingSelection']);return Array.from(body.querySelectorAll('input,textarea,select')).filter(e=>{const f=e as HTMLInputElement;return!['hidden','password'].includes(f.type)&&(allowed.has(f.name)||f.name.startsWith('attributes.'));}).map(e=>{const f=e as HTMLInputElement;return{name:f.name,value:f.value,...(['radio','checkbox'].includes(f.type)?{checked:f.checked}:{})};});}
type Deps={page:()=>Page;goto:(url:string)=>Promise<unknown>;seller:()=>Promise<unknown>;open:(targets:Array<{draftId:string;sku:string}>,sourcePageUrl?:string,beforeSelect?:()=>Promise<void>)=>Promise<{table:Locator}>;retain:(kind:string,body:unknown)=>Promise<V2MergeEvidence>;checkpoint:(step:string)=>Promise<void>};
const listURL=(raw:string)=>{const u=new URL(raw);if(u.origin!=='https://www.ebay.com'||u.pathname!=='/sh/lst/drafts'||u.username||u.password||u.hash)throw Error('Exact draft-only source page required');return u.href;};
const sourcePage=(t:V2DraftQuantityTarget)=>listURL(t.sourcePageUrl??'https://www.ebay.com/sh/lst/drafts');
const valid=(targets:V2DraftQuantityTarget[])=>{if(!targets.length||targets.length>20||new Set(targets.map(t=>t.draftId)).size!==targets.length||targets.some(t=>!/^\d+$/.test(t.draftId)||!t.sku||!Number.isSafeInteger(t.expectedQuantity)||t.expectedQuantity<1||!Number.isSafeInteger(t.targetQuantity)||t.targetQuantity<t.expectedQuantity||!/^[a-f0-9]{64}$/.test(t.expectedProtectedHash)))throw Error('Exact monotonic fixed draft quantity targets required');targets.forEach(sourcePage);};
export function createV2DraftMatchBrowser(deps:Deps){
 async function captureDraftMatchSnapshot(){
  // This exact native sort URL is retained from eBay's own draft-list control.
  // Button names describe the NEXT action, so toggling two labels can race two sorts.
  await deps.goto('https://www.ebay.com/sh/lst/drafts?action=sort&sort=-lastUpdatedDate');
  const pages=[],rows:Array<V2MergeDraft&{sourcePageUrl:string}>=[],seen=new Set<string>();let nextStart=1,total:number|undefined;
  for(let n=0;n<100;n++){
   await deps.checkpoint('Reading current unpublished draft page only');const page=deps.page();let actual:ReturnType<typeof collectV2DraftMatchPageDOM>|undefined,stable:string|undefined;const readyUntil=Date.now()+15000;
   while(Date.now()<readyUntil){try{
    const source=new URL(listURL(page.url()));if(source.searchParams.get('sort')!=='-lastUpdatedDate')throw Error('Native newest-first draft sort changed');
    const observed=await page.locator('body').evaluate(collectV2DraftMatchPageDOM),p=observed.pagination;
    const fresh=observed.empty&&n===0||!!p&&p.start===nextStart&&p.end-p.start+1===observed.rows.length&&(total===undefined||p.total===total)&&observed.rows.every(row=>!seen.has(row.draftId));
    const signature=fresh?sha(observed):undefined;
    if(signature&&signature===stable){actual=observed;break;}stable=signature;
   }catch{stable=undefined;/* Wait for this pending DOM only; never rescan or navigate again. */}await new Promise(r=>setTimeout(r,150));}
   if(!actual)throw Error('Pending draft page did not expose fresh contiguous rows in the native newest-first sort');const sourcePageUrl=listURL(page.url());
   if(actual.empty&&n===0){total=0;}else{const p=actual.pagination;if(!p||p.start!==nextStart||p.end-p.start+1!==actual.rows.length||total!==undefined&&p.total!==total)throw Error('Complete contiguous current draft pagination required');total=p.total;nextStart=p.end+1;}
   const evidence=await deps.retain('draft-match-page',{scope:'drafts',seller:'imaydit58',observedAt:new Date().toISOString(),sourcePageUrl,...actual});pages.push(evidence);actual.rows.forEach(row=>seen.add(row.draftId));rows.push(...actual.rows.map(r=>({...r,protectedValues:{...r.protectedValues},evidence,sourcePageUrl})));
   if(total===0||nextStart===total!+1){if(new Set(rows.map(r=>r.draftId)).size!==rows.length)throw Error('Current draft snapshot repeats IDs');const body={scope:'drafts' as const,seller:'imaydit58' as const,complete:true as const,observedAt:new Date().toISOString(),rows,pages};return{...body,evidence:await deps.retain('draft-match-snapshot',body)};}
   const next=page.getByRole('button',{name:/^(?:Go to )?Next(?: page)?(?: of results)?$/i}).or(page.getByRole('link',{name:/^(?:Go to )?Next(?: page)?(?: of results)?$/i}));if(await next.count()!==1||!await next.isEnabled())throw Error('Actual draft next page unavailable');await next.click();await page.waitForLoadState('domcontentloaded');await deps.seller();
  }throw Error('Current draft snapshot exceeds bounded pagination');
 }
 async function targetedRows(targets:V2DraftQuantityTarget[]){
  valid(targets);const observedByUrl=new Map<string,ReturnType<typeof collectV2DraftMatchPageDOM>>(),nextVisited=new Map<string,string>();const found=new Map<string,ReturnType<typeof collectV2DraftMatchPageDOM>['rows'][number]>(),visited=new Set<string>(),pages:Array<{url:string;pagination:unknown;targetDraftIds:string[];visibleRows:number}>=[];
  const collect=async(expectedStart?:number)=>{let actual:ReturnType<typeof collectV2DraftMatchPageDOM>|undefined,stable:string|undefined;const deadline=Date.now()+15000;
   while(Date.now()<deadline){try{const observed=await deps.page().locator('body').evaluate(collectV2DraftMatchPageDOM),signature=expectedStart!==undefined&&observed.pagination?.start!==expectedStart?undefined:sha(observed);if(signature&&signature===stable){actual=observed;break;}stable=signature;}catch{stable=undefined;}await new Promise(r=>setTimeout(r,150));}
   if(!actual)throw Error('Targeted draft page did not expose stable nonbusy rows');
   const url=listURL(deps.page().url());visited.add(url);observedByUrl.set(url,actual);const selected=actual.rows.filter(r=>targets.some(t=>t.draftId===r.draftId));pages.push({url,pagination:actual.pagination,targetDraftIds:selected.map(r=>r.draftId),visibleRows:actual.rows.length});
   for(const row of selected){const prior=found.get(row.draftId);if(prior&&sha(prior)!==sha(row))throw Error('Conflicting target rows across saved list acknowledgement');found.set(row.draftId,row);}return actual;
  };
  const first='https://www.ebay.com/sh/lst/drafts?action=sort&sort=-lastUpdatedDate',bases=Array.from(new Set([first,...targets.map(sourcePage)]));
  for(const base of bases){if(found.size===targets.length)break;let hops=0,actual:ReturnType<typeof collectV2DraftMatchPageDOM>;
   if(visited.has(base)){let current=base;while(hops<2&&nextVisited.has(current)){current=nextVisited.get(current)!;hops++;}if(current!==deps.page().url())continue;actual=observedByUrl.get(current)!;}
   else{await deps.goto(base);const offset=new URL(base).searchParams.get('offset');actual=await collect(offset&&/^\d+$/.test(offset)?Number(offset)+1:1);}
   for(let n=hops;n<2&&found.size<targets.length;n++){
    const page=deps.page(),next=page.getByRole('button',{name:/^(?:Go to )?Next(?: page)?(?: of results)?$/i}).or(page.getByRole('link',{name:/^(?:Go to )?Next(?: page)?(?: of results)?$/i}));if(await next.count()!==1||!await next.isEnabled())break;
    const href=await next.getAttribute('href');if(href){const destination=listURL(new URL(href,page.url()).href);if(visited.has(destination))break;}
    const previous=listURL(page.url()),expected=actual.pagination?actual.pagination.end+1:undefined;await next.click();await page.waitForURL(u=>u.href!==previous,{timeout:15000});await page.waitForLoadState('domcontentloaded');await deps.seller();if(visited.has(listURL(page.url())))break;actual=await collect(expected);nextVisited.set(previous,listURL(page.url()));
   }
  }
  const rows=Array.from(found.values()),page=deps.page();
  if(rows.length!==targets.length){await deps.retain('draft-quantity-list-missing',{kind:'draft-quantity-list-missing',seller:'imaydit58',targets,rows,pages,sourcePages:Array.from(visited),observedAt:new Date().toISOString(),verified:false,catalogComplete:false,maxNextNeighborsPerBase:2,sellerWrites:0,published:false});throw Error('Exact saved quantity targets not present in bounded known-page acknowledgement');}
  for(const t of targets){const r=rows.find(r=>r.draftId===t.draftId)!;if(r.sku!==t.sku||r.quantity!==t.targetQuantity||draftMatchProtectedHash(r)!==t.expectedProtectedHash){await deps.retain('draft-quantity-list-mismatch',{kind:'draft-quantity-list-mismatch',seller:'imaydit58',targets,rows,pages,sourcePages:Array.from(visited),url:page.url(),observedAt:new Date().toISOString(),verified:false,sellerWrites:0,published:false});throw Error('Saved quantity or protected list values differ');}}
  const body={kind:'saved-draft-quantity-list-ack' as const,seller:'imaydit58',observedAt:new Date().toISOString(),url:page.url(),sourcePages:Array.from(visited),rows,priceWrites:0,published:false},evidence=await deps.retain('draft-quantity-list-ack',body);return{...body,rows:rows.map(r=>({...r,protectedHash:draftMatchProtectedHash(r),evidence})),evidence};
 }
 async function saveDraftQuantities(input:{operationId:string;targets:V2DraftQuantityTarget[]}){
  const {targets,operationId}=input;valid(targets);if(!operationId||new Set(targets.map(sourcePage)).size!==1)throw Error('One retained draft page and durable operation ID required');
  const baseline=async()=>{const actual=await deps.page().locator('body').evaluate(collectV2DraftMatchPageDOM);for(const t of targets){const r=actual.rows.find(r=>r.draftId===t.draftId);if(!r||r.sku!==t.sku||r.quantity!==t.expectedQuantity||draftMatchProtectedHash(r)!==t.expectedProtectedHash)throw Error('Draft list baseline changed; quantity save prohibited');}};
  if(targets.length===1){
   const t=targets[0];await deps.goto(sourcePage(t));await baseline();await deps.goto(`https://www.ebay.com/lstng?draftId=${t.draftId}&mode=AddItem`);const page=deps.page(),quantity=page.locator('input[name="quantity"]');await quantity.waitFor({state:'visible'});if(await page.locator('input[name="customLabel"]').inputValue()!==t.sku||await quantity.inputValue()!==String(t.expectedQuantity))throw Error('Exact singleton quantity baseline changed');const before=await page.locator('body').evaluate(collectV2DraftQuantityNativeDOM);await quantity.fill(String(t.targetQuantity));await quantity.press('Tab');const after=await page.locator('body').evaluate(collectV2DraftQuantityNativeDOM);if(after.filter(f=>f.name==='quantity').length!==1||after.find(f=>f.name==='quantity')?.value!==String(t.targetQuantity)||sha(before.filter(f=>f.name!=='quantity'))!==sha(after.filter(f=>f.name!=='quantity')))throw Error('Protected native fields changed; save prohibited');await deps.retain('draft-quantity-save-requested',{operationId,targets,before,observedAt:new Date().toISOString(),mode:'singleton-native-editor',priceWrites:0,canPublish:false});await page.getByRole('button',{name:'Save for later',exact:true}).click();await page.waitForLoadState('domcontentloaded');return targetedRows(targets);
  }
  const {table}=await deps.open(targets,sourcePage(targets[0]),baseline),page=deps.page(),before=await table.evaluate(collectV2DraftQuantityBulkDOM);
  if(before.length!==targets.length||before.some(r=>!targets.some(t=>t.draftId===r.draftId&&t.expectedQuantity===r.quantity)))throw Error('Quantity baseline changed before write');
  const proof=await deps.retain('draft-quantity-before',{operationId,targets,rows:before,observedAt:new Date().toISOString()});
  for(const quantity of Array.from(new Set(targets.map(t=>t.targetQuantity)))){
   const all=table.getByRole('checkbox',{name:'Select all items for bulk edit.',exact:true});await all.check();await all.uncheck();for(const t of targets.filter(t=>t.targetQuantity===quantity))await table.locator('#draft-checkbox-'+t.draftId).check();
   await page.getByRole('button',{name:'Bulk edit',exact:true}).click();await page.getByRole('menu').getByText('Available quantity',{exact:true}).click();const dialog=page.getByRole('dialog',{name:'Available quantity',exact:true});await dialog.getByRole('radio',{name:'Change to',exact:true}).check();await dialog.getByRole('textbox',{name:'Amount',exact:true}).fill(String(quantity));await dialog.getByRole('button',{name:'Apply',exact:true}).click();await dialog.waitFor({state:'hidden'});
  }
  const after=await table.evaluate(collectV2DraftQuantityBulkDOM);if(after.length!==before.length||after.some(r=>{const b=before.find(b=>b.draftId===r.draftId),t=targets.find(t=>t.draftId===r.draftId);return!b||!t||r.quantity!==t.targetQuantity||!sameV2DraftQuantityProtected(b.protectedValues,r.protectedValues);})){
   await deps.retain('draft-quantity-protected-difference',{kind:'draft-quantity-protected-difference',operationId,targets,before:proof,beforeRows:before,afterRows:after,observedAt:new Date().toISOString(),mode:'native-bulk-editor',stage:'before-save',saveAttempted:false,priceWrites:0,canPublish:false});
   throw Error('Protected bulk fields changed; save prohibited');
  }
  await deps.retain('draft-quantity-save-requested',{operationId,targets,before:proof,observedAt:new Date().toISOString(),canPublish:false,priceWrites:0});await page.getByRole('button',{name:'Save for later',exact:true}).click();await page.waitForLoadState('domcontentloaded');return targetedRows(targets);
 }
 return{captureDraftMatchSnapshot,saveDraftQuantities,reconcileDraftQuantities:(input:{targets:V2DraftQuantityTarget[]})=>targetedRows(input.targets)};
}
