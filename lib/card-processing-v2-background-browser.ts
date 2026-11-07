import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {chromium,type BrowserContext,type Page,type Locator,type FileChooser} from 'playwright-core';
import {assertV2DraftOnlyCsv} from './card-processing-v2-uploader.ts';
import type {V2BrowserJob} from './card-processing-v2-browser-upload-workflow.ts';
import type {V2BatchRowObservation} from './card-processing-v2-batch-observation.ts';
import{V2PartialSavedBatchReadError}from'./card-processing-v2-partial-batch-read.ts';
import{V2BulkMembershipNotReadyError,withV2FreshBulkMembershipRetry}from'./card-processing-v2-bulk-membership-retry.ts';
import{createV2DraftMatchBrowser}from'./card-processing-v2-draft-match-browser.ts';

export type V2BackgroundEvidence={path:string;sha256:string};
export class V2BackgroundBrowserError extends Error {
 readonly code:'SIGN_IN_REQUIRED'|'VERIFICATION_REQUIRED'|'UNSUPPORTED_PAGE'|'AGREEMENT_REQUIRED'|'UPLOAD_UNCERTAIN'|'BROWSER_BUSY';
 constructor(code:'SIGN_IN_REQUIRED'|'VERIFICATION_REQUIRED'|'UNSUPPORTED_PAGE'|'AGREEMENT_REQUIRED'|'UPLOAD_UNCERTAIN'|'BROWSER_BUSY',message:string){super(message);this.code=code;this.name='V2BackgroundBrowserError';}
}
const sha=(b:string|Uint8Array)=>createHash('sha256').update(b).digest('hex');
/** Seller Hub stamps uploaded filenames. Match the exact frozen stem and the
 * observed timestamp/request-ID suffix, never a substring or another batch. */
export function v2BackgroundUploadRowPattern(filename:string){
 if(path.basename(filename)!==filename||!filename.toLowerCase().endsWith('.csv'))throw Error('Exact CSV basename required');
 const escaped=filename.slice(0,-4).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
 return new RegExp('(?:^|\\s)'+escaped+'(?:\\.csv|-[A-Za-z]{3}-\\d{4}(?:-\\d{2}){4}-\\d+\\.csv)(?=\\s|$)','i');
}

const strictUrl=(value:string)=>{const u=new URL(value);if(u.protocol!=='https:'||u.hostname!=='www.ebay.com'||u.port||u.username||u.password)throw new V2BackgroundBrowserError('UNSUPPORTED_PAGE','Only the observed eBay seller UI is supported');return u;};
export function exactV2BackgroundDraftId(value:string){const u=strictUrl(value),ids=['draftId','draft_id'].flatMap(k=>u.searchParams.getAll(k));if(!['/lstng','/sl/list','/sl/sell'].includes(u.pathname)||ids.length!==1||!/^\d+$/.test(ids[0]))throw new V2BackgroundBrowserError('UNSUPPORTED_PAGE','Exactly one saved draft ID is required');return ids[0];}
export type V2BackgroundOptions={root:string;profileDir:string;evidenceDir:string;headless?:boolean;minimized?:boolean;executablePath?:string;channel?:'msedge'|'chrome';
 /** The application's retained seller authorization is evaluated against the
  * actual displayed terms. An absent callback never implies consent. */
 acceptDisplayedAgreements?:(evidence:V2BackgroundEvidence,text:string)=>Promise<boolean>;
 checkpoint?:(step:string)=>Promise<void>;measure?:<T>(step:string,operation:()=>Promise<T>)=>Promise<T>;};
export type V2BackgroundDefaults={payment:{id:string;label:string};returns:{id:string;label:string};location:{postalCode:string;city:string;country:string};evidence:V2BackgroundEvidence};

/** Await the real editor's asynchronous dropdown rendering. Policy names bind
 * to the exact ID; eBay's observed listing-count suffix is display-only. */
export async function chooseV2BackgroundOption(page:Page,label:RegExp,value:string|RegExp){
 const control=page.getByRole('combobox',{name:label}).or(page.getByRole('button',{name:label}));
 await control.first().waitFor({state:'visible',timeout:12000}).catch(()=>{throw new V2BackgroundBrowserError('UNSUPPORTED_PAGE','Required first-save control did not appear');});
 if(await control.count()!==1)throw new V2BackgroundBrowserError('UNSUPPORTED_PAGE','Exactly one first-save control required');
 const expected=typeof value==='string'?new RegExp('^'+value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'(?: (?:\\[[\\d,]+ listings?\\]|\\([\\d,]+ listings?\\)))?$'):value;
 if(await control.evaluate(e=>e.tagName)==='SELECT'){
  const options=await control.locator('option').evaluateAll(nodes=>nodes.map(e=>({label:e.textContent?.trim()??'',value:(e as HTMLOptionElement).value}))),matches=options.filter(o=>expected.test(o.label));
  if(matches.length!==1)throw new V2BackgroundBrowserError('UNSUPPORTED_PAGE','Exactly one first-save option required');await control.selectOption(matches[0].value);return;
 }
 await control.click();const option=page.getByRole('option',{name:expected}).or(page.getByRole('menuitem',{name:expected}));
 await option.first().waitFor({state:'visible',timeout:12000}).catch(()=>{throw new V2BackgroundBrowserError('UNSUPPORTED_PAGE','Required first-save option did not appear');});
 if(await option.count()!==1)throw new V2BackgroundBrowserError('UNSUPPORTED_PAGE','Exactly one first-save option required');await option.click();
}

/** A dedicated app-owned browser. Never connects to a personal browser, imports
 * cookies or calls an undocumented eBay endpoint. All seller effects below are
 * limited to choosing one already-frozen Draft CSV in Seller Hub. */
export async function createV2BackgroundBrowser(options:V2BackgroundOptions){
 const root=path.resolve(options.root),profile=path.resolve(options.profileDir),evidence=path.resolve(options.evidenceDir),artifacts=path.join(root,'artifacts');
 for(const target of [profile,evidence]){const rel=path.relative(artifacts,target);if(!rel||rel.startsWith('..')||path.isAbsolute(rel))throw Error('Dedicated browser data must remain in operational artifacts');await fs.mkdir(target,{recursive:true});if((await fs.lstat(target)).isSymbolicLink())throw Error('Dedicated browser directory cannot be a symbolic link');}
 let context:BrowserContext;
 try{context=await chromium.launchPersistentContext(profile,{headless:options.headless!==false,...(options.executablePath?{executablePath:options.executablePath}:{channel:options.channel??'msedge'}),acceptDownloads:true,...(options.minimized?{args:['--start-minimized']}:{}),viewport:{width:1365,height:1000},timeout:30000});}
 catch{throw new V2BackgroundBrowserError('BROWSER_BUSY','Dedicated browser could not start. Close its existing setup window or resolve the owned profile; no seller action was attempted.');}
 let page=context.pages()[0]??await context.newPage();page.setDefaultTimeout(12000);page.setDefaultNavigationTimeout(30000);
 let busy=false;
 async function exclusive<T>(run:()=>Promise<T>){if(busy)throw new V2BackgroundBrowserError('BROWSER_BUSY','Another operation owns this dedicated browser');busy=true;try{return await run();}finally{busy=false;}}
 async function retain(label:string,value:unknown):Promise<V2BackgroundEvidence>{const filename=path.join(evidence,`${Date.now()}-${randomUUID()}-${label}.json`),bytes=JSON.stringify(value,null,2);await fs.writeFile(filename,bytes,{flag:'wx',mode:0o600,flush:true});return{path:path.relative(root,filename).replaceAll('\\','/'),sha256:sha(bytes)};}
 async function checkpoint(step:string){await options.checkpoint?.(step);}
 async function measured<T>(step:string,operation:()=>Promise<T>):Promise<T>{return options.measure?options.measure(step,operation):operation();}
 async function requireSeller(){const url=new URL(page.url());if(/captcha|challenge/i.test(url.pathname))throw new V2BackgroundBrowserError('VERIFICATION_REQUIRED','Complete the eBay verification in the dedicated browser; no automatic challenge handling');if(url.hostname!=='www.ebay.com'||/signin|auth|captcha|challenge/i.test(url.pathname))throw new V2BackgroundBrowserError('SIGN_IN_REQUIRED','Sign in to eBay in the dedicated Legends OS browser');await page.getByText(/\bimaydit58\b/i).first().waitFor({state:'visible',timeout:6000}).catch(()=>undefined);const text=await page.locator('body').innerText({timeout:12000});if(!/\bimaydit58\b/i.test(text))throw new V2BackgroundBrowserError('SIGN_IN_REQUIRED','The dedicated browser has no observed imaydit58 seller session');return text;}
 async function gotoSeller(url:string){strictUrl(url);await checkpoint('Opening seller page');return measured('browser-navigation',async()=>{await page.goto(url,{waitUntil:'domcontentloaded'});return requireSeller();});}
 function uploadRows(filename:string){return page.getByRole('row').filter({has:page.locator('td,[role=gridcell],[role=cell]').filter({hasText:v2BackgroundUploadRowPattern(filename)})});}
 async function one(locator:Locator,purpose:string){await locator.first().waitFor({state:'visible',timeout:12000}).catch(()=>{throw new V2BackgroundBrowserError('UNSUPPORTED_PAGE',`Required ${purpose} control did not become visible`);});if(await locator.count()!==1)throw new V2BackgroundBrowserError('UNSUPPORTED_PAGE',`A single observed ${purpose} control is required`);return locator;}
 async function openImportedDraftBatchWorkspace(targets:Array<{draftId:string;sku:string}>,sourcePageUrl='https://www.ebay.com/sh/lst/drafts',beforeSelect?:()=>Promise<void>){
  const visible=async(locator:Locator)=>{await locator.first().waitFor({state:'visible',timeout:15000});return one(locator,'exact batch workspace');};
  const click=async(locator:Locator)=>{await(await visible(locator)).click();};
   if(strictUrl(sourcePageUrl).pathname!=='/sh/lst/drafts')throw Error('Exact draft-only source page required');await checkpoint('Opening one shared editor for the exact imported draft batch');await gotoSeller(sourcePageUrl);await beforeSelect?.();
   const all=page.getByRole('checkbox',{name:'Select all items for performing bulk action',exact:true});await(await visible(all)).check();await all.uncheck();
   // Seller sort preferences can put new unpriced drafts on a later page.
   // Use the actual native date sort once, instead of waiting on missing rows
   // or opening each listing. This reads drafts only and never changes a draft.
   if((await Promise.all(targets.map(t=>page.locator(`a[href*="${t.draftId}"]`).count()))).some(n=>n===0)){
    const ascending=page.getByRole('button',{name:'Last updated date Sort ascending',exact:true});
    const descending=page.getByRole('button',{name:'Last updated date Sort descending',exact:true});
    if(await ascending.count()===1){await ascending.click();await descending.waitFor({state:'visible',timeout:12000});}
    if(await descending.count()!==1)throw new V2BackgroundBrowserError('UNSUPPORTED_PAGE','Native newest-first draft sort is unavailable; preserve exact imported IDs');
    await descending.click();
    await page.getByRole('row').filter({has:page.locator(`a[href*="${targets[0].draftId}"]`)}).waitFor({state:'visible',timeout:12000});
    await checkpoint('Located exact imported drafts using native newest-first sort; no active inventory search');
   }
   for(const target of targets){const row=page.getByRole('row').filter({has:page.locator(`a[href*="${target.draftId}"]`)});await row.waitFor({state:'visible',timeout:12000});if(await row.count()!==1)throw new V2BackgroundBrowserError('UNSUPPORTED_PAGE','Exactly one imported draft row required');const links=await row.locator('a[href]').evaluateAll(es=>es.map(e=>(e as HTMLAnchorElement).href)),ids=links.flatMap(h=>{try{const u=new URL(h);return['draftId','draft_id'].flatMap(k=>u.searchParams.getAll(k));}catch{return[];}});if(!ids.includes(target.draftId))throw Error('Exact imported draft row binding changed');await(await visible(row.getByRole('checkbox'))).check();}
   const selected=await page.getByRole('checkbox',{name:/^Select this item for performing bulk action - /}).evaluateAll(es=>es.filter(e=>(e as HTMLInputElement).checked).length);if(selected!==targets.length)throw Error('Only exact imported draft rows may enter shared editing');
   const previous=page,beforePages=new Set(context.pages());await click(page.getByRole('button',{name:'Resume drafts',exact:true}));
   let workspace:Page|undefined,continuedNewSelection=false;const deadline=Date.now()+30000;
   while(Date.now()<deadline){
    const prior=previous.getByRole('dialog',{name:'Want to complete your previous bulk edits?',exact:true});
    if(!continuedNewSelection&&await prior.isVisible().catch(()=>false)){
     await retain('previous-bulk-workspace-choice',{targets,observedAt:new Date().toISOString(),dialog:await prior.innerText(),choice:'Continue with these new listings; do not finish or save previous edits',canPublish:false});
     await(await one(prior.getByRole('button',{name:'Continue',exact:true}),'continue exact new draft selection')).click();continuedNewSelection=true;
    }
    const candidates=context.pages().filter(candidate=>{try{return !candidate.isClosed()&&new URL(candidate.url()).origin==='https://www.ebay.com'&&new URL(candidate.url()).pathname==='/bulksell'&&(candidate===previous||!beforePages.has(candidate));}catch{return false;}});if(candidates.length>1)throw new V2BackgroundBrowserError('UNSUPPORTED_PAGE','Ambiguous shared draft workspace');if(candidates.length===1){workspace=candidates[0];break;}await new Promise(r=>setTimeout(r,150));}
   if(!workspace)throw new V2BackgroundBrowserError('UNSUPPORTED_PAGE','Native shared draft editor is unavailable; no per-card fallback is allowed');page=workspace;page.setDefaultTimeout(12000);await page.getByRole('button',{name:'Bulk edit',exact:true}).waitFor({state:'visible',timeout:30000});
   const table=await visible(page.getByRole('table',{name:'This grid shows the drafts you are currently editing.',exact:true})),expectedSkus=targets.map(t=>t.sku).sort();
   await checkpoint('Waiting for the exact saved batch rows to finish loading');
   await measured('browser-bulk-grid-ready-wait',async()=>{
    const until=Date.now()+15000;let actualSkus:string[]=[];
    while(Date.now()<until){actualSkus=await table.getByRole('textbox',{name:'Custom label (SKU)',exact:true}).evaluateAll(es=>es.map(e=>(e as HTMLInputElement).value));if(JSON.stringify([...actualSkus].sort())===JSON.stringify(expectedSkus))return;await new Promise(r=>setTimeout(r,150));}
    const diagnostic=await retain('batch-membership-not-ready',{targets,workspaceUrl:page.url(),actualSkus,observedAt:new Date().toISOString(),sellerWrites:0});throw new V2BulkMembershipNotReadyError(diagnostic);
   });

  return{table,expectedSkus};
 }
 async function status(){return exclusive(async()=>{try{const text=await gotoSeller('https://www.ebay.com/sh/reports/uploads'),proof=await retain('browser-ready',{kind:'actual-dedicated-browser-uploader-ready',seller:'imaydit58',observedAt:new Date().toISOString(),url:page.url(),text:text.slice(0,100000)});return{ready:true,seller:'imaydit58',driver:'dedicated-local-browser' as const,evidence:proof};}catch(error){if(error instanceof V2BackgroundBrowserError&&['SIGN_IN_REQUIRED','VERIFICATION_REQUIRED'].includes(error.code)){const u=new URL(page.url()),evidence=await retain('sign-in-diagnostic',{kind:'dedicated-browser-sign-in-diagnostic',observedAt:new Date().toISOString(),origin:u.origin,pathname:u.pathname,title:await page.title(),passwordFormPresent:await page.locator('input[type=password]').count()>0,credentialValuesRead:false});return{ready:false,seller:null,driver:'dedicated-local-browser' as const,reason:error.code,evidence};}throw error;}});}
 /** Setup polling never navigates, focuses inputs or reads credential values.
  * The seller can finish the ordinary dedicated-browser sign-in uninterrupted. */
 async function observeSignIn(){return exclusive(async()=>{
  let reason:'SIGN_IN_REQUIRED'|'VERIFICATION_REQUIRED'='SIGN_IN_REQUIRED';const observed:Page[]=[];
  for(const candidate of context.pages().slice(0,8)){if(candidate.isClosed())continue;const u=new URL(candidate.url());if(/captcha|challenge/i.test(u.pathname)){reason='VERIFICATION_REQUIRED';continue;}if(u.protocol!=='https:'||u.hostname!=='www.ebay.com'||/signin|auth/i.test(u.pathname)||!['/','/sh/','/mys/'].some(prefix=>prefix==='/'?u.pathname==='/':u.pathname.startsWith(prefix))||await candidate.locator('input[type="password"]').count()>0)continue;const text=await candidate.locator('body').innerText({timeout:1000}).catch(()=>'');if(/\bimaydit58\b/i.test(text))observed.push(candidate);}
  const found=observed.includes(page)?page:observed.length===1?observed[0]:undefined;if(!found)return{ready:false,seller:null,driver:'dedicated-local-browser' as const,reason};page=found;page.setDefaultTimeout(12000);page.setDefaultNavigationTimeout(30000);
  const evidence=await retain('browser-sign-in-observed',{kind:'actual-dedicated-browser-seller-observed',seller:'imaydit58',observedAt:new Date().toISOString(),url:page.url(),sellerObserved:true,credentialValuesRead:false});return{ready:true,seller:'imaydit58',driver:'dedicated-local-browser' as const,evidence};
 });}
 async function uploadDraftCsv(handoff:{absoluteCsvPath:string;job:V2BrowserJob;csv?:string}){return exclusive(async()=>{
  const file=path.resolve(handoff.absoluteCsvPath),relative=path.relative(artifacts,file);if(!relative||relative.startsWith('..')||path.isAbsolute(relative)||!handoff.job.csvSha256||handoff.job.stage!=='upload-requested')throw Error('Exact write-ahead frozen upload checkpoint required');const bytes=await fs.readFile(file);if(sha(bytes)!==handoff.job.csvSha256)throw Error('Frozen Draft CSV changed');assertV2DraftOnlyCsv(bytes.toString('utf8'));
  const filename=path.basename(file);let input:FileChooser|undefined;
  for(let attempt=0;attempt<2;attempt++){
   try{
    await gotoSeller('https://www.ebay.com/sh/reports/uploads');
    const prior=await uploadRows(filename).count();if(prior)throw new V2BackgroundBrowserError('UPLOAD_UNCERTAIN','This exact filename already appears in Seller Hub. Reconcile its result; no second upload was attempted.');
    await (await one(page.getByRole('button',{name:/^Upload(?: file| template)?$/i}),'Upload file')).click();
    const dialog=page.getByRole('dialog').or(page.locator('[aria-labelledby="uploadDialog"]:visible'));const d=await one(dialog,'Upload file dialog'),terms=await d.innerText();
    const displayed=await retain('displayed-upload-terms',{kind:'actual-dedicated-browser-upload-dialog',seller:'imaydit58',url:page.url(),observedAt:new Date().toISOString(),jobId:handoff.job.id,filename,csvSha256:handoff.job.csvSha256,text:terms});
    if(/User Agreement|Terms of (?:Use|Service)|agree to/i.test(terms)&&!await options.acceptDisplayedAgreements?.(displayed,terms))throw new V2BackgroundBrowserError('AGREEMENT_REQUIRED','The displayed eBay upload agreements require the application seller authorization');
    const chooser=page.waitForEvent('filechooser',{timeout:12000});void chooser.catch(()=>undefined);await (await one(d.getByRole('button',{name:/^Choose file$/i}),'Choose file')).click();input=await chooser;break;
   }catch(error){
    const retryable=error instanceof V2BackgroundBrowserError&&error.code==='UNSUPPORTED_PAGE'||error instanceof Error&&error.name==='TimeoutError';
    await retain('upload-pre-submit-failure',{jobId:handoff.job.id,filename,csvSha256:handoff.job.csvSha256,observedAt:new Date().toISOString(),attempt,fileSetCalls:0,source:'driver control flow before the single input.setFiles call',retryable,retryScheduled:retryable&&attempt===0,code:error instanceof V2BackgroundBrowserError?error.code:'CONTROL_TIMEOUT',detail:error instanceof V2BackgroundBrowserError?error.message:undefined});
    if(!retryable||attempt===1)throw error;
    await checkpoint('Recovering the upload controls before any file submission');
   }
  }
  if(!input)throw Error('No file chooser is ready; no file was submitted');
  await checkpoint('Submitting exact frozen Draft CSV');await retain('upload-effect-started',{jobId:handoff.job.id,filename,sha256:handoff.job.csvSha256,observedAt:new Date().toISOString(),canPublish:false});
  const selectedInput=input;
  try{await measured('browser-file-submit',()=>selectedInput.setFiles(file));return await collectUploadResult(filename,handoff.job.id);}catch(error){await retain('upload-uncertain',{jobId:handoff.job.id,filename,at:new Date().toISOString(),reason:'Upload or result read was interrupted; reconcile exact existing filename, never upload again'});if(error instanceof V2BackgroundBrowserError)throw error;throw new V2BackgroundBrowserError('UPLOAD_UNCERTAIN','The exact upload outcome is unresolved; retained evidence prohibits upload replay');}
 });}
 async function collectUploadResult(filename:string,localJobId:string){
  const deadline=Date.now()+180000;let row:Locator|undefined,jobId='';
  await measured('browser-remote-processing-wait',async()=>{while(Date.now()<deadline){await checkpoint('Waiting for the same eBay upload result');const rows=uploadRows(filename);if(await rows.count()>1)throw new V2BackgroundBrowserError('UPLOAD_UNCERTAIN','Multiple exact upload rows require reconciliation');if(await rows.count()===1){row=rows;const actual=await row.evaluate(collectUploadRow);jobId=actual.jobId;if(!actual.status)throw new V2BackgroundBrowserError('UNSUPPORTED_PAGE','The actual upload status column is unavailable');if(/\b(?:Completed|Failed|Failure|Error)\b/i.test(actual.status)&&jobId)break;}await new Promise(r=>setTimeout(r,1500));await page.reload({waitUntil:'domcontentloaded'});await requireSeller();}});
  if(!row||!jobId||Date.now()>=deadline)throw new V2BackgroundBrowserError('UPLOAD_UNCERTAIN','eBay import did not complete inside the bounded deadline; resume result collection without reuploading');
  const observedAt=new Date().toISOString();await retain('upload-completed-row',{localJobId,observedAt,url:page.url(),row:await row.evaluate(collectUploadRow)});
  let downloadControl=row.getByRole('link',{name:/^Download (?:results?|report)$/i});
  if(await downloadControl.count()!==1){
   const menu=await one(row.getByRole('button',{name:/^(?:Complete listings|Download(?: results?| report)?|More actions|Actions)$/i}),'same-upload results action');
   const opensMenu=await menu.getAttribute('aria-controls')!==null||await menu.getAttribute('aria-haspopup')!==null||await menu.getAttribute('aria-expanded')!==null||/Complete listings|More actions|^Actions$/i.test(await menu.innerText());
   if(opensMenu){await menu.click();downloadControl=row.getByRole('link',{name:/^Download (?:results?|report)$/i}).or(row.getByRole('menuitem',{name:/^Download (?:results?|report)$/i}));await downloadControl.first().waitFor({state:'visible',timeout:12000});}
   else downloadControl=menu;
  }
  return measured('browser-result-download',async()=>{const target=await one(downloadControl,'same-row Download results'),pending=page.waitForEvent('download',{timeout:30000});await target.click();const download=await pending,result=path.join(evidence,`${localJobId}-${jobId}-${randomUUID()}-official-result.csv`);if(await download.failure())throw new V2BackgroundBrowserError('UPLOAD_UNCERTAIN','Official result download failed');await download.saveAs(result);const reportBytes=await fs.readFile(result);if(!reportBytes.length||reportBytes.length>16_000_000)throw Error('Official result exceeds supported bounds');await checkpoint('Retained official same-upload draft result');return{kind:'observed-seller-hub-draft-import',seller:'imaydit58',observedAt:new Date().toISOString(),jobId,report:{path:path.relative(root,result).replaceAll('\\','/'),sha256:sha(reportBytes)}};});
 }
 /** Post-save table evidence only. Hidden specifics/photos/description are not observed. */
 async function readSavedSingleDraftRow(input:{target:{draftId:string;sku:string}}){return exclusive(()=>measured('browser-saved-singleton-list-row',async()=>{
  const {target}=input;if(!/^\d+$/.test(target.draftId)||!target.sku)throw Error('One exact singleton draft required');
  await gotoSeller('https://www.ebay.com/sh/lst/drafts');
  let row=page.getByRole('row').filter({has:page.locator(`a[href*="${target.draftId}"]`)});
  if(await row.count()===0){
   const ascending=page.getByRole('button',{name:'Last updated date Sort ascending',exact:true}),descending=page.getByRole('button',{name:'Last updated date Sort descending',exact:true});
   if(await ascending.count()===1){await ascending.click();await descending.waitFor({state:'visible',timeout:12000});}
   if(await descending.count()!==1)throw Error('Native newest-first draft sort unavailable');await descending.click();
  }
  await row.waitFor({state:'visible',timeout:12000});
  if(await row.count()!==1)throw Error('One exact saved singleton row required');
  const actual=await page.locator('body').evaluate(collectV2BackgroundInventoryDOM),observed=projectV2SavedSingletonRow(actual.rows,target);
  const body={kind:'saved-singleton-draft-list-row' as const,workspaceUrl:page.url(),observedAt:new Date().toISOString(),rows:[observed],listingNavigations:0,rowFieldDialogs:0,sellerWrites:0};
  return{...body,evidence:await retain('saved-singleton-list-row',body)};
 }));}
 async function readSavedDraftGrid(input:{targets:Array<{draftId:string;sku:string}>}){return exclusive(()=>measured('browser-saved-grid-readback',async()=>{
  const {targets}=input;
  if(targets.length<1||targets.length>20||new Set(targets.map(t=>t.draftId)).size!==targets.length||new Set(targets.map(t=>t.sku)).size!==targets.length||targets.some(t=>!/^\d+$/.test(t.draftId)||!t.sku))throw Error('Exact unique saved draft grid targets required');
  const {table}=await withV2FreshBulkMembershipRetry(()=>openImportedDraftBatchWorkspace(targets),async error=>{await retain('saved-grid-fresh-workspace-retry',{targets,observedAt:new Date().toISOString(),originalDiagnostic:error.evidence,reason:'Observed workspace membership not ready; one fresh read-only workspace attempt',retry:1,sellerWrites:0,uploadWrites:0,rowFieldDialogs:0});}),workspaceUrl=page.url();
  await checkpoint('Reading one post-save bulk table; no per-row field dialogs');
  await(await one(page.getByRole('button',{name:'Customize columns',exact:true}),'Customize columns')).click();
  const columns=page.getByRole('dialog',{name:'Customize columns',exact:true});
  for(const name of ['Payment policy','Return policy'])await columns.getByRole('checkbox',{name,exact:true}).check();
  await columns.getByRole('button',{name:'Apply',exact:true}).click();await columns.waitFor({state:'hidden'});
  const rows=await table.evaluate(collectV2BackgroundSavedBulkGridDOM);
  if(rows.length!==targets.length||new Set(rows.map(r=>r.draftId)).size!==rows.length||new Set(rows.map(r=>r.sku)).size!==rows.length||rows.some(r=>!targets.some(t=>t.draftId===r.draftId&&t.sku===r.sku)))throw Error('Actual saved grid DraftID/SKU membership differs');
  const body={kind:'saved-bulk-grid' as const,workspaceUrl,observedAt:new Date().toISOString(),rows,listingNavigations:0,rowFieldDialogs:0,sellerWrites:0};
  return{...body,evidence:await retain('saved-grid-only',body)};
 }));}
 async function readSavedDraftBatch(input:{targets:Array<{draftId:string;sku:string}>}){return exclusive(()=>measured('browser-saved-batch-readback',async()=>{
  const {targets}=input;
  if(targets.length<1||targets.length>20||new Set(targets.map(t=>t.draftId)).size!==targets.length||new Set(targets.map(t=>t.sku)).size!==targets.length||targets.some(t=>!/^\d+$/.test(t.draftId)||!t.sku))throw Error('Exact unique saved draft batch required');
  const {table}=await openImportedDraftBatchWorkspace(targets);
  const workspaceUrl=page.url();
  await checkpoint('Reading saved draft values in one batch workspace; no individual listing pages');
  await(await one(page.getByRole('button',{name:'Customize columns',exact:true}),'Customize columns')).click();
  const columns=page.getByRole('dialog',{name:'Customize columns',exact:true});
  for(const name of ['Payment policy','Return policy'])await columns.getByRole('checkbox',{name,exact:true}).check();
  await columns.getByRole('button',{name:'Apply',exact:true}).click();await columns.waitFor({state:'hidden'});
  const grid=await table.evaluate(collectV2BackgroundSavedBulkGridDOM);
  if(grid.length!==targets.length||grid.some(r=>!targets.some(t=>t.draftId===r.draftId&&t.sku===r.sku)))throw Error('Actual saved batch DraftID/SKU membership differs');
  const gridEvidence=await retain('saved-batch-grid',{kind:'saved-bulk-grid',workspaceUrl,observedAt:new Date().toISOString(),rows:grid,listingNavigations:0});
  const protectedBeforeValues=await table.evaluate(collectV2BackgroundBulkProtectedDOM,targets.map(t=>t.sku)),protectedBefore=sha(JSON.stringify(protectedBeforeValues));
  await table.getByRole('checkbox',{name:'Select all items for bulk edit.',exact:true}).check();
  await page.getByRole('button',{name:'Bulk edit',exact:true}).click();
  await page.getByRole('menuitem',{name:'Item location',exact:true}).click();
  const locationDialog=page.getByRole('dialog',{name:'Item location',exact:true});await locationDialog.waitFor({state:'visible'});
  const locationLoading=locationDialog.getByRole('img',{name:'Loading',exact:true});if(await locationLoading.count())await locationLoading.waitFor({state:'hidden',timeout:20000});
  await locationDialog.getByText(/\b\d+ eligible listings?\b/).first().waitFor({state:'visible'});
  const eligibleCount=Number(/\b(\d+) eligible listings?\b/.exec(await locationDialog.innerText())?.[1]);
  if(eligibleCount!==targets.length||await locationDialog.getByRole('button',{name:'Country or Region United States',exact:true}).count()!==1)throw Error('Saved common location scope or country is unsupported');
  const locationValues={kind:'saved-bulk-location-dialog' as const,workspaceUrl,observedAt:new Date().toISOString(),postalCode:await locationDialog.getByRole('textbox',{name:'Zip code',exact:true}).inputValue(),city:await locationDialog.getByRole('textbox',{name:'City, State',exact:true}).inputValue(),country:'US',eligibleCount,targetDraftIds:grid.map(r=>r.draftId),rawSnapshot:await locationDialog.ariaSnapshot()};
  const locationEvidence=await retain('saved-batch-location',locationValues);
  await locationDialog.getByRole('button',{name:'Close',exact:true}).click();await locationDialog.waitFor({state:'hidden'});
  const observations:Array<{draftId:string;sku:string;observation:V2BatchRowObservation;evidence:V2BackgroundEvidence}>=[];
  let partialRead:V2PartialSavedBatchReadError|undefined;
  const openRowField=async(row:Locator,name:string|RegExp,heading:string)=>{
   await(await one(row.getByRole('button',{name,exact:typeof name==='string'}),'saved batch field')).click();
   const dialog=page.getByRole('dialog');await dialog.waitFor({state:'visible'});
   const loading=dialog.getByRole('img',{name:'Loading',exact:true});if(await loading.count())await loading.waitFor({state:'hidden',timeout:20000});
   await waitV2ReadonlyBulkFieldHeading(dialog,heading,async()=>{await retain('saved-batch-field-read-retry',{workspaceUrl,heading,observedAt:new Date().toISOString(),reason:'Actual eBay Something went wrong dialog',attempt:1,sellerWrites:0,listingNavigations:0});});
   return dialog;
  };
  const closeRowField=async(dialog:Locator)=>{await dialog.getByRole('heading',{level:2}).first().getByRole('button',{name:'Close',exact:true}).click();await dialog.waitFor({state:'hidden'});};
  for(const row of grid){
   try{
   const actualRow=table.getByRole('row').filter({has:page.locator(`#draft-checkbox-${row.draftId}`)});
   const checkTitle=async(dialog:Locator)=>{const title=(await dialog.locator('.listing-identifiers__info').innerText()).trim();if(title!==row.title)throw Error('Native batch field belongs to another saved row');};
   await checkpoint(`Reading stored photo references for ${row.sku}`);
   const photoResult=await measured('browser-batch-photo-read',async()=>{const dialog=await openRowField(actualRow,'Image','Photos');await checkTitle(dialog);const photos=await dialog.locator('.uploader-thumbnails__image').evaluateAll(es=>es.map((e,n)=>{if(e.id!==`uploader-thumbnails__image${n}`)throw Error('Ordered photo controls required');return(e as HTMLElement).style.backgroundImage;}));const proof=await retain('saved-batch-row-photos',{draftId:row.draftId,sku:row.sku,workspaceUrl,observedAt:new Date().toISOString(),photos});await closeRowField(dialog);return{photos,proof};});
   await checkpoint(`Reading saved item specifics for ${row.sku}`);
   const aspectResult=await measured('browser-batch-specifics-read',async()=>{const dialog=await openRowField(actualRow,/^\d+ completed$/,'Item specifics');await checkTitle(dialog);const specifics=await readV2BackgroundBulkSpecifics(dialog);const proof=await retain('saved-batch-row-specifics',{draftId:row.draftId,sku:row.sku,workspaceUrl,observedAt:new Date().toISOString(),specifics});await closeRowField(dialog);return{specifics,proof};});
   await checkpoint(`Reading saved description for ${row.sku}`);
   const descriptionResult=await measured('browser-batch-description-read',async()=>{const dialog=await openRowField(actualRow,'Edit description','Item description');await checkTitle(dialog);const controls=dialog.locator('textarea');if(await controls.count()!==1)throw Error('One actual saved description control required');const description=await controls.inputValue();const proof=await retain('saved-batch-row-description',{draftId:row.draftId,sku:row.sku,workspaceUrl,observedAt:new Date().toISOString(),description});await closeRowField(dialog);return{description,proof};});
   const observation:V2BatchRowObservation={kind:'saved-reopened-draft-batch-row-nonprice-observation',draftId:row.draftId,workspaceUrl,observedAt:new Date().toISOString(),scope:'non-price-fields; pricing left untouched per seller',priceWritePerformed:false,row,specifics:aspectResult.specifics,description:descriptionResult.description,photos:photoResult.photos,location:{source:'saved-bulk-location-dialog',postalCode:locationValues.postalCode,city:locationValues.city,country:locationValues.country,eligibleCount,targetDraftIds:locationValues.targetDraftIds,evidence:locationEvidence},sourceEvidence:{grid:gridEvidence,photos:photoResult.proof,specifics:aspectResult.proof,description:descriptionResult.proof}};
   const evidence=await retain('saved-batch-row-observation',observation);observations.push({draftId:row.draftId,sku:row.sku,observation,evidence});
   }catch(error){const errorEvidence=await retain('saved-batch-row-read-interrupted',{draftId:row.draftId,sku:row.sku,workspaceUrl,observedAt:new Date().toISOString(),completedObservationEvidence:observations.map(o=>o.evidence),diagnostic:error instanceof Error?{name:error.name,message:error.message.slice(0,2500)}:{name:'Unknown'},snapshot:(await page.locator('body').ariaSnapshot()).slice(0,100000),sellerWrites:0,listingNavigations:0});partialRead=new V2PartialSavedBatchReadError(observations,errorEvidence);break;}
  }
  const protectedAfterValues=await table.evaluate(collectV2BackgroundBulkProtectedDOM,targets.map(t=>t.sku)),after=sha(JSON.stringify(protectedAfterValues));if(!sameV2BackgroundBulkProtectedValues(protectedBeforeValues,protectedAfterValues)){await retain('saved-batch-protected-difference',{workspaceUrl,observedAt:new Date().toISOString(),targets,before:protectedBeforeValues,after:protectedAfterValues,completedObservationEvidence:observations.map(o=>o.evidence),sellerWrites:0,listingNavigations:0});throw Error('Read-only batch observation changed protected saved values');}
  if(partialRead)throw partialRead;
  return{observations,listingNavigations:0,sellerWrites:0,evidence:await retain('saved-batch-readback-result',{workspaceUrl,targets,observations:observations.map(o=>({draftId:o.draftId,sku:o.sku,evidence:o.evidence})),listingNavigations:0,sellerWrites:0,canPublish:false})};
 }));}
 async function correctSavedFactualQuantityDescription(input:{draftId:string;sku:string;quantity:number;previousDescription:string;nextDescription:string}){return exclusive(()=>measured('browser-factual-description-correction',async()=>{
  if(!/^\d+$/.test(input.draftId)||!input.sku||!Number.isSafeInteger(input.quantity)||input.quantity<=1||input.quantity>20||!input.previousDescription||!input.nextDescription||input.previousDescription===input.nextDescription||input.nextDescription.length>10000)throw Error('Exact quantity draft and changed factual wording required');
  await page.goto(`https://www.ebay.com/lstng?draftId=${input.draftId}&mode=AddItem`,{waitUntil:'domcontentloaded'});const rawDescription=page.locator('textarea[name="description"]');await rawDescription.waitFor({state:'attached'});if(!await rawDescription.isVisible()){const htmlView=page.getByRole('checkbox',{name:'Show HTML Code',exact:true});if(await htmlView.count()!==1)throw Error('Actual HTML description view is unavailable');await htmlView.check();}const label=await one(page.locator('input[name="customLabel"]'),'exact saved SKU'),quantity=await one(page.locator('input[name="quantity"]'),'exact saved quantity'),description=await one(page.locator('textarea[name="description"]'),'actual saved description');
  if(exactV2BackgroundDraftId(page.url())!==input.draftId||await label.inputValue()!==input.sku||await quantity.inputValue()!==String(input.quantity)||await description.inputValue()!==input.previousDescription)throw Error('Exact draft/SKU/quantity/previous description changed; correction stopped');
  const before=await page.locator('body').evaluate(collectV2DescriptionProtectedDOM),beforeEvidence=await retain('factual-description-before',{...input,observedAt:new Date().toISOString(),protected:before,canPublish:false}),intentFile=path.join(evidence,'factual-description-'+sha(JSON.stringify(input))+'-intent.json');
  await fs.writeFile(intentFile,JSON.stringify({kind:'exact-factual-quantity-description-intent',...input,before:beforeEvidence,observedAt:new Date().toISOString(),priceWrites:0,publishWrites:0}),{flag:'wx',mode:0o600,flush:true});let saveAttempted=false;
  try{await description.fill(input.nextDescription);if(await description.inputValue()!==input.nextDescription||sha(JSON.stringify(await page.locator('body').evaluate(collectV2DescriptionProtectedDOM)))!==sha(JSON.stringify(before)))throw Error('Protected field changed; correction save prohibited');
   const save=await one(page.getByRole('button',{name:'Save for later',exact:true}),'Save for later');saveAttempted=true;await save.click();await page.waitForLoadState('domcontentloaded');const result={kind:'exact-factual-quantity-description-save',draftId:input.draftId,sku:input.sku,quantity:input.quantity,saveAttempted,verificationPerformed:false,priceWrites:0,shippingWrites:0,publishWrites:0,observedAt:new Date().toISOString(),before:beforeEvidence};return{...result,evidence:await retain('factual-description-save-result',result)};
  }catch(error){await retain('factual-description-save-interrupted',{draftId:input.draftId,sku:input.sku,saveAttempted,noReplay:true,observedAt:new Date().toISOString(),before:beforeEvidence});throw error;}
 }));}
 async function readSavedDraft(draftId:string,expandFeatures=true){return exclusive(()=>measured('browser-saved-readback',async()=>{
  if(!/^\d+$/.test(draftId))throw Error('Exact saved DraftID required');await checkpoint('Opening exact saved draft');await page.goto(`https://www.ebay.com/lstng?draftId=${draftId}&mode=AddItem`,{waitUntil:'domcontentloaded'});if(exactV2BackgroundDraftId(page.url())!==draftId)throw Error('Saved editor redirected to another draft');
  await page.locator('input[name="title"]').waitFor({state:'visible',timeout:12000});await page.locator('input[name="customLabel"]').waitFor({state:'visible',timeout:12000});
  const initial=await page.locator('body').evaluate(collectV2BackgroundSavedDOM);
  if(expandFeatures){const features=page.locator('button[name="attributes.Features"]');if(await features.count()!==1)throw new V2BackgroundBrowserError('UNSUPPORTED_PAGE','One actual Features control required');const expanded=await features.getAttribute('aria-expanded');if(expanded==='false')await features.click();else if(expanded!=='true')throw new V2BackgroundBrowserError('UNSUPPORTED_PAGE','Features expansion state unavailable');}
  const actual=await page.locator('body').evaluate(collectV2BackgroundSavedDOM);if(exactV2BackgroundDraftId(actual.url)!==draftId)throw Error('Saved draft changed while reading');
  const observation={kind:'saved-reopened-draft-nonprice-observation',draftId,url:actual.url,observedAt:actual.observedAt,scope:'non-price-fields; pricing left untouched per seller',priceWritePerformed:false,ax:initial.transcript,dom:actual.dom,features:{ax:actual.transcript},observationSource:'dedicated-browser-visible-dom',rawSemanticSnapshot:await page.locator('body').ariaSnapshot()};
  const proof=await retain('saved-draft-observation',observation);await checkpoint('Retained exact saved draft fields');return{observation,evidence:proof,savedFieldWrites:0};
 }));}
 /** One first-save metadata setup, followed later by the existing single saved
  * readback. It never edits identity, quantity, price, shipping or description. */
 async function prepareImportedDrafts(input:{targets:Array<{draftId:string;sku:string}>;policies:V2BackgroundDefaults}){return exclusive(()=>measured('browser-shared-first-save',async()=>{
  const {targets,policies}=input;if(!targets.length||targets.length>20||new Set(targets.map(t=>t.draftId)).size!==targets.length||targets.some(t=>!/^\d+$/.test(t.draftId)||!t.sku)||!/^\d+$/.test(policies.payment.id)||!/^\d+$/.test(policies.returns.id)||policies.returns.label!=='No Return Accepted'||!/^[A-Za-z0-9 -]{3,12}$/.test(policies.location.postalCode)||!policies.location.city||policies.location.country!=='US')throw Error('Exact imported targets and verified supported seller defaults required');
  const source=path.resolve(root,policies.evidence.path),rel=path.relative(artifacts,source);if(!rel||rel.startsWith('..')||path.isAbsolute(rel)||sha(await fs.readFile(source))!==policies.evidence.sha256)throw Error('Seller defaults source evidence changed');
  const results=[];
  const choice=(label:RegExp,value:string|RegExp)=>chooseV2BackgroundOption(page,label,value);
  for(const target of targets){await checkpoint('Preparing imported draft shared fields');await page.goto(`https://www.ebay.com/lstng?draftId=${target.draftId}&mode=AddItem`,{waitUntil:'domcontentloaded'});await page.locator('input[name="customLabel"]').waitFor({state:'visible'});if(exactV2BackgroundDraftId(page.url())!==target.draftId||await page.locator('input[name="customLabel"]').inputValue()!==target.sku)throw Error('Imported first-save draft/SKU binding changed');
   const before=await page.locator('body').evaluate(collectV2BackgroundProtectedFields),actual=await page.locator('body').evaluate(collectV2BackgroundSavedDOM),fields=actual.dom.fields,field=(name:string)=>fields.find(f=>f.name===name)?.value,changed:string[]=[];let saveAttempted=false,failedStep='condition-type';
   const proof=await retain('first-save-before',{draftId:target.draftId,sku:target.sku,observedAt:actual.observedAt,dom:actual.dom,transcript:actual.transcript,defaultsEvidence:policies.evidence});
   try{
    if(field('condition')!=='4000'||field('40001')!=='400010'){if(field('condition')!=='4000')await choice(/^Condition type\b/i,/^Ungraded: Not in original packaging or professionally graded/);failedStep='card-condition';await choice(/^Card Condition\b/i,/^Near mint or better: Comparable to a fresh pack/);changed.push('condition');}
    failedStep='payment-policy';if(!(field('paymentPolicyId')??'').includes(policies.payment.id)){await choice(/^Payment policy$/i,`${policies.payment.label} (${policies.payment.id})`);changed.push('payment-policy');}
    const returnsText=`${policies.returns.label} (${policies.returns.id})`,needReturns=!actual.transcript.includes(returnsText),needLocation=!actual.transcript.includes(policies.location.postalCode)||!actual.transcript.includes(policies.location.city);
    if(needReturns||needLocation){failedStep='settings-open';await (await one(page.getByRole('button',{name:'Your settings - edit',exact:true}),'Your settings edit')).click();
     if(needLocation){failedStep='location';const zip=await one(page.getByLabel('ZIP Code',{exact:true}),'ZIP Code');await zip.fill(policies.location.postalCode);await zip.press('Tab');await page.getByText(new RegExp(policies.location.city.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'))).first().waitFor({state:'visible',timeout:10000});changed.push('location');}
     if(needReturns){failedStep='return-policy';await choice(/^Return policy$/i,returnsText);changed.push('return-policy');}
     failedStep='settings-done';await (await one(page.getByRole('button',{name:'Done',exact:true}),'settings Done')).click();
    }
    failedStep='protected-fields';const after=await page.locator('body').evaluate(collectV2BackgroundProtectedFields);if(JSON.stringify(before)!==JSON.stringify(after))throw Error('Protected price/shipping/identity/quantity changed during first-save setup; save prohibited');
    const appliedActual=await page.locator('body').evaluate(collectV2BackgroundSavedDOM),applied=await retain('first-save-applied',{kind:'actual-singleton-applied-defaults',draftId:target.draftId,sku:target.sku,observedAt:appliedActual.observedAt,actual:appliedActual,defaultsEvidence:policies.evidence,protectedFieldsUnchanged:true,priceWrites:false,shippingWrites:false});
    if(changed.length){await retain('first-save-intent',{draftId:target.draftId,sku:target.sku,changed,before:proof,at:new Date().toISOString(),canPublish:false});failedStep='save-for-later';saveAttempted=true;await (await one(page.getByRole('button',{name:'Save for later',exact:true}),'Save for later')).click();await page.waitForLoadState('domcontentloaded');}
    const outcome=await retain('first-save-result',{draftId:target.draftId,sku:target.sku,changed,saveAttempted,before:proof,applied,at:new Date().toISOString(),priceWrites:false,shippingWrites:false,verificationPerformed:false});results.push({...target,changed,saveAttempted,before:proof,applied,evidence:outcome});
   }catch(error){await retain('first-save-interrupted',{...target,saveAttempted,failedStep,changed,safeFailure:error instanceof V2BackgroundBrowserError?{code:error.code,detail:error.message}:{code:'LOCAL_GUARD',detail:'First-save operation stopped; raw details suppressed'},before:proof,at:new Date().toISOString(),noReplay:true});throw error;}
  }
  return{results,priceWrites:false,shippingWrites:false,canPublish:false,verificationPerformed:false};
 }));}
 async function prepareImportedDraftBatch(input:{targets:Array<{draftId:string;sku:string}>;policies:V2BackgroundDefaults;categoryId:'261328'|'183454'|'183050'}){
  if(input.targets.length===1){
   if(typeof input.categoryId!=='string'||!['261328','183454','183050'].includes(input.categoryId))throw Error('Supported singleton category batch required');
   const result=await prepareImportedDrafts({targets:input.targets,policies:input.policies}),body={kind:'background-shared-draft-batch-save' as const,mode:'singleton-native-editor' as const,targets:input.targets,categoryId:input.categoryId,saveAttempted:result.results.some(r=>r.saveAttempted),observedAt:new Date().toISOString(),results:result.results,priceWrites:false,shippingWrites:false,canPublish:false,verificationPerformed:false};
   return{...body,evidence:await retain('batch-shared-save-result',body)};
  }
  return exclusive(()=>measured('browser-shared-draft-batch-save',async()=>{
  const {targets,policies,categoryId}=input,categoryTrails={
   '261328':['Sports Mem, Cards & Fan Shop','Sports Trading Cards','Trading Card Singles'],
   '183454':['Toys & Hobbies','Collectible Card Games','CCG Individual Cards'],
   '183050':['Collectibles','Non-Sport Trading Cards','Trading Card Singles'],
  } as const;
  if(!targets.length||targets.length>20||new Set(targets.map(t=>t.draftId)).size!==targets.length||new Set(targets.map(t=>t.sku)).size!==targets.length||targets.some(t=>!/^\d+$/.test(t.draftId)||!t.sku)||typeof categoryId!=='string'||!Object.hasOwn(categoryTrails,categoryId)||!/^\d+$/.test(policies.payment.id)||!/^\d+$/.test(policies.returns.id)||policies.returns.label!=='No Return Accepted'||!/^\d{5}(?:-\d{4})?$/.test(policies.location.postalCode)||!policies.location.city||policies.location.country!=='US')throw Error('Exact imported category batch and verified supported shared defaults required');
  const source=path.resolve(root,policies.evidence.path),relative=path.relative(artifacts,source);if(!relative||relative.startsWith('..')||path.isAbsolute(relative))throw Error('Shared defaults source must remain under artifacts');const stat=await fs.lstat(source);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1000000)throw Error('Bounded shared defaults source required');const sourceBytes=await fs.readFile(source);if(sha(sourceBytes)!==policies.evidence.sha256)throw Error('Shared defaults evidence changed');const actualDefaults=JSON.parse(sourceBytes.toString('utf8'));if(actualDefaults.seller!=='imaydit58'||actualDefaults.kind!=='actual-seller-owned-background-policy-read'||sha(JSON.stringify(actualDefaults.defaults))!==sha(JSON.stringify({payment:policies.payment,returns:policies.returns,location:policies.location})))throw Error('Shared default fields differ from the actual seller policy source');
  let failedStep='select-imported-drafts',saveAttempted=false,beforeEvidence:V2BackgroundEvidence|undefined;
  const visible=async(locator:Locator)=>{await locator.first().waitFor({state:'visible',timeout:15000});return one(locator,'batch shared-field');};
  const click=async(locator:Locator)=>{await(await visible(locator)).click();};
  try{
   const {table,expectedSkus}=await openImportedDraftBatchWorkspace(targets);
   const before=await table.evaluate(collectV2BackgroundBulkProtectedDOM,expectedSkus);if(before.rows.length!==targets.length||before.rows.some(row=>categoryTrails[categoryId].some(part=>!row.category.includes(part))))throw Error('Shared workspace must contain only the exact supported category');
   const protectedHash=sha(JSON.stringify(before));beforeEvidence=await retain('batch-shared-before',{kind:'actual-exact-imported-draft-batch',targets,categoryId,url:page.url(),observedAt:new Date().toISOString(),protectedHash,defaultsEvidence:policies.evidence,verificationPerformed:false});
   await(await visible(page.getByRole('checkbox',{name:'Select all items for bulk edit.',exact:true}))).check();
   const open=async(field:string,name:string)=>{await click(page.getByRole('button',{name:'Bulk edit',exact:true}));await click(page.getByRole('menuitem',{name:field,exact:true}));const dialog=await visible(page.getByRole('dialog',{name,exact:true}));const loading=dialog.getByRole('img',{name:'Loading',exact:true});if(await loading.count())await loading.waitFor({state:'hidden',timeout:15000});await dialog.getByText(/\b\d+ eligible listings?\b/).first().waitFor({state:'visible',timeout:15000});const text=await dialog.innerText(),eligible=/\b(\d+) eligible listings?\b/.exec(text);if(!eligible||Number(eligible[1])!==targets.length)throw Error('Shared dialog eligible count differs from exact imported batch');return dialog;};
   failedStep='shared-condition';const condition=await open('Condition','Condition');if(await condition.getByRole('group').count()!==1)throw Error('Shared condition editor spans multiple category groups');await condition.getByRole('combobox',{name:'Action',exact:true}).selectOption({label:'Change to'});await chooseV2BackgroundOption(page,/^Condition type\b/i,/^Ungraded: Not in original packaging or professionally graded/);await chooseV2BackgroundOption(page,/^Card Condition\b/i,'Near mint or better');await click(condition.getByRole('button',{name:'Apply',exact:true}));await condition.waitFor({state:'hidden'});
   failedStep='shared-payment-returns';const business=await open('Payment policy','Business policies'),shipping=business.getByRole('group',{name:'Shipping policy',exact:true});if(!await shipping.getByRole('radio',{name:'No change',exact:true}).isChecked())throw Error('Shipping policy must remain explicitly unchanged');
   for(const field of [{label:'Payment policy',policy:policies.payment},{label:'Return policy',policy:policies.returns}]){const group=business.getByRole('group',{name:field.label,exact:true});await group.getByRole('radio',{name:'Change to',exact:true}).check();await click(group.getByRole('button',{name:/^Selected policy/}));const selection=await visible(page.getByRole('dialog'));await(await visible(selection.getByRole('radio',{name:`${field.policy.label} (${field.policy.id})`,exact:true}))).check();await click(selection.getByRole('button',{name:'Save',exact:true}));await business.waitFor({state:'visible'});}
   if(!await shipping.getByRole('radio',{name:'No change',exact:true}).isChecked())throw Error('Shipping policy changed during common policy selection');await click(business.getByRole('button',{name:'Apply',exact:true}));await business.waitFor({state:'hidden'});
   failedStep='shared-location';const location=await open('Item location','Item location');await visible(location.getByRole('button',{name:'Country or Region United States',exact:true}));const postal=await visible(location.getByRole('textbox',{name:'Zip code',exact:true}));await postal.fill(policies.location.postalCode);await postal.press('Tab');const city=await visible(location.getByRole('textbox',{name:'City, State',exact:true}));const cityDeadline=Date.now()+10000;while(!(await city.inputValue()).toLowerCase().includes(policies.location.city.toLowerCase())){if(Date.now()>cityDeadline)throw new V2BackgroundBrowserError('UNSUPPORTED_PAGE','Verified shared postal location did not resolve to the expected city');await new Promise(r=>setTimeout(r,150));}await click(location.getByRole('button',{name:'Apply',exact:true}));await location.waitFor({state:'hidden'});
   failedStep='protected-batch-fields';const after=await table.evaluate(collectV2BackgroundBulkProtectedDOM,expectedSkus);if(!sameV2BackgroundBulkProtectedValues(before,after))throw Error('Shared setup changed protected price, shipping, identity, category or quantity fields; save prohibited');
   await retain('batch-shared-save-intent',{targets,categoryId,before:beforeEvidence,at:new Date().toISOString(),priceWrites:false,shippingWrites:false,canPublish:false});failedStep='batch-save-for-later';saveAttempted=true;await click(page.getByRole('button',{name:'Save for later',exact:true}));await page.waitForLoadState('domcontentloaded');
   const body={kind:'background-shared-draft-batch-save' as const,mode:'native-bulk-editor' as const,targets,categoryId,saveAttempted:true,observedAt:new Date().toISOString(),before:beforeEvidence,priceWrites:false,shippingWrites:false,canPublish:false,verificationPerformed:false};return{...body,evidence:await retain('batch-shared-save-result',body)};
  }catch(error){await retain('batch-shared-interrupted',{targets,categoryId,failedStep,saveAttempted,before:beforeEvidence,observedAt:new Date().toISOString(),diagnostic:error instanceof Error?{name:error.name,message:error.message.slice(0,2500)}:{name:'Unknown'},noPerCardFallback:true,canPublish:false});throw error;}
 }));}
 async function captureInventoryScope(scope:'active'|'drafts'|'scheduled'|'sold',url:string,maxPages=100){return exclusive(async()=>{
  if(!Number.isInteger(maxPages)||maxPages<1||maxPages>100)throw Error('Bounded inventory pagination required');const u=strictUrl(url);if(!u.pathname.startsWith('/sh/'))throw Error('An actual seller scope URL is required');await gotoSeller(url);const pages:ReturnType<typeof collectV2BackgroundInventoryDOM>[]=[],observedPageUrls:string[]=[],seen=new Set<string>();let complete=false;
  for(let n=0;n<maxPages;n++){await checkpoint(`Reading ${scope} inventory page ${n+1}`);let actual=await page.locator('body').evaluate(collectV2BackgroundInventoryDOM);for(let retry=0;retry<20&&seen.has(sha(JSON.stringify(actual.rows)));retry++){await new Promise(r=>setTimeout(r,250));actual=await page.locator('body').evaluate(collectV2BackgroundInventoryDOM);}if(!actual.supported)throw new V2BackgroundBrowserError('UNSUPPORTED_PAGE','Seller inventory table layout is unsupported; no absence inferred');const key=sha(JSON.stringify(actual.rows));if(seen.has(key))throw Error('Seller pagination repeated a page; scope is incomplete');seen.add(key);pages.push(actual);observedPageUrls.push(page.url());const next=page.getByRole('button',{name:/^(?:Go to )?Next(?: page)?(?: of results)?$/i}).or(page.getByRole('link',{name:/^(?:Go to )?Next(?: page)?(?: of results)?$/i}));if(await next.count()===0){complete=actual.empty||!!actual.pagination&&actual.pagination.end>=actual.pagination.total;if(!complete)throw new V2BackgroundBrowserError('UNSUPPORTED_PAGE','Inventory end-of-pagination evidence is missing; no absence inferred');break;}if(await next.count()!==1)throw Error('Ambiguous inventory pagination');if(!await next.isEnabled()||await next.getAttribute('aria-disabled')==='true'){complete=true;break;}if(n+1>=maxPages)break;await next.click();await page.waitForLoadState('domcontentloaded');await requireSeller();}
  const observedAt=new Date().toISOString(),observedRows=pages.flatMap(p=>p.rows),rows=scope==='sold'?Array.from(new Map(observedRows.map(row=>[JSON.stringify([row.id,row.sku,row.title]),row])).values()):observedRows,historyWindow=scope==='sold'?observedV2BackgroundSoldWindow(page.url()):undefined; if(historyWindow&&!historyWindow.fullProviderWindow)complete=false;const proof=await retain('inventory-scope',{kind:'actual-dedicated-browser-inventory-scope',seller:'imaydit58',scope,url,observedAt,complete,rows,pages,observedPageUrls,...(historyWindow?{historyWindow}:{})});return{scope,seller:'imaydit58' as const,url,observedAt,complete,rows,evidence:proof,...(historyWindow?{historyWindow}:{})};
 });}
 async function downloadCategoryTemplate(categoryId:'261328'|'183454'|'183050'){return exclusive(()=>measured('browser-category-template-download',async()=>{
  const categories={
   '261328':{label:'Trading Card Singles',trail:['Sports Mem, Cards & Fan Shop','Sports Trading Cards','Trading Card Singles']},
   '183454':{label:'CCG Individual Cards',trail:['Toys & Hobbies','Collectible Card Games','CCG Individual Cards']},
   '183050':{label:'Trading Card Singles',trail:['Collectibles','Non-Sport Trading Cards','Trading Card Singles']},
  } as const;
  if(typeof categoryId!=='string'||!Object.hasOwn(categories,categoryId))throw new V2BackgroundBrowserError('UNSUPPORTED_PAGE','Only supported card category templates may be downloaded');
  const category=categories[categoryId],deadline=Date.now()+60000;
  const remaining=()=>{const ms=deadline-Date.now();if(ms<=0)throw new V2BackgroundBrowserError('UNSUPPORTED_PAGE','Category template download exceeded its bounded deadline');return ms;};
  const control=async(locator:Locator)=>{await locator.first().waitFor({state:'visible',timeout:Math.min(12000,remaining())});if(await locator.count()!==1)throw new V2BackgroundBrowserError('UNSUPPORTED_PAGE','Exactly one observed category template control required');return locator;};
  const click=async(locator:Locator)=>{await(await control(locator)).click({timeout:Math.min(12000,remaining())});};
  const radio=async(name:string)=>{await(await control(page.getByRole('radio',{name,exact:true}))).check({timeout:Math.min(12000,remaining())});};
  await checkpoint('Downloading missing or stale official category template');
  await gotoSeller('https://www.ebay.com/sh/reports/uploads');
  await click(page.getByRole('button',{name:'Get template',exact:true}));
  await click(page.getByRole('dialog',{name:'Download template',exact:true}).getByRole('button',{name:'Source Select template source',exact:true}));
  await radio('Listings');await click(page.getByRole('button',{name:'Type Select template type',exact:true}));await radio('Create or Schedule new listings');
  await click(page.getByRole('button',{name:'File type Select file type',exact:true}));await radio('Comma Separated File (.csv)');
  await click(page.getByRole('button',{name:'Categories Select categories',exact:true}));
  let selectedCategory:unknown;
  for(let index=0;index<category.trail.length;index++){const label=category.trail[index];
   const checkbox=await control(page.getByRole('checkbox',{name:label,exact:true}));
   if(index===category.trail.length-1){await checkbox.check({timeout:Math.min(12000,remaining())});selectedCategory=await checkbox.evaluate(e=>({checked:(e as HTMLInputElement).checked,labels:Array.from((e as HTMLInputElement).labels??[]).map(label=>({id:label.id,text:label.textContent?.trim()??''}))}));}
   else await click(checkbox.locator('xpath=ancestor::li[1]').locator(':scope > button'));
  }
  const selected=await retain('category-template-selection',{kind:'actual-seller-category-template-selection',seller:'imaydit58',observedAt:new Date().toISOString(),sourcePage:page.url(),categoryId,trail:category.trail,selectedCategory,uploaded:false});
  await click(page.getByRole('button',{name:'Done',exact:true}));
  const requestedAt=new Date().toISOString(),pending=page.waitForEvent('download',{timeout:remaining()});void pending.catch(()=>undefined);
  await click(page.getByRole('button',{name:'Download',exact:true}));const download=await pending;
  const filename=path.join(evidence,`category-${categoryId}-${randomUUID()}-official-template.csv`);
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{await Promise.race([download.saveAs(filename),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{void download.cancel();reject(new V2BackgroundBrowserError('UNSUPPORTED_PAGE','Category template download exceeded its bounded deadline'));},remaining());})]);}finally{if(timer)clearTimeout(timer);}
  const bytes=await fs.readFile(filename);if(!bytes.length||bytes.length>16000000||!/^\uFEFF?Info,Version=1\.0\.0,Template=fx_category_template_EBAY_US\r?\n/.test(bytes.toString('utf8')))throw new V2BackgroundBrowserError('UNSUPPORTED_PAGE','Downloaded category template is not the supported official CSV family');
  const template={path:path.relative(root,filename).replaceAll('\\','/'),sha256:sha(bytes)},body={requestedAt,downloadedAt:new Date().toISOString(),source:'actual Seller Hub Get template UI',sourcePage:'https://www.ebay.com/sh/reports/uploads',type:'Create or Schedule new listings',fileType:'Comma Separated File (.csv)',category:category.label,categoryId,trail:category.trail,suggestedFilename:download.suggestedFilename(),artifact:template.path,bytes:bytes.length,sha256:template.sha256,selectionEvidence:selected,uploaded:false};
  const receipt=await retain('category-template-receipt',body);await checkpoint('Official category template retained; no listing uploaded');return{categoryId,template,receipt};
 }));}
 async function inspectInventoryLayout(){return exclusive(async()=>{
  strictUrl(page.url());return page.locator('body').evaluate(body=>{
   const visible=(e:Element)=>{const b=e.getBoundingClientRect();return b.width>0&&b.height>0&&getComputedStyle(e).visibility!=='hidden';},text=(e:Element)=>(e as HTMLElement).innerText?.trim()??'';
   return{url:location.href,observedAt:new Date().toISOString(),headings:Array.from(body.querySelectorAll('h1,h2')).filter(visible).map(text),paginationControls:Array.from(body.querySelectorAll('[class*=pagination] a,[class*=pagination] button,[aria-label*=page]')).filter(visible).map(e=>({tag:e.tagName,role:e.getAttribute('role'),name:e.getAttribute('aria-label')||text(e),title:e.getAttribute('title'),className:e.className,rel:e.getAttribute('rel')})).slice(0,35),filterControls:Array.from(body.querySelectorAll('select,[role=combobox],[aria-haspopup]')).map(e=>({tag:e.tagName,id:e.id,role:e.getAttribute('role'),label:e.getAttribute('aria-label')??'',name:e.getAttribute('name')??'',text:text(e),options:e.tagName==='SELECT'?Array.from((e as HTMLSelectElement).options).map(o=>({text:o.textContent?.trim()??'',value:o.value})):undefined})).filter(e=>/date|year|month|days|time|range/i.test([e.label,e.name,e.text,e.id].join(' '))).slice(0,30),tableHeaders:Array.from(body.querySelectorAll('table,[role=table]')).filter(visible).map(t=>Array.from(t.querySelectorAll('th,[role=columnheader]')).map(text)),scopeControls:Array.from(body.querySelectorAll('button,select,[role=combobox],a')).filter(visible).map(e=>({tag:e.tagName,role:e.getAttribute('role'),name:e.getAttribute('aria-label')||text(e)})).filter(e=>/^(?:Next|Previous|Last \d+|Current year|This year|All orders|All time|Date|Time range|Custom|Scheduled|Active|Drafts|Sold|Today|Yesterday|Past \d+)/i.test(e.name)).slice(0,100),rangeLines:(body as HTMLElement).innerText.split('\n').map(s=>s.trim()).filter(s=>/^(?:\d+\s*[-\u2013\u2014]\s*\d+\s+of\s+[\d,]+|(?:Last|Past) \d+ (?:days|months|years)|Current year|This year|All time|No (?:active|scheduled|sold|listings|orders|results))/i.test(s)).slice(0,30)};
  });
 });}
 const draftMatch=createV2DraftMatchBrowser({page:()=>page,goto:gotoSeller,seller:requireSeller,open:openImportedDraftBatchWorkspace,retain,checkpoint});
 return{driver:'dedicated-local-browser' as const,captureDraftMatchSnapshot:()=>exclusive(()=>measured('browser-draft-match-snapshot',draftMatch.captureDraftMatchSnapshot)),saveDraftQuantities:(input:Parameters<typeof draftMatch.saveDraftQuantities>[0])=>exclusive(()=>measured('browser-draft-quantity-save',()=>draftMatch.saveDraftQuantities(input))),reconcileDraftQuantities:(input:Parameters<typeof draftMatch.reconcileDraftQuantities>[0])=>exclusive(()=>measured('browser-draft-quantity-reconcile',()=>draftMatch.reconcileDraftQuantities(input))),correctSavedFactualQuantityDescription,status,observeSignIn,uploadDraftCsv,prepareImportedDrafts,prepareImportedDraftBatch,readSavedSingleDraftRow,readSavedDraftGrid,readSavedDraftBatch,readSavedDraft,captureInventoryScope,downloadCategoryTemplate,inspectInventoryLayout,resumeUploadResult:(filename:string,localJobId:string)=>exclusive(async()=>{await gotoSeller('https://www.ebay.com/sh/reports/uploads');return collectUploadResult(filename,localJobId);}),close:()=>context.close()};
}

/** Actual Seller Hub draft-list title prefix, grounded in retained live DOM. */
export function projectV2SavedSingletonRow(rows:Array<{id:string;sku:string;title:string;quantity:string}>,target:{draftId:string;sku:string}){
 const matches=rows.filter(r=>r.id===target.draftId);if(matches.length!==1||matches[0].sku!==target.sku||!/^[1-9]\d*$/.test(matches[0].quantity))throw Error('Exact unique saved draft-list ID/SKU/quantity required');
 const row=matches[0],title=row.title.replace(/^Resume draft\s+Link\.\s*/,'');if(!title.trim())throw Error('Actual saved draft-list title required');
 return{draftId:row.id,sku:row.sku,title,quantity:row.quantity};
}

/** Visible upload table only; task ID is observed from a named column, data
 * attribute or actual task link. A filename/hash never becomes an eBay ID. */
export function collectUploadRow(element:HTMLElement|SVGElement){
 const text=(element as HTMLElement).innerText,table=element.closest('table,[role=table],[role=grid]'),headers=Array.from(table?.querySelectorAll('th,[role=columnheader]')??[]).map(e=>e.textContent?.trim()??''),cells=Array.from(element.querySelectorAll('td,[role=cell],[role=gridcell]')).map(e=>e.textContent?.trim()??'');
 const column=headers.findIndex(h=>/^(?:Job|Task|Reference)(?:\s+ID|\s+number)?$/i.test(h)),observed=column>=0?cells[column]:element.getAttribute('data-job-id');
 const links=Array.from(element.querySelectorAll('a[href]')).flatMap(a=>{try{const u=new URL((a as HTMLAnchorElement).href);return [...['jobId','taskId','job_id'].flatMap(k=>u.searchParams.getAll(k)),...(u.origin==='https://www.ebay.com'&&u.pathname==='/sh/fpp/getfiledetails'&&u.searchParams.get('client')==='fileexchange'&&u.searchParams.get('filetype')==='output'?u.searchParams.getAll('requestId'):[])];}catch{return[];}}),ids=Array.from(new Set([observed,...links].filter((s):s is string=>!!s&&/^[A-Za-z0-9_-]{1,200}$/.test(s))));
 const statusIndex=headers.findIndex(h=>/^Status$/i.test(h.replace(/\s+/g,' ').trim())),status=statusIndex>=0?cells[statusIndex]??'':'';return{text,cells,status,jobId:ids.length===1?ids[0]:''};
}

/** This is a serialization of observed rendered DOM, not native AX or generated
 * expected values. Compatibility lines bind actual dropdown IDs, option state
 * and visible text to the existing strict non-price parser. */
export function collectV2BackgroundSavedDOM(body:HTMLElement|SVGElement){
 const visible=(e:Element)=>{const b=e.getBoundingClientRect(),s=getComputedStyle(e);return b.width>0&&b.height>0&&s.visibility!=='hidden'&&s.display!=='none';},text=(e:Element)=>(e as HTMLElement).innerText?.trim()??e.textContent?.trim()??'';
 const permitted=new Set(['title','customLabel','quantity','condition','40001','description','paymentPolicyId','returnPolicyId','shippingPolicyId','scheduleListingSelection']);
 const fields=Array.from(body.querySelectorAll('input,textarea,select')).filter(e=>permitted.has((e as HTMLInputElement).name)||(e as HTMLInputElement).name.startsWith('attributes.')).filter(e=>!['password','hidden'].includes((e as HTMLInputElement).type)).map(e=>{const f=e as HTMLInputElement;return{tag:e.tagName,name:f.name,id:e.id,type:f.type,value:f.value,...(['checkbox','radio'].includes(f.type)?{checked:f.checked}:{})};});
 const category=Array.from(body.querySelectorAll('a,button,span')).filter(e=>visible(e)&&text(e)==='Trading Card Singles').map(e=>({id:e.id,text:text(e),...(e instanceof HTMLAnchorElement?{href:e.href}:{})}));
 for(const e of Array.from(body.querySelectorAll('a[href]'))){if(!visible(e)||!text(e))continue;try{const u=new URL((e as HTMLAnchorElement).href);if(u.origin==='https://www.ebay.com'&&/^\/b\/[^/]+\/\d+(?:\/|$)/.test(u.pathname))category.push({id:e.id,text:text(e),href:u.href});}catch{}}
 const photos=Array.from(body.querySelectorAll('[style]')).flatMap(e=>{const background=getComputedStyle(e).backgroundImage;return visible(e)&&background.includes('i.ebayimg.com')?[{background}]:[];});
 const lines=[text(body)];let seq=1;
 for(const element of Array.from(body.querySelectorAll('button,input[type=checkbox],[role=checkbox]'))){if(!visible(element))continue;
  if(element.tagName==='BUTTON'){const name=text(element),id=element.id;if(id.includes('item-specific-dropdown-label-'))lines.push(`${seq++} button (collapsed) ${name}, ID: ${id}`);else if(element.getAttribute('aria-expanded')==='false')lines.push(`${seq++} button (collapsed) ${name}, Secondary Actions: Expand`);continue;}
  const f=element as HTMLInputElement,label=element.getAttribute('aria-label')||Array.from(f.labels??[]).map(text).join(' ')||text(element),checked=element.getAttribute('aria-checked')??String(f.checked);if(label){lines.push(`${seq++} ${label}, Value: ${checked==='true'?'1':'0'}`);lines.push(`${seq++} checkbox ${label}, Value: ${checked==='true'?'1':'0'}`);}
 }
 return{url:location.href,observedAt:new Date().toISOString(),dom:{fields,category,photos},transcript:lines.join('\n')};
}
export function collectV2BackgroundInventoryDOM(body:HTMLElement|SVGElement){
 const visible=(e:Element)=>{const b=e.getBoundingClientRect();return b.width>0&&b.height>0&&getComputedStyle(e).visibility!=='hidden';},tables=Array.from(body.querySelectorAll('table,[role=table]')).filter(visible),table=tables.find(t=>Array.from(t.querySelectorAll('th,[role=columnheader]')).some(e=>/title|item|listing|^order$/i.test(e.textContent?.trim()??'')));
 const paginationMatch=/(\d+)\s*[\u2013\u2014-]\s*(\d+)\s+of\s+([\d,]+)/i.exec((body as HTMLElement).innerText),pagination=paginationMatch?{start:Number(paginationMatch[1]),end:Number(paginationMatch[2]),total:Number(paginationMatch[3].replaceAll(',',''))}:null;
 const empty=/No (?:active |scheduled |sold )?(?:listings|drafts|orders|results)|You (?:don.t|do not) have any/i.test((body as HTMLElement).innerText);
 if(!table)return{supported:empty,empty,pagination,rows:[] as Array<{id:string;title:string;sku:string;quantity:string;url:string;text:string}>};
 const headers=Array.from(table.querySelectorAll('th,[role=columnheader]')).map(e=>((e as HTMLElement).innerText?.trim()??e.textContent?.trim()??'').split('\n')[0].trim()),skuAt=headers.findIndex(h=>/custom label|sku/i.test(h)),quantityAt=headers.findIndex(h=>/^(?:available\s+)?quantity$/i.test(h));
 const rows=Array.from(table.querySelectorAll('tbody tr,[role=row]')).filter(visible).flatMap(row=>{
  const links=Array.from(row.querySelectorAll('a[href]')).filter(visible).filter(a=>{try{const u=new URL((a as HTMLAnchorElement).href);return u.hostname==='www.ebay.com'&&(/^\/itm\//.test(u.pathname)||['draftId','draft_id'].some(k=>/^\d+$/.test(u.searchParams.get(k)??'')));}catch{return false;}}) as HTMLAnchorElement[],cells=Array.from(row.querySelectorAll('td,[role=cell]')).map(e=>e.textContent?.trim()??''),seen=new Set<string>();
  return links.flatMap(link=>{const url=new URL(link.href),id=url.searchParams.get('draftId')??url.searchParams.get('draft_id')??/\/(\d{10,})(?:[/?]|$)/.exec(url.pathname)?.[1]??'',title=link.innerText.trim();if(!id||!title||seen.has(id))return[];seen.add(id);const sku=skuAt>=0?cells[skuAt]??'':'',quantity=quantityAt>=0?cells[quantityAt]??'':'';return[{id,title,sku,quantity,url:link.href,text:[title,sku,quantity].filter(Boolean).join(' ')}];});
 });
 return{supported:rows.length>0||empty,empty:rows.length===0&&empty,pagination,rows};
}
export function collectV2BackgroundProtectedFields(body:HTMLElement|SVGElement){
 const allowed=new Set(['title','customLabel','quantity','description','price','itemPrice','shippingPolicyId','scheduleListingSelection']);
 return Array.from(body.querySelectorAll('input,textarea,select')).filter(e=>allowed.has((e as HTMLInputElement).name)&&!['hidden','password'].includes((e as HTMLInputElement).type)).map(e=>{const f=e as HTMLInputElement;return{name:f.name,value:f.value,...(['checkbox','radio'].includes(f.type)?{checked:f.checked}:{})};});
}


function canonicalV2USDate(raw:string){const m=/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw.trim());if(!m)return'';return`${m[3]}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`;}
/** Explicit America/Chicago business date; never use the machine/server's date
 * or treat a selected preset label as evidence of its applied query bounds. */
export function v2BackgroundSoldDateRange(now=new Date()){
 const parts=new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',year:'numeric',month:'numeric',day:'numeric'}).formatToParts(now),get=(name:string)=>Number(parts.find(p=>p.type===name)!.value),year=get('year'),month=get('month'),day=get('day'),end=new Date(Date.UTC(year,month-1,day)),start=new Date(Date.UTC(year-2,month-1,Math.min(day,new Date(Date.UTC(year-2,month,0)).getUTCDate())));start.setUTCDate(start.getUTCDate()+1);
 const us=(d:Date)=>`${d.getUTCMonth()+1}/${d.getUTCDate()}/${d.getUTCFullYear()}`;return{from:us(start),to:us(end),startDay:start.toISOString().slice(0,10),endDay:end.toISOString().slice(0,10),timeZone:'America/Chicago',providerDocumentation:'https://developer.ebay.com/develop/api/sell/fulfillment_api/order/getOrders'};
}
export function observedV2BackgroundSoldWindow(rawUrl:string,desired=v2BackgroundSoldDateRange()){
 const u=strictUrl(rawUrl),read=(name:string)=>{const raw=u.searchParams.get(name);if(!raw||!/^\d{12,14}$/.test(raw))return null;const d=new Date(Number(raw));return Number.isFinite(d.valueOf())?{epochMs:Number(raw),day:d.toISOString().slice(0,10)}:null;},start=read('startDate'),end=read('endDate'),currentThroughToday=!!end&&end.day>=desired.endDay,fullProviderWindow=u.pathname==='/sh/ord/'&&!!start&&!!end&&start.day<=desired.startDay&&end.day>=desired.endDay;
 return{actualAppliedUrl:u.href,startDate:start?.epochMs??null,endDate:end?.epochMs??null,startDay:start?.day??null,endDay:end?.day??null,currentThroughToday,fullProviderWindow,allAvailableHistory:false,providerWindow:'documented-last-two-years',desiredStartDay:desired.startDay,desiredEndDay:desired.endDay,timeZone:'America/Chicago',providerDocumentation:desired.providerDocumentation};
}


/** Batch guard only: excludes mutable common condition/policy/location display,
 * while preserving every grid input and the price/shipping/identity columns. */
export function collectV2BackgroundBulkProtectedDOM(table:HTMLElement|SVGElement,expectedSkus:string[]){
 const headers=Array.from(table.querySelectorAll('th,[role=columnheader]')).map(e=>(e.textContent??'').replace(/\s+/g,' ').trim()),categoryIndex=headers.findIndex(h=>h==='Item category 1'),shippingIndex=headers.findIndex(h=>h==='Shipping policy');if(categoryIndex<0||shippingIndex<0)throw Error('Supported category and shipping columns required');
 const rows=Array.from(table.querySelectorAll('tbody tr,[role=row]')).flatMap(row=>{const inputs=Array.from(row.querySelectorAll('input')),owned=inputs.filter(e=>expectedSkus.includes(e.value));if(!owned.length)return[];if(owned.length!==1)throw Error('Exact unique SKU grid ownership required');const cells=Array.from(row.querySelectorAll('td,[role=gridcell],[role=cell]')),fields=Array.from(row.querySelectorAll('input,textarea,select')).filter(e=>{const f=e as HTMLInputElement;return!['hidden','password'].includes(f.type)&&!f.hidden&&!(f.type==='checkbox'&&cells[0]?.contains(f));}).map((e,index)=>{const f=e as HTMLInputElement;return{index,tag:e.tagName,name:f.name,type:f.type,value:f.value,...(['checkbox','radio'].includes(f.type)?{checked:f.checked}:{})};});return[{sku:owned[0].value,category:(cells[categoryIndex]as HTMLElement|undefined)?.innerText?.trim()??'',shipping:(cells[shippingIndex]as HTMLElement|undefined)?.innerText?.trim()??'',fields}];});return{rows:rows.sort((a,b)=>a.sku.localeCompare(b.sku))};
}

/** Native bulk controls only. Names are mapped from visible column headers;
 * values never come from the expected upload payload or eBay.ai suggestions. */
export function collectV2BackgroundSavedBulkGridDOM(table:HTMLElement|SVGElement){
 const headers=Array.from(table.querySelectorAll('th')).map(e=>(e as HTMLElement).innerText.trim());
 const column=(name:string)=>{const matches=headers.flatMap((h,n)=>h===name?[n]:[]);if(matches.length!==1)throw Error('One actual saved bulk column required: '+name);return matches[0];};
 const indexes={title:column('Title'),sku:column('Custom label (SKU)'),quantity:column('Available quantity'),categoryPath:column('Item category 1'),conditionLabel:column('Condition'),schedulingLabel:column('Start time'),paymentPolicy:column('Payment policy'),returnPolicy:column('Return policy'),shippingPolicy:column('Shipping policy')};
 return Array.from(table.querySelectorAll('tbody tr')).flatMap(tr=>{
  const ids=Array.from(tr.querySelectorAll('input[type=checkbox]')).flatMap(i=>/^draft-checkbox-(\d+)$/.exec(i.id)?.[1]??[]);if(!ids.length)return[];if(ids.length!==1)throw Error('One actual draft identity required per saved bulk row');
  const cells=Array.from(tr.querySelectorAll('td')),text=(n:number)=>(cells[n] as HTMLElement).innerText.replace(/\s+/g,' ').trim();
  const value=(n:number)=>{const controls=cells[n].querySelectorAll('input:not([type=hidden]):not([type=checkbox]),textarea');if(controls.length!==1)throw Error('One actual saved row control required');return(controls[0] as HTMLInputElement).value;};
  return[{draftId:ids[0],sku:value(indexes.sku),title:value(indexes.title),quantity:value(indexes.quantity),categoryPath:text(indexes.categoryPath),conditionLabel:text(indexes.conditionLabel),schedulingLabel:text(indexes.schedulingLabel),paymentPolicy:text(indexes.paymentPolicy),returnPolicy:text(indexes.returnPolicy),shippingPolicy:text(indexes.shippingPolicy)}];
 });
}

/** Expand saved multi-value summaries read-only; never select recommendations or save. */
export async function readV2BackgroundBulkSpecifics(dialog:Locator){
 const specifics=await dialog.evaluate(collectV2BackgroundBulkSpecificsDOM),aspects=dialog.locator('.individual-aspect');
 for(let index=0;index<await aspects.count();index++){
  const aspect=aspects.nth(index),name=(await aspect.locator('.individual-aspect__name').textContent())?.trim(),values=name?specifics[name]:undefined;
  if(!name||!values||values.length!==1)continue;const match=/^(.+)\s+\(\+(\d+)\)$/.exec(values[0]);if(!match)continue;
  const summary=aspect.locator('.individual-aspect__values__value').getByRole('button',{name:values[0],exact:true});if(await summary.count()!==1)throw Error('Exact multi-value saved aspect control required');await summary.click();
  const selected=dialog.locator('[role="menuitemcheckbox"][aria-checked="true"]:visible');await selected.first().waitFor({state:'visible'});
  const loading=dialog.getByRole('img',{name:'Loading',exact:true});const deadline=Date.now()+12000;while(await loading.count()){const remaining=deadline-Date.now();if(remaining<=0)throw Error('Saved aspect is still loading');await loading.first().waitFor({state:'hidden',timeout:remaining});}
  const menus=await dialog.evaluate(element=>{const visible=(e:Element)=>!!(e as HTMLElement).getClientRects().length&&getComputedStyle(e).visibility!=='hidden';return Array.from(element.querySelectorAll('[role="menu"]')).filter(visible).map(menu=>({options:Array.from(menu.querySelectorAll('[role="menuitemcheckbox"]')).filter(visible).map(e=>({label:(e.getAttribute('aria-label')??e.textContent??'').trim(),checked:e.getAttribute('aria-checked')==='true'?true:e.getAttribute('aria-checked')==='false'?false:null}))}));});
  const actual=normalizeV2SavedAspectMenus(menus,match[1],Number(match[2]));
  specifics[name]=actual;await selected.first().press('Escape');await selected.first().waitFor({state:'hidden'});
 }
 return specifics;
}
export function collectV2BackgroundBulkSpecificsDOM(dialog:HTMLElement|SVGElement){
 const result:Record<string,string[]>={};
 for(const aspect of Array.from(dialog.querySelectorAll('.individual-aspect'))){
  const name=aspect.querySelector('.individual-aspect__name')?.textContent?.trim();if(!name)throw Error('Actual aspect name required');if(Object.hasOwn(result,name))throw Error('Ambiguous repeated actual aspect');
  const value=aspect.querySelector('.individual-aspect__values__value');if(!value){result[name]=[];continue;}
  const inputs=Array.from(value.querySelectorAll('input:not([type=checkbox]):not([type=hidden]),textarea')).map(e=>(e as HTMLInputElement).value.trim()).filter(Boolean);
  const buttons=Array.from(value.querySelectorAll('.btn__text')).map(e=>e.textContent?.trim()??'').filter(Boolean);
  // Recommendations are siblings outside __values__value, and are excluded.
  result[name]=Array.from(new Set([...inputs,...buttons]));
 }
 for(const aspect of Array.from(dialog.querySelectorAll('.custom-aspect'))){const controls=Array.from(aspect.querySelectorAll('input')) as HTMLInputElement[];if(controls.length!==2||!controls[0].value.trim()||Object.hasOwn(result,controls[0].value.trim()))throw Error('One actual named custom aspect required');result[controls[0].value.trim()]=controls[1].value?[controls[1].value]:[];}
 return result;
}

/** Only the factual textarea is mutable; protect every other non-secret control. */
export function collectV2DescriptionProtectedDOM(body:HTMLElement|SVGElement){const fields=Array.from(body.querySelectorAll('input,textarea,select')).filter(e=>{const f=e as HTMLInputElement;const hiddenField=new Set(['title','customLabel','quantity','price','itemPrice','categoryId','condition','40001','paymentPolicyId','returnPolicyId','shippingPolicyId','scheduleListingSelection']).has(f.name)||f.name.startsWith('attributes.');return f.type!=='password'&&(f.type!=='hidden'||hiddenField)&&!(e.tagName==='TEXTAREA'&&f.name==='description');}).map(e=>{const f=e as HTMLInputElement;return{tag:e.tagName,name:f.name,id:f.id,type:f.type,value:f.value,checked:f.checked,disabled:f.disabled};});return{fields,choices:Array.from(body.querySelectorAll('button[name],[role=combobox]')).map(e=>({name:e.getAttribute('name'),label:e.getAttribute('aria-label'),value:e.getAttribute('value'),text:e.textContent})),category:Array.from(body.querySelectorAll('[data-testid*="category"],[id*="category"]')).map(e=>e.textContent),photos:Array.from(body.querySelectorAll('img')).map(e=>({src:e.getAttribute('src'),alt:e.getAttribute('alt')}))};}

/** Retry only an explicit read-only eBay field-load error, once; never a save/upload. */
export async function waitV2ReadonlyBulkFieldHeading(dialog:Locator,heading:string,onRetry:()=>Promise<void>,timeout=20000){
 const expected=dialog.getByRole('heading',{name:new RegExp('^'+heading+'(?: Close)?$'),level:2}).first(),retry=dialog.getByRole('button',{name:'Try again',exact:true});
 const outcome=await Promise.race([expected.waitFor({state:'visible',timeout}).then(()=>'ready'),retry.waitFor({state:'visible',timeout}).then(()=>'retry')]);
 if(outcome==='ready')return;
 if(await dialog.getByText('Something went wrong',{exact:true}).count()!==1||await retry.count()!==1)throw Error('Unsupported field-load error; no retry performed');
 await onRetry();await retry.click();await expected.waitFor({state:'visible',timeout});
}

/** Seller Hub can display identical Selected and option menus together. Their
 * independently selected sets must agree; conflicting/partial menus fail closed. */
export function normalizeV2SavedAspectMenuGroups(groups:string[][],first:string,additional:number){
 if(!groups.length||!Number.isSafeInteger(additional)||additional<1)throw Error('Actual expanded aspect menu required');const expected=additional+1,keys=groups.map(values=>{if(values.length!==expected||values.some(v=>!v)||new Set(values).size!==values.length||!values.includes(first))throw Error('Expanded saved aspect count or values differ from its summary');return JSON.stringify(values.slice().sort());});if(keys.some(key=>key!==keys[0]))throw Error('Conflicting selected saved aspect menus');return groups[0].slice();
}

/** A separate available-options menu can contain only unchecked candidates.
 * It cannot contradict a selected value or replace any expected selection. */
export function normalizeV2SavedAspectMenus(menus:Array<{options:Array<{label:string;checked:boolean|null}>}>,first:string,additional:number){
 if(!menus.length||menus.some(m=>!m.options.length||m.options.some(o=>!o.label||o.checked===null)||new Set(m.options.map(o=>o.label)).size!==m.options.length))throw Error('Actual complete saved aspect menus required');
 const selectedGroups=menus.map(m=>m.options.filter(o=>o.checked===true).map(o=>o.label)).filter(values=>values.length),selected=normalizeV2SavedAspectMenuGroups(selectedGroups,first,additional);
 for(const menu of menus)if(menu.options.every(o=>o.checked===false)&&menu.options.some(o=>selected.includes(o.label)))throw Error('Unchecked available menu contradicts selected saved aspect');
 return selected;
}

/** Compare persisted controls exactly; normalize only observed category render
 * whitespace and the exact deferred-shipping validator text beside an empty '-'.
 * Raw collector values and retained evidence are never changed. */
export function sameV2BackgroundBulkProtectedValues(before:ReturnType<typeof collectV2BackgroundBulkProtectedDOM>,after:ReturnType<typeof collectV2BackgroundBulkProtectedDOM>){
 const normalize=(raw:ReturnType<typeof collectV2BackgroundBulkProtectedDOM>)=>({...raw,rows:raw.rows.map(row=>({...row,category:row.category.replace(/\s+/g,' ').trim().replace(/^Trading Card Singles\s*in\s+/,'Trading Card Singles in '),shipping:row.shipping==='-Please add at least one valid shipping service option to your listing.'?'-':row.shipping}))});
 if(!before||!after||!Array.isArray(before.rows)||!Array.isArray(after.rows))return false;return JSON.stringify(normalize(before))===JSON.stringify(normalize(after));
}
