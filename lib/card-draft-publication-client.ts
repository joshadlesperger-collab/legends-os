export function manualDraftPrice(value:string):{itemCents?:number;error?:string}{
 const text=value.trim();if(!text)return{};
 if(!/^\d{1,7}(?:\.\d{1,2})?$/.test(text))return{error:'Enter a dollar price with at most two decimals.'};
 const [dollars,cents='']=text.split('.'),itemCents=Number(dollars)*100+Number(cents.padEnd(2,'0'));
 if(!Number.isSafeInteger(itemCents)||itemCents<149||itemCents>100_000_000)return{error:'Item price must be between $1.49 and $1,000,000.00.'};
 return{itemCents};
}

export function draftDeliveredDelta(ourTotal:number|null|undefined,theirTotal:number|null|undefined){
 return typeof ourTotal==='number'&&Number.isSafeInteger(ourTotal)&&ourTotal>=0&&typeof theirTotal==='number'&&Number.isSafeInteger(theirTotal)&&theirTotal>=0?ourTotal-theirTotal:null;
}

/** Discount the delivered comp once, then subtract our unchanged shipping. */
export function discountedDraftPrice(lowestTotal:number|null|undefined,shipping:number|null|undefined,basisPoints=800):{itemCents?:number;totalCents?:number;error?:string}{
 if(typeof lowestTotal!=='number'||!Number.isSafeInteger(lowestTotal)||lowestTotal<0||typeof shipping!=='number'||!Number.isSafeInteger(shipping)||shipping<0)return{error:'A matching total and known shipping are required.'};
 if(!Number.isInteger(basisPoints)||basisPoints<0||basisPoints>10000)return{error:'Invalid discount.'};
 const totalCents=Math.round(lowestTotal*(10000-basisPoints)/10000),itemCents=totalCents-shipping;
 if(itemCents<149||itemCents>100_000_000)return{error:'Discounted BIN would be outside the $1.49–$1,000,000.00 limits.'};
 return{itemCents,totalCents};
}

export function subtotalDraftPrices(rows:Array<{ourTotalCents:number|null;lowestTotalCents:number|null}>){
 let totalCents=0,deltaCents=0,totalCount=0,deltaCount=0;
 for(const row of rows){if(typeof row.ourTotalCents==='number'&&Number.isSafeInteger(row.ourTotalCents)&&row.ourTotalCents>=0){totalCents+=row.ourTotalCents;totalCount++;}
  const delta=draftDeliveredDelta(row.ourTotalCents,row.lowestTotalCents);if(delta!==null){deltaCents+=delta;deltaCount++;}}
 return{totalCents:totalCount?totalCents:null,deltaCents:deltaCount?deltaCents:null,totalCount,deltaCount,count:rows.length};
}

export function ignoredDraftPreferences(raw:string|null,allowedIds:string[]){
 try{const values:unknown=JSON.parse(raw??'[]');if(!Array.isArray(values)||values.length>10000||values.some(v=>typeof v!=='string'))return{};
  const allowed=new Set(allowedIds);return Object.fromEntries(values.filter(id=>allowed.has(id)).map(id=>[id,true])) as Record<string,boolean>;
 }catch{return{};}
}
