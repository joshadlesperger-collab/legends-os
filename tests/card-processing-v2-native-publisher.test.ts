import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium,type Page} from 'playwright-core';
import {createV2NativePublisher,collectV2NativePublishedActiveDOM,V2NativePublishUncertainError,type V2NativePublishTarget} from '../lib/card-processing-v2-native-publisher.ts';

const target:V2NativePublishTarget={draftId:'5299552590222',sku:'V2-'+('a'.repeat(24)),title:'Fixture Prizm Basketball Card',quantity:1,itemCents:179,shippingCents:149};
const escape=(s:string)=>s.replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;');
const money=(v:number)=>(v/100).toFixed(2);
type FixtureOptions={fees?:string;changedBaseline?:boolean;mutateQuantity?:boolean;confirmationCount?:number;ambiguousActivePrice?:boolean;showActive?:boolean};
async function fixture(options:FixtureOptions,fn:(x:{page:Page;root:string;submits:()=>number;price:()=>string})=>Promise<void>){
 const executable=process.env.LEGENDS_BROWSER_EXECUTABLE??'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';await fs.access(executable);
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'v2-native-publish-')),browser=await chromium.launch({executablePath:executable,headless:true});let submits=0,price='1.79';
 try{const page=await browser.newPage();await page.route('**/*',async route=>{
  const u=new URL(route.request().url());assert.equal(u.origin,'https://www.ebay.com','Every browser request stays intercepted within the fixture');
  if(u.pathname==='/fixture-published'){submits++;price=u.searchParams.get('price')??'';return route.fulfill({status:200,contentType:'application/json',body:'{}'});}
  let html='';
  if(u.pathname==='/sh/lst/drafts')html=`<p>Seller Hub imaydit58</p><h2>Results:1-1 of 1</h2><table><thead><tr>${['Actions','Title','Custom label (SKU)','Buy It Now','Available Quantity','Format','Duration','Shipping cost'].map(h=>`<th>${h}</th>`).join('')}</tr></thead><tbody><tr><td><input id="shui-dt-checkone-${target.draftId}" type="checkbox" aria-label="Select this item for performing bulk action - ${target.title}"><a href="/sl/list?draft_id=${target.draftId}">Resume draft</a></td><td>${target.title}</td><td>${target.sku}</td><td>$${options.changedBaseline?'9.99':'1.79'}</td><td>1</td><td>Buy It Now</td><td>Good 'Til Cancelled</td><td>$1.49</td></tr></tbody></table><button onclick="location.href='/bulksell?workspaceId=12345'">Resume drafts</button>`;
  else if(u.pathname==='/bulksell')html=`<table aria-label="This grid shows the drafts you are currently editing."><thead><tr>${['Selection','Title','Custom label (SKU)','Available quantity','Buy It Now','Shipping policy','Other protected field'].map(h=>`<th>${h}</th>`).join('')}</tr></thead><tbody><tr><td><input type="checkbox" id="draft-checkbox-${target.draftId}"></td><td><input aria-label="Title" value="${escape(target.title)}"></td><td><input aria-label="Custom label (SKU)" value="${target.sku}"></td><td><input id="native-quantity" aria-label="Available quantity" value="1"></td><td><input id="native-price" aria-label="Buy It Now" value="1.79" ${options.mutateQuantity?'oninput="document.getElementById(\'native-quantity\').value=2"':''}></td><td>PWE - $1.49</td><td><input aria-label="Protected value" value="preserve"></td></tr></tbody></table><button onclick="document.querySelector('#fees').hidden=false">Submit (1)</button><div role="dialog" aria-label="Review fees" id="fees" hidden><h2>Review fees</h2><p>1 listing to submit</p><p>Estimated selling fees: $${options.fees??'0.00'}</p><p>Listing fee $${options.fees??'0.00'}</p><p>By selecting Submit you accept the eBay User Agreement and Payment Terms of Use.</p><button onclick="fetch('/fixture-published?price='+encodeURIComponent(document.getElementById('native-price').value),{method:'POST'}).then(()=>{document.querySelector('#fees').hidden=true;document.querySelector('#confirmation').hidden=false})">Submit</button></div><div role="dialog" aria-label="Confirmation" id="confirmation" hidden><h2>Confirmation</h2><p>${options.confirmationCount??1} listing${options.confirmationCount===1||options.confirmationCount===undefined?' is':'s are'} now live</p><p>Total estimated fees: $0.00</p></div>`;
  else if(u.pathname==='/sh/lst/active')html=`<p>Seller Hub imaydit58</p><table><thead><tr>${['Item','Custom label (SKU)','Current price','Available quantity','Shipping cost'].map(h=>`<th>${h}</th>`).join('')}</tr></thead><tbody>${submits||options.showActive?`<tr><td><a href="https://www.ebay.com/itm/128180067068">${target.title}</a></td><td>${target.sku}</td><td><strong>$${price}</strong><div>Buy It Now</div><button>Research prices</button>${options.ambiguousActivePrice?'<span>$9.99 original</span>':''}</td><td>1</td><td>$1.49</td></tr>`:''}</tbody></table>`;
  else throw Error('No live navigation allowed in fixture: '+u.pathname);
  return route.fulfill({status:200,contentType:'text/html',body:html});
 });await fn({page,root,submits:()=>submits,price:()=>price});}finally{await browser.close();assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('v2-native-publish-'));await fs.rm(root,{recursive:true,force:true});}
}

test('native selected publication uses existing draft, explicit manual item price, zero fees and exact live acknowledgement',()=>fixture({},async f=>{
 const phases:string[]=[],publisher=createV2NativePublisher({page:f.page,evidenceDir:f.root,checkpoint:async p=>{phases.push(p);},acceptDisplayedAgreements:async proof=>{assert.ok((await fs.readFile(proof.path,'utf8')).includes('eBay User Agreement'));return true;}});
 const result=await publisher.publish({requestId:'fixture-request-1',targets:[{...target,manualItemCents:249}]});
 assert.equal(f.submits(),1);assert.equal(f.price(),'2.49');assert.equal(result.rows[0].itemId,'128180067068');assert.equal(result.rows[0].itemCents,249);assert.equal(result.rows[0].shippingCents,149);assert.deepEqual(phases,['before-price-edit','before-final-submit','publish-acknowledged','active-verified']);
 await assert.rejects(publisher.publish({requestId:'fixture-request-1',targets:[target]}),/replay is prohibited/);assert.equal(f.submits(),1);
}));

test('blank manual price preserves saved item price and no price-edit checkpoint occurs',()=>fixture({},async f=>{
 const phases:string[]=[],publisher=createV2NativePublisher({page:f.page,evidenceDir:f.root,checkpoint:async p=>{phases.push(p);},acceptDisplayedAgreements:async()=>true});
 const result=await publisher.publish({requestId:'fixture-request-2',targets:[target]});assert.equal(result.rows[0].itemCents,179);assert.equal(f.price(),'1.79');assert.ok(!phases.includes('before-price-edit'));
}));

test('displayed agreement denial and nonzero listing fees prevent final submission',async()=>{
 for(const options of [{fees:'1.00'},{}])await fixture(options,async f=>{const publisher=createV2NativePublisher({page:f.page,evidenceDir:f.root,checkpoint:async()=>undefined,acceptDisplayedAgreements:async()=>false});await assert.rejects(publisher.publish({requestId:'fixture-request-3',targets:[target]}),/zero listing fees|explicit approval/);assert.equal(f.submits(),0);});
});

test('fresh saved-price mismatch prevents opening or submitting the native bulk workspace',()=>fixture({changedBaseline:true},async f=>{
 const publisher=createV2NativePublisher({page:f.page,evidenceDir:f.root,checkpoint:async()=>undefined,acceptDisplayedAgreements:async()=>true});await assert.rejects(publisher.publish({requestId:'fixture-request-4',targets:[target]}),/saved draft identity, price/);assert.equal(f.submits(),0);assert.equal(new URL(f.page.url()).pathname,'/sh/lst/drafts');
}));

test('ambiguous confirmation is uncertain and cannot replay the same request',()=>fixture({confirmationCount:2},async f=>{
 const publisher=createV2NativePublisher({page:f.page,evidenceDir:f.root,checkpoint:async()=>undefined,acceptDisplayedAgreements:async()=>true});await assert.rejects(publisher.publish({requestId:'fixture-request-5',targets:[target]}),V2NativePublishUncertainError);assert.equal(f.submits(),1);await assert.rejects(publisher.publish({requestId:'fixture-request-5',targets:[target]}),/replay is prohibited/);assert.equal(f.submits(),1);
}));

test('manual item editing cannot change another protected native field',()=>fixture({mutateQuantity:true},async f=>{
 const publisher=createV2NativePublisher({page:f.page,evidenceDir:f.root,checkpoint:async()=>undefined,acceptDisplayedAgreements:async()=>true});await assert.rejects(publisher.publish({requestId:'fixture-request-6',targets:[{...target,manualItemCents:249}]}),/identity\/quantity differs|non-price bulk field changed/);assert.equal(f.submits(),0);
}));

test('active price extraction accepts actual Buy It Now/research labels and rejects multiple amounts',async()=>{
 for(const ambiguousActivePrice of [false,true])await fixture({showActive:true,ambiguousActivePrice},async f=>{await f.page.goto('https://www.ebay.com/sh/lst/active');if(ambiguousActivePrice)await assert.rejects(f.page.locator('body').evaluate(collectV2NativePublishedActiveDOM),/unambiguous actual USD/);else assert.equal((await f.page.locator('body').evaluate(collectV2NativePublishedActiveDOM))[0].price,'$1.79');assert.equal(f.submits(),0);});
});
