import type {PriceCheckRow} from './card-processing-v2-price-check.ts';
export const V2_PUBLICATION_POLICY={version:'manual-10pct-delivered-v1',thresholdPercent:10,manualControl:true,transportReady:false,reason:'Native saved-draft publishing is not connected.'} as const;
export type V2PublicationAssessment={status:'eligible'|'review'|'blocked';gapBasisPoints:number|null;withinThreshold:boolean|null;reasons:string[];permission:'authorized';transportReady:boolean};
/** Pure manual-button admission. No repricing, offers, scheduling or provider writes. */
export function assessV2Publication(row:PriceCheckRow,transportReady=false):V2PublicationAssessment{
 const ours=row.ourTotalCents,lowest=row.lowestComp?.totalCents??null,valid=(v:number|null):v is number=>v!==null&&Number.isSafeInteger(v)&&v>0;
 const known=valid(ours)&&valid(lowest),withinThreshold=known?BigInt(Math.abs(ours-lowest))*BigInt(10)<=BigInt(lowest):null,gapBasisPoints=known?Math.round(Math.abs(ours-lowest)*10000/lowest):null,reasons:string[]=[];let blocked=false,review=false;
 if(!known){blocked=true;reasons.push('Current delivered price and a matching active asking price are required.');}
 if(withinThreshold===false){review=true;reasons.push('The unchanged current delivered price is outside 10% of the lowest matching active ask.');}
 if(!row.current||row.current.source!=='retained-ebay-observation'){review=true;reasons.push('A fresh actual saved-draft price observation is required; manual preview prices cannot authorize publication.');}
 if(row.current){const age=Date.now()-Date.parse(row.current.observedAt);if(!Number.isFinite(age)||age<0||age>600000){blocked=true;reasons.push('The saved-draft price observation is stale or invalid; refresh before publication.');}}
 const hard=new Set(['unknown-price','below-item-floor','identity-conflict','provider-error','no-comp']);
 for(const flag of row.flags){if(hard.has(flag)){blocked=true;reasons.push(`Resolve ${flag.replaceAll('-',' ')} before publication.`);}else if(flag==='comp-uncertain'||flag==='watcher-floor'){review=true;reasons.push(`Review ${flag.replaceAll('-',' ')} before publication.`);}}
 if(row.lowestComp?.confidence==='title-supported'){review=true;reasons.push('The active ask relies on title-supported identity; uncertain matches remain in review.');}
 if(row.currentItemCents===null||row.currentItemCents<149){blocked=true;reasons.push('The saved item price must meet the $1.49 floor.');}
 if(row.shippingCents===null){blocked=true;reasons.push('Saved buyer shipping is unknown.');}
 if(row.watcherItemCents!==null&&row.watcherItemCents<149){review=true;reasons.push('The projected watcher offer breaches the $1.49 item-price floor.');}
 if(!transportReady){blocked=true;reasons.push(V2_PUBLICATION_POLICY.reason);}
 return{status:blocked?'blocked':review?'review':'eligible',gapBasisPoints,withinThreshold,reasons:Array.from(new Set(reasons)),permission:'authorized',transportReady};
}
