import Link from 'next/link';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {reviewSources,readOfferReview,type RemoteReview} from '@/lib/inventory-offer-review';
import {prisma} from '@/lib/prisma';
import {getValidAccessToken} from '@/lib/ebay';
export const dynamic='force-dynamic';
const drafts:Record<string,string>={'TEST-CSV-cactus13-0001':'5437023862813','TEST-CSV-cactus13-0010':'5435003346310'};
export default async function InventoryReview({searchParams}:{searchParams:Promise<{refresh?:string}>}){
 const params=await searchParams;
 let cards:ReturnType<typeof reviewSources>=[];
 let status='Local preparation evidence only. No saved Inventory API offer has been verified.';
 let remote:RemoteReview[]=[];
 try{cards=reviewSources(JSON.parse(await readFile(join(process.cwd(),'artifacts/bulk-import-proof-20261025/replacement-intent.json'),'utf8')));}catch{status='Source test packet missing or invalid. No cards can be reviewed.';}
 const configured=Boolean(process.env.DATABASE_URL&&process.env.TOKEN_ENCRYPTION_KEY&&process.env.EBAY_CLIENT_ID&&process.env.EBAY_CLIENT_SECRET);
 if(params.refresh==='1'&&cards.length){
  if(!configured)status='API review blocked: local database/OAuth settings are missing. Existing drafts are preserved.';
  else try{
   const stores=await prisma.store.findMany({where:{ebaySellerUsername:'imaydit58',isActive:true,connectionStatus:'connected'},take:2});
   if(stores.length!==1)throw Error('Seller connection ambiguous');
   const {accessToken}=await getValidAccessToken(stores[0]);
   remote=await readOfferReview(accessToken,cards.map(c=>c.sku));
   status='Read-only API refresh finished. Inspect each card’s results; missing offers do not authorize creation.';
  }catch{status='Database/OAuth access failed. No listing changes made. Restore the existing connection or reconnect through Stores.';}
 }
 return <main className="page" style={{maxWidth:1200}}>
  <nav><Link href="/stores">Connected stores</Link> · <Link href="/inventory">Inventory</Link></nav>
  <h1>Inventory API review</h1>
  <p>Two-card integration test · read only · publication and creation disabled</p>
  <p role="status" style={{padding:16,border:'1px solid #b88b42',borderRadius:8}}>{status}</p>
  <form method="get"><button name="refresh" value="1">Read saved API data</button></form>
  <p>These cards already have Seller Hub drafts. An absent API offer is not permission to create another copy. Local prepared fields below are not proof that eBay saved them. Prices are retained test inputs, not a fresh valuation.</p>
  {cards.map(card=>{const saved=remote.find(r=>r.sku===card.sku);return <article key={card.sku} style={{marginTop:24,padding:24,border:'1px solid #777',borderRadius:12}}>
   <h2>{card.title}</h2><p>{card.sku} · <a href={`https://www.ebay.com/lstng?draftId=${drafts[card.sku]}&mode=AddItem`} target="_blank" rel="noreferrer">Existing test draft {drafts[card.sku]}</a></p>
   <h3>Local prepared evidence</h3>
   <div style={{display:'flex',gap:16,flexWrap:'wrap'}}>{card.photos.map((p,i)=><img key={p} src={p} alt={`${card.title} — ${i===0?'front':'back'}`} style={{width:180,height:250,objectFit:'contain'}} />)}</div>
   <dl><dt>Item price / quantity</dt><dd>${card.price} / {card.quantity}</dd><dt>Condition</dt><dd>{card.condition||'Missing'}</dd><dt>Location</dt><dd>{card.location||'Missing'}</dd><dt>Shipping / payment / return policies requested</dt><dd>{card.policies.map((p,i)=><div key={i}>{p||'Missing'}</div>)}</dd></dl>
   <details><summary>Identity and prepared description</summary><table><tbody>{card.specifics.map(([k,v])=><tr key={k}><th style={{textAlign:'left',paddingRight:20}}>{k}</th><td>{v}</td></tr>)}</tbody></table><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{card.description}</pre></details>
   <h3>Saved Inventory API evidence</h3>
   {saved?<><p>{saved.status} · Read at {saved.checkedAt}</p>
    <dl><dt>Saved title</dt><dd>{saved.item?.title||'Not available'}</dd><dt>Saved condition / inventory quantity</dt><dd>{saved.item?.condition||'Not available'} / {saved.item?.quantity??'Not available'}</dd><dt>Saved image count</dt><dd>{saved.item?.photos?.length??'Not available'}</dd><dt>Offers returned</dt><dd>{saved.offers?.length??'Read failed'}</dd></dl>
    {saved.offers?.map((o,i)=><section key={o.id??i}><h4>Offer {o.id??'ID missing'} · {o.status??'Status missing'}</h4><dl><dt>Saved price</dt><dd>{JSON.stringify(o.price??'Missing')}</dd><dt>Offer quantity</dt><dd>{o.quantity??'Missing'}</dd><dt>Policy references</dt><dd>{JSON.stringify(o.policies??'Missing')}</dd><dt>Location key</dt><dd>{o.location||'Missing'}</dd></dl></section>)}
    <details><summary>Saved field evidence and HTTP results</summary><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{JSON.stringify(saved,null,2)}</pre></details></>:<p>Not read. No remote persistence or publish-readiness claim.</p>}
   <p><strong>Hold:</strong> existing draft representation; API persistence and duplicate clearance unverified.</p>
  </article>})}
  <h2>What changes for your review</h2><p>Review images, identity, price evidence, condition, quantity and policies here against saved API records. This test screen has no approve, edit or publish action. Those controls require a separate implementation. Inventory API listings must later be edited through the API, rather than Seller Hub.</p>
 </main>;
}
