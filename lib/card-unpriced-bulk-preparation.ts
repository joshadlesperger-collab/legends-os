import {createHash} from 'node:crypto';
import {draftFields} from './card-draft-fields.ts';
import {hasCompleteIdentity,identityReviewIsCurrent,reviewedIdentity,type QueueState} from './card-orchestrator.ts';
import {DRAFT_HEADERS,type HostedCardPhoto} from './card-bulk-draft.ts';

const quote=(value:string|number)=>`"${String(value).replace(/"/g,'""')}"`;
const categories:Record<string,string>={'Sports Trading Card Singles':'261328','CCG Individual Cards':'183454'};
/** Offline transport preparation only. No price approval, clearance, writer intent,
 * submission or receipt is manufactured. The priced exporter remains unchanged. */
export function prepareUnpricedBulkDraft(state:QueueState,ids:string[],hosted:HostedCardPhoto[],now=Date.now(),sellerHolds:Record<string,string>={}) {
  if(!ids.length||ids.length>50||new Set(ids).size!==ids.length)throw Error('Select 1–50 distinct exact card IDs');
  if(state.seller!=='imaydit58'||state.schemaVersion!==1)throw Error('Unsupported queue/account');
  const skus=new Set<string>(),fronts=new Set<string>(),serials=new Set<string>();
  const exceptions:{cardId:string;blockers:string[]}[]=[],rows:(string|number)[][]=[];
  const cards=[];
  for(const id of ids){
    const c=state.cards[id],i=c&&reviewedIdentity(c),blockers:string[]=[];
    if(!c){exceptions.push({cardId:id,blockers:['Card absent from current queue']});continue;}
    if(!i||!hasCompleteIdentity(i)||!identityReviewIsCurrent(c))blockers.push('Current complete original-photo and identity reviews required');
    if(c.input.knownDraft||c.input.knownLive||c.input.savedReceipts?.length||c.exclusion||c.draftLifecycle
      ||state.photoArchives?.[id]
      ||Object.values(state.bulkAiSubmissions??{}).some(b=>b.cardIds.includes(id))
      ||Object.values(state.draftCreationGroups??{}).some(g=>g.members.includes(id)))blockers.push('Existing receipt or creation history: reconcile/resume, never reimport');
    if(sellerHolds[id]||c.input.sourceHold)blockers.push('Seller/source hold retained');
    if(Object.values(c.jobs).some(j=>j.state==='leased'))blockers.push('Active or unresolved job lease retained');
    if(!c.input.sku||/^[\s]*[=+@-]/.test(c.input.sku)||skus.has(c.input.sku))blockers.push('Unsafe or duplicate SKU');
    skus.add(c.input.sku);
    const fields=draftFields(i??{});
    blockers.push(...fields.missing);
    if(/^[\s]*[=+@-]/.test(fields.title))blockers.push('Unsafe title');
    const serialKey=i?.serial?JSON.stringify([i.season,i.set,i.player,i.cardNumber,i.parallel,i.serial.replace(/^0+(?=\d)/,'')]):null;
    if(serialKey&&serials.has(serialKey))blockers.push('Repeated exact numbered identity');
    if(serialKey)serials.add(serialKey);
    // This bounded path emits one row per distinct numbered copy. Let the
    // established quantity planner handle matching unnumbered captures.
    if(i&&!i.serial)blockers.push('Unnumbered captures require the existing quantity-group planner before transport');
    const pair=['front','back'].map(side=>c.input.photos.filter(p=>p.side===side));
    if(pair.some(p=>p.length!==1))blockers.push('Exactly one original front/back pair required');
    const originals=pair.flat();
    const front=pair[0][0]?.sha256.toLowerCase();
    if(front&&fronts.has(front))blockers.push('Repeated original capture');
    if(front)fronts.add(front);
    const urls=originals.map(p=>{
      const candidates=hosted.filter(h=>h.originalHash.toLowerCase()===p.sha256.toLowerCase()&&h.uprightReviewed&&Date.parse(h.expiresAt)>now+86400000);
      const valid=candidates.find(h=>{try{const u=new URL(h.url);return u.protocol==='https:'&&!u.username&&!u.password&&!/[|\r\n]/.test(h.url)&&/(^|\.)ebayimg\.com$/i.test(u.hostname);}catch{return false;}});
      if(!valid)blockers.push(`Fresh upright eBay-hosted ${p.side} image required`);
      return valid?.url??'';
    });
    if(fields.condition!=='Near mint or better'||i?.conditionType&&i.conditionType!=='Ungraded')blockers.push('Reviewed raw NM condition required; condition exceptions need separate handling');
    const card={cardId:id,sku:c.input.sku,title:fields.title,quantity:1,identity:i,specifics:fields.specifics,
      condition:fields.condition,originals,item:null,shipping:null,pricingOwner:'Grok',
      description:null,descriptionOwner:'eBay description-only AI after verified title/specifics',
      entryBlockers:['Fresh active/drafts/scheduled/sold reconciliation','Supported pricing-defer and writer ownership/creation intent',
        'Persisted seller location/payment/no-return bindings','Same-ID save/reopen/photo verification and supported archive'],
      preparationBlockers:blockers};
    cards.push(card);
    if(blockers.length){exceptions.push({cardId:id,blockers});continue;}
    // Price and description deliberately blank. This template has no shipping charge.
    rows.push(['Draft',c.input.sku,categories[fields.category??'']??'',fields.title,'','',1,urls.join('|'),'4000','','FixedPrice']);
  }
  const transportCsv=rows.length?['#INFO,Version=0.0.2,Template= eBay-draft-listings-template_US,,,,,,,,',DRAFT_HEADERS.map(quote).join(','),...rows.map(r=>r.map(quote).join(','))].join('\r\n')+'\r\n':null;
  return {version:1,sourceRevision:state.revision,generatedAt:new Date(now).toISOString(),canUpload:false,canPublish:false,
    submissionReady:false,readinessScope:'offline-unpriced-transport-only',draftsCreated:0,physicalCards:cards.length,
    preparedRows:rows.length,pricing:'unresolved; no numeric placeholders',transportCsv,
    transportSha256:transportCsv?createHash('sha256').update(transportCsv).digest('hex'):null,cards,exceptions,
    warning:'Offline transport only; CSV validity is not live duplicate clearance, a saved draft, complete policy persistence or archive authority.'};
}
