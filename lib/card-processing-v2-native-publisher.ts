import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import type {Page,Locator} from 'playwright-core';
import {collectV2DraftMatchPageDOM} from './card-processing-v2-draft-match-browser.ts';

export type V2NativePublishTarget={draftId:string;sku:string;title:string;quantity:number;itemCents:number;shippingCents:number;manualItemCents?:number};
export type V2NativePublishProof={path:string;sha256:string};
export type V2NativePublishedRow={draftId:string;sku:string;title:string;itemId:string;quantity:number;itemCents:number;shippingCents:number;raw:string};
export type V2NativePublisherOptions={page:Page;evidenceDir:string;
 checkpoint:(phase:'before-price-edit'|'before-final-submit'|'publish-acknowledged'|'active-verified',details:Record<string,unknown>)=>Promise<void>;
 acceptDisplayedAgreements:(proof:V2NativePublishProof,text:string)=>Promise<boolean>};
export class V2NativePublishUncertainError extends Error{readonly draftIds:string[];readonly evidence:V2NativePublishProof|undefined;constructor(draftIds:string[],evidence:V2NativePublishProof|undefined){super('Native publication may have been submitted. Reconcile these exact drafts; automatic replay is prohibited.');this.name='V2NativePublishUncertainError';this.draftIds=draftIds;this.evidence=evidence;}}
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const ids=(targets:V2NativePublishTarget[])=>targets.map(t=>t.draftId).sort();
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const cents=(value:string,plain=false)=>{const text=value.trim();if(text==='Free')return 0;const pattern=plain?/^\d+(?:\.\d{1,2})?$/:/^(?:US\s*)?\$\s*\d[\d,]*(?:\.\d{2})?$/;if(!pattern.test(text))throw Error('An actual USD amount is required');const result=Math.round(Number(text.replace(/[^\d.]/g,''))*100);if(!Number.isSafeInteger(result)||result<0)throw Error('An actual bounded USD amount is required');return result;};
const validate=(targets:V2NativePublishTarget[])=>{if(!targets.length||targets.length>500||new Set(ids(targets)).size!==targets.length||new Set(targets.map(t=>t.sku)).size!==targets.length||targets.some(t=>!/^\d{6,25}$/.test(t.draftId)||!/^V2-[a-f0-9]{24}$/.test(t.sku)||!t.title||t.title.length>200||!Number.isSafeInteger(t.quantity)||t.quantity<1||!Number.isSafeInteger(t.itemCents)||t.itemCents<149||!Number.isSafeInteger(t.shippingCents)||t.shippingCents<0||t.manualItemCents!==undefined&&(!Number.isSafeInteger(t.manualItemCents)||t.manualItemCents<149||t.manualItemCents>100_000_000)))throw Error('Unique exact draft identities, current amounts and explicit valid manual prices are required');};

/** Browser-backed collection of visible native bulk controls. Expected values
 * never fill absent observations, and every non-price cell remains protected. */
export function collectV2NativePublishBulkDOM(table:HTMLElement|SVGElement){
 const text=(e:Element)=>(e as HTMLElement).innerText?.replace(/\s+/g,' ').trim()??e.textContent?.replace(/\s+/g,' ').trim()??'';
 const headers=Array.from(table.querySelectorAll('th,[role=columnheader]')).map(text);
 const col=(name:string)=>{const matches=headers.flatMap((h,i)=>h===name?[i]:[]);if(matches.length!==1)throw Error('One native bulk column required: '+name);return matches[0];};
 const index={title:col('Title'),sku:col('Custom label (SKU)'),quantity:col('Available quantity'),price:col('Buy It Now'),shipping:col('Shipping policy')};
 return Array.from(table.querySelectorAll('tbody tr')).flatMap(row=>{
  const draftIds=Array.from(row.querySelectorAll('input[type=checkbox]')).flatMap(e=>/^draft-checkbox-(\d+)$/.exec(e.id)?.[1]??[]);if(!draftIds.length)return[];if(draftIds.length!==1)throw Error('One native saved-draft identity per row required');
  const cells=Array.from(row.querySelectorAll('td,[role=gridcell],[role=cell]'));
  const value=(i:number)=>{const controls=Array.from(cells[i]?.querySelectorAll('input:not([type=hidden]):not([type=checkbox]),textarea,select')??[]);if(controls.length!==1)throw Error('One actual native bulk field required');return(controls[0]as HTMLInputElement).value;};
  return[{draftId:draftIds[0],sku:value(index.sku),title:value(index.title),quantity:value(index.quantity),price:value(index.price),shipping:text(cells[index.shipping]),
   protectedValues:cells.flatMap((cell,i)=>i===0||i===index.price||headers[i]==='Last modified'?[]:[{column:headers[i],text:text(cell),controls:Array.from(cell.querySelectorAll('input,textarea,select')).filter(e=>!['hidden','password'].includes((e as HTMLInputElement).type)).map(e=>{const f=e as HTMLInputElement;return{tag:e.tagName,name:f.name,value:f.value,checked:['checkbox','radio'].includes(f.type)?f.checked:undefined};}),photos:Array.from(cell.querySelectorAll('img')).map(e=>({src:e.getAttribute('src'),alt:e.getAttribute('alt')}))}])}];
 });
}

/** Only the currently visible active page is observed after a native success.
 * This is a scoped write acknowledgement, never an account-wide duplicate scan. */
export function collectV2NativePublishedActiveDOM(body:HTMLElement|SVGElement){
 const text=(e:Element)=>(e as HTMLElement).innerText?.replace(/\s+/g,' ').trim()??e.textContent?.replace(/\s+/g,' ').trim()??'';
 const table=Array.from(body.querySelectorAll('table')).find(t=>Array.from(t.querySelectorAll('th,[role=columnheader]')).some(h=>/^Current price/i.test(text(h))));if(!table)throw Error('Actual active listing acknowledgement grid required');
 const headers=Array.from(table.querySelectorAll('th,[role=columnheader]')).map(e=>text(e).replace(/\s*Sort (?:ascending|descending).*$/,''));
 const col=(pattern:RegExp)=>{const m=headers.flatMap((h,i)=>pattern.test(h)?[i]:[]);if(m.length!==1)throw Error('Actual active column unavailable');return m[0];};
 const ix={sku:col(/custom label|sku/i),price:col(/^Current price$/i),quantity:col(/^(?:Available )?quantity$/i),shipping:col(/^Shipping cost$/i)};
 const amount=(cell:Element,allowFree=false)=>{const actual=(cell as HTMLElement).innerText?.trim()??cell.textContent?.trim()??'',matches=actual.match(/(?:US\s*)?\$\s*\d[\d,]*(?:\.\d{2})?(?![\d.])/g)??[];if(allowFree&&actual==='Free')return'Free';if(matches.length!==1)throw Error('One unambiguous actual USD amount required in active price cell');return matches[0];};
 return Array.from(table.querySelectorAll('tbody tr')).flatMap(row=>{const cells=Array.from(row.querySelectorAll('td,[role=cell],[role=gridcell]'));if(!cells.length)return[];
  const links=Array.from(row.querySelectorAll('a[href]')).flatMap(e=>{try{const a=e as HTMLAnchorElement,u=new URL(a.href),m=/^\/itm\/(?:[^/]+\/)?(\d{9,15})$/.exec(u.pathname);return u.origin==='https://www.ebay.com'&&m?[{itemId:m[1],title:text(e)}]:[];}catch{return[];}});const unique=Array.from(new Map(links.map(l=>[l.itemId,l])).values());if(!unique.length)return[];if(unique.length!==1)throw Error('One active item ID per native row required');
  return[{...unique[0],sku:text(cells[ix.sku]),price:amount(cells[ix.price]),quantity:text(cells[ix.quantity]),shipping:amount(cells[ix.shipping],true),raw:row.textContent??''}];
 });
}

/** Receives an exclusively owned dedicated browser page from the local worker.
 * All mutating actions use visible native controls; no Seller Hub request replay
 * or replacement Trading listing creation exists in this transport. */
export function createV2NativePublisher(options:V2NativePublisherOptions){
 let page=options.page,busy=false;const attempted=new Set<string>();
 const retain=async(kind:string,body:unknown):Promise<V2NativePublishProof>=>{await fs.mkdir(options.evidenceDir,{recursive:true});const file=path.join(options.evidenceDir,`${Date.now()}-${randomUUID()}-${kind}.json`),bytes=JSON.stringify(body,null,2);await fs.writeFile(file,bytes,{flag:'wx',mode:0o600,flush:true});return{path:file,sha256:sha(bytes)};};
 const official=(raw:string,pathname?:string)=>{const u=new URL(raw);if(u.origin!=='https://www.ebay.com'||u.username||u.password||u.hash||pathname&&u.pathname!==pathname||/signin|auth|captcha|challenge/i.test(u.pathname))throw Error('Authenticated official native seller page required');return u;};
 const seller=async()=>{official(page.url());const body=await page.locator('body').innerText();if(!/\bimaydit58\b/i.test(body))throw Error('The dedicated browser must be signed in as imaydit58');};
 const goto=async(url:string)=>{official(url);await page.goto(url,{waitUntil:'domcontentloaded'});await seller();};
 const one=async(locator:Locator)=>{await locator.first().waitFor({state:'visible',timeout:15000});if(await locator.count()!==1)throw Error('Exactly one observed native control required');return locator;};
 async function observeSellerSession(){if(busy)throw Error('Publication browser is busy; do not navigate during an owned submission');await goto('https://www.ebay.com/sh/ovw');return{ready:true,seller:'imaydit58' as const,observedAt:new Date().toISOString()};}
 async function locatePage(targets:V2NativePublishTarget[]){
  await goto('https://www.ebay.com/sh/lst/drafts?offset=0&limit=200&sort=-buyItNow');let next=1,total:number|undefined;
  for(let n=0;n<50;n++){
   let actual:ReturnType<typeof collectV2DraftMatchPageDOM>|undefined;const deadline=Date.now()+15000;
   while(Date.now()<deadline){try{const r=await page.locator('body').evaluate(collectV2DraftMatchPageDOM);if(r.pagination?.start===next&&r.pagination.end-r.pagination.start+1===r.rows.length&&(total===undefined||total===r.pagination.total)){actual=r;break;}}catch{/* Wait only for this native page to settle. */}await page.waitForTimeout(100);}
   if(!actual||!actual.pagination)throw Error('Complete native unpublished page observation required');total=actual.pagination.total;
   const found=targets.filter(t=>actual!.rows.some(r=>r.draftId===t.draftId));
   if(found.length){for(const target of found){const row=actual.rows.find(r=>r.draftId===target.draftId)!;if(row.sku!==target.sku||row.protectedValues.title!==target.title||row.quantity!==target.quantity||row.price.currency!=='USD'||row.price.amount===null||cents(row.price.amount,true)!==target.itemCents||cents(row.protectedValues.shipping)!==target.shippingCents||row.protectedValues.format!=='Buy It Now')throw Error('Selected saved draft identity, price, shipping, quantity or format changed');}
    await retain('selected-draft-baseline',{seller:'imaydit58',source:page.url(),observedAt:new Date().toISOString(),targets:found,rows:actual.rows.filter(r=>found.some(t=>t.draftId===r.draftId))});return found.slice(0,200);
   }
   if(actual.pagination.end===total)break;next=actual.pagination.end+1;const control=await one(page.getByRole('link',{name:'Go to next page',exact:true}));const href=await control.getAttribute('href');if(!href)throw Error('Observed native next-page URL required');official(new URL(href,page.url()).href,'/sh/lst/drafts');await control.click();await page.waitForLoadState('domcontentloaded');await seller();
  }throw Error('Selected saved drafts are absent from current unpublished inventory; no replacement listing will be created');
 }
 async function openBulk(targets:V2NativePublishTarget[]){
  const checkboxes=page.getByRole('checkbox',{name:/^Select this item for performing bulk action - /});await checkboxes.evaluateAll(es=>{if(es.some(e=>(e as HTMLInputElement).checked))throw Error('Previous native draft selection must be cleared by the operator');});
  for(const t of targets)await(await one(page.locator('#shui-dt-checkone-'+t.draftId))).check();
  const selected=await checkboxes.evaluateAll(es=>es.filter(e=>(e as HTMLInputElement).checked).map(e=>e.id.replace('shui-dt-checkone-','')).sort());if(!same(selected,ids(targets)))throw Error('Only exact selected saved drafts may enter publication');
  const priorPages=new Set(page.context().pages());await(await one(page.getByRole('button',{name:'Resume drafts',exact:true}))).click();
  const deadline=Date.now()+30000;for(;;){if(Date.now()>deadline)throw Error('Native saved-draft bulk workspace did not open');
   const previous=page.getByRole('dialog',{name:'Want to complete your previous bulk edits?',exact:true});if(await previous.isVisible().catch(()=>false))throw Error('Existing unfinished bulk workspace must be preserved; finish or close that workspace before publishing');
   const candidates=page.context().pages().filter(p=>{try{return!p.isClosed()&&new URL(p.url()).origin==='https://www.ebay.com'&&new URL(p.url()).pathname==='/bulksell'&&(p===page||!priorPages.has(p));}catch{return false;}});if(candidates.length>1)throw Error('Ambiguous native bulk workspace');if(candidates.length===1){page=candidates[0];break;}await page.waitForTimeout(100);
  }
  official(page.url(),'/bulksell');const table=await one(page.getByRole('table',{name:'This grid shows the drafts you are currently editing.',exact:true}));await table.locator('tbody tr').first().waitFor({state:'visible'});return table;
 }
 function checkBulk(rows:ReturnType<typeof collectV2NativePublishBulkDOM>,targets:V2NativePublishTarget[],manual=false){if(!same(rows.map(r=>r.draftId).sort(),ids(targets)))throw Error('Exact native bulk scope differs');for(const t of targets){const r=rows.find(r=>r.draftId===t.draftId)!;if(r.sku!==t.sku||r.title!==t.title||r.quantity!==String(t.quantity)||cents(r.price,true)!==(manual?t.manualItemCents??t.itemCents:t.itemCents))throw Error('Native bulk price or protected identity/quantity differs');}}
 async function reconcile(targets:V2NativePublishTarget[]){
  validate(targets);await goto('https://www.ebay.com/sh/lst/active');const deadline=Date.now()+20000;let rows:ReturnType<typeof collectV2NativePublishedActiveDOM>=[];
  while(Date.now()<deadline){try{rows=await page.locator('body').evaluate(collectV2NativePublishedActiveDOM);if(targets.every(t=>rows.filter(r=>r.sku===t.sku).length===1))break;}catch{/* Read-only acknowledgement may still be loading. */}await page.waitForTimeout(200);}
  const selected:V2NativePublishedRow[]=targets.map(t=>{const matched=rows.filter(r=>r.sku===t.sku);if(matched.length!==1)throw Error('Exact live acknowledgement is unavailable; no automatic resubmission');const r=matched[0];if(r.title!==t.title||r.quantity!==String(t.quantity)||cents(r.price)!==(t.manualItemCents??t.itemCents)||cents(r.shipping)!==t.shippingCents)throw Error('Published price, shipping, title or quantity differs from selected request');return{draftId:t.draftId,sku:r.sku,title:r.title,itemId:r.itemId,quantity:t.quantity,itemCents:t.manualItemCents??t.itemCents,shippingCents:t.shippingCents,raw:r.raw};});
  const observedAt=new Date().toISOString(),evidence=await retain('selected-live-acknowledgement',{kind:'actual-internal-browser-seller-active-grid',seller:'imaydit58',observedAt,source:page.url(),rows:selected.map(r=>r.raw)});return{observedAt,rows:selected,evidence};
 }
 async function publish(input:{requestId:string;targets:V2NativePublishTarget[]}){
  if(busy)throw Error('Native publication browser already owned');validate(input.targets);if(!/^[a-zA-Z0-9-]{8,100}$/.test(input.requestId))throw Error('A durable exact request ID is required');busy=true;const remaining=input.targets.slice(),groups:Array<{draftIds:string[];rows:V2NativePublishedRow[];evidence:V2NativePublishProof}>=[];
  try{while(remaining.length){if(remaining.some(t=>attempted.has(input.requestId+':'+t.draftId)))throw Error('A prior native submission requires reconciliation; request replay is prohibited');const targets=await locatePage(remaining),table=await openBulk(targets),before=await table.evaluate(collectV2NativePublishBulkDOM);checkBulk(before,targets);
   for(const target of targets.filter(t=>t.manualItemCents!==undefined&&t.manualItemCents!==t.itemCents)){await options.checkpoint('before-price-edit',{requestId:input.requestId,draftId:target.draftId,itemCents:target.manualItemCents});const row=table.locator('tbody tr').filter({has:page.locator('#draft-checkbox-'+target.draftId)});await(await one(row.getByRole('textbox',{name:'Buy It Now',exact:true}))).fill((target.manualItemCents!/100).toFixed(2));await row.getByRole('textbox',{name:'Buy It Now',exact:true}).press('Tab');}
   const after=await table.evaluate(collectV2NativePublishBulkDOM);checkBulk(after,targets,true);if(after.some(r=>!same(r.protectedValues,before.find(b=>b.draftId===r.draftId)?.protectedValues)))throw Error('A non-price bulk field changed; publication prohibited');
   await retain('native-before-submit',{requestId:input.requestId,targets,before,after,workspaceUrl:page.url(),observedAt:new Date().toISOString()});
   await(await one(page.getByRole('button',{name:`Submit (${targets.length})`,exact:true}))).click();const dialog=await one(page.getByRole('dialog',{name:'Review fees',exact:true})),terms=await dialog.innerText();
   if(!new RegExp(`\\b${targets.length} listings? to submit\\b`).test(terms)||!/Estimated selling fees:\s*\$0\.00\b/.test(terms)||!/Listing fee\s*\$0\.00\b/.test(terms))throw Error('Exact selected count and zero listing fees are required');
   const agreement=await retain('native-review-fees',{requestId:input.requestId,draftIds:ids(targets),text:terms,workspaceUrl:page.url(),observedAt:new Date().toISOString()});
   if(!await options.acceptDisplayedAgreements(agreement,terms))throw Error('Displayed eBay submission agreements require explicit approval');
   await options.checkpoint('before-final-submit',{requestId:input.requestId,draftIds:ids(targets),agreement,workspaceUrl:page.url()});
   targets.forEach(t=>attempted.add(input.requestId+':'+t.draftId));
   try{await(await one(dialog.getByRole('button',{name:'Submit',exact:true}))).click();const confirmation=await one(page.getByRole('dialog',{name:'Confirmation',exact:true}));const text=await confirmation.innerText();if(!new RegExp(`\\b${targets.length} listings? (?:are|is) now live\\b`).test(text))throw Error('Exact publication count acknowledgement required');const acknowledgement=await retain('native-publish-confirmation',{requestId:input.requestId,draftIds:ids(targets),text,observedAt:new Date().toISOString()});await options.checkpoint('publish-acknowledged',{requestId:input.requestId,draftIds:ids(targets),acknowledgement});const result=await reconcile(targets);await options.checkpoint('active-verified',{requestId:input.requestId,draftIds:ids(targets),rows:result.rows,evidence:result.evidence});groups.push({draftIds:ids(targets),rows:result.rows,evidence:result.evidence});for(const target of targets)remaining.splice(remaining.findIndex(t=>t.draftId===target.draftId),1);
   }catch(error){if(error instanceof V2NativePublishUncertainError)throw error;throw new V2NativePublishUncertainError(ids(targets),agreement);}
  }return{requestId:input.requestId,seller:'imaydit58' as const,groups,rows:groups.flatMap(g=>g.rows),completedAt:new Date().toISOString()};}finally{busy=false;}
 }
 return{observeSellerSession,publish,reconcile:async(targets:V2NativePublishTarget[])=>{if(busy)throw Error('Publication browser is busy; reconcile only after the owned submission ends');return reconcile(targets);}};
}

