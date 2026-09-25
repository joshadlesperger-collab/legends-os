import Link from "next/link";
import {prisma} from "@/lib/prisma";
import {getEbayApplicationAccessToken,searchBestMatchSample} from "@/lib/ebay-browse";
import {getValidAccessToken} from "@/lib/ebay";
import {getTrafficReport} from "@/lib/ebay-analytics";

export const dynamic="force-dynamic";
const PAGE_SIZE=50;
const money=(value:string|number|null|undefined)=>value==null?"Unavailable":`$${Number(value).toFixed(2)}`;

export default async function SearchVisibility({searchParams}:{searchParams?:{item?:string;q?:string}}){
  const item=(searchParams?.item??"").trim(),query=(searchParams?.q??"").trim().slice(0,100);
  const listing=item&&/^\d{8,15}$/.test(item)?await prisma.listing.findFirst({where:{ebayItemId:item,listingStatus:"active"},select:{ebayItemId:true,title:true,currentPrice:true,store:{select:{id:true,oauthAccessToken:true,oauthRefreshToken:true,tokenExpiresAt:true,connectionStatus:true}}}}):null;
  let results:Awaited<ReturnType<typeof searchBestMatchSample>>["items"]=[],total:number|null=null,position:number|null=null,error:string|null=null,traffic:Awaited<ReturnType<typeof getTrafficReport>>|null=null;
  if(listing&&query){
    try{
      const token=await getEbayApplicationAccessToken();
      for(let offset=0;offset<150;offset+=PAGE_SIZE){
        const page=await searchBestMatchSample(token,query,PAGE_SIZE,offset);
        if(offset===0)total=page.total;
        results.push(...page.items);
        const found=page.items.findIndex(row=>row.legacyItemId===item||row.itemId===item);
        if(found>=0){position=offset+found+1;break;}
        if(page.items.length<PAGE_SIZE)break;
      }
      if(listing.store.connectionStatus==="connected"){
        try{
          const accessToken=(await getValidAccessToken(listing.store)).accessToken;
          traffic=await getTrafficReport({accessToken,listingIds:[item],start:new Date(Date.now()-30*86400000),end:new Date()});
        }catch{/* Search sample remains usable when seller Analytics is unavailable. */}
      }
    }catch(e){error=e instanceof Error?e.message:"eBay search unavailable";}
  }
  const metric=traffic?.get(item),above=position?results.slice(0,position-1):[];
  const closest=above.filter(row=>row.price?.value&&Number(row.price.value)>0).slice(-10);
  return <main className="page"><header className="health-hero"><div><div className="eyebrow">Seller Opportunities · read-only</div><h1>Search visibility</h1><p>Check one owned listing against an exact buyer query in eBay US Best Match. The position is an API snapshot, not a universal rank or a count of buyer impressions.</p><Link href="/seller-opportunities/title-inspection">← Title inspection</Link></div></header>
    <section className="panel health-section"><form method="get" style={{display:"flex",gap:12,flexWrap:"wrap"}}><label>eBay item ID <input name="item" defaultValue={item} required pattern="[0-9]{8,15}"/></label><label>Buyer search <input name="q" defaultValue={query} required maxLength={100} placeholder="2023 Prizm Patrick Mahomes Silver PSA 10" style={{minWidth:320}}/></label><button type="submit" className="btn-primary">Check Best Match</button></form>
    {item&&!listing?<p>Enter an active listing ID from your connected inventory.</p>:null}{listing&&!query?<p>Listing: {listing.title}. Enter the words a buyer would actually search.</p>:null}{error?<p role="alert">Search could not be checked: {error}</p>:null}</section>
    {listing&&query&&!error?<><section className="panel health-section"><h2>{listing.title}</h2><p><b>Query:</b> {query} · <b>Observed:</b> {new Date().toLocaleString("en-US",{timeZone:"America/Chicago"})} CT · <b>Marketplace:</b> eBay US · <b>Sort:</b> default Best Match · <b>Filters:</b> none</p><p><strong>{position?`Position ${position} (results page ${Math.ceil(position/PAGE_SIZE)} at ${PAGE_SIZE} per page)`:`Not returned in first ${results.length} sampled results`}</strong>{total!=null?` · eBay reported approximately ${total} matching results`:""}</p><p>30-day listing impressions (search + store): {metric?.impressions??"Unavailable"} · Views: {metric?.views??"Unavailable"} · Click rate: {metric?.clickThroughRate??"Unavailable"}. These are across buyer activity, not specific to this query.</p><p>Search-result ads, buyer personalization, location, and browser display can differ from this API snapshot. No placement claim is made beyond the sampled results.</p></section>
    <section className="panel health-section"><h2>Listings ahead of yours</h2>{!position?<p>Comparable results below are the first ten sampled listings; your position beyond the sample is unknown.</p>:null}<div style={{overflowX:"auto"}}><table className="completeness-table"><thead><tr><th>Observed position</th><th>Listing</th><th>Item price</th><th>Seller</th></tr></thead><tbody>{(position?closest:results.slice(0,10)).map(row=><tr key={row.itemId}><td>{results.indexOf(row)+1}</td><td>{row.itemWebUrl?<a href={row.itemWebUrl} target="_blank" rel="noreferrer">{row.title}</a>:row.title}</td><td>{money(row.price?.value??row.currentBidPrice?.value)}</td><td>{row.seller?.username??"Unavailable"}</td></tr>)}</tbody></table></div><p>Compare exact card identity, grade, image, delivered price, shipping, and item specifics before changing a title or price. Item price alone excludes shipping.</p></section></>:null}
  </main>;
}
