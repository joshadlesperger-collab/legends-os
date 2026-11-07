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
