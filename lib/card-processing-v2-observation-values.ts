/** Known editor URL aliases, observed in legacy and current Seller Hub editors.
 * More than one ID parameter is ambiguous even if both happen to agree. */
export function observedV2DraftId(value: string): string | null {
  let url: URL; try { url = new URL(value); } catch { return null; }
  if (url.protocol !== "https:" || url.hostname !== "www.ebay.com" || url.port || url.username || url.password || url.hash) return null;
  const ids: string[] = [];
  for (const [key, id] of Array.from(url.searchParams.entries())) {
    if (key === "draft_id" || key === "draftId") ids.push(id);
    else if (key.replace(/_/g, "").toLowerCase() === "draftid") return null;
  }
  return ids.length === 1 && /^\d+$/.test(ids[0]) ? ids[0] : null;
}

/** Seller Hub appends usage counts to policy choices. Those presentation counts
 * are not part of the policy name. Numeric policy IDs and all other parentheses
 * remain intact and must be bound independently to the actual selected ID. */
export function observedV2PolicyName(value: string): string {
  return value.trim().replace(/\s+(?:\[(?:\d+|\d{1,3}(?:,\d{3})+)\s+listings?\]|\((?:\d+|\d{1,3}(?:,\d{3})+)\s+listings?\))$/i, "").trim();
}

/** Rendered text may wrap a label/value over lines. Keep the exact observed
 * label and value; only presentation whitespace differs from native AX. */
export function observedV2NearMintCondition(ax:string):boolean {
 return /Card Condition\s+Near mint or better:/.test(ax);
}
/** Return-policy punctuation differs between native AX and rendered text.
 * Preserve the exact label and independently encoded policy ID. Conflicting
 * selected summaries never become a passing observation. */
export function observedV2NoReturnsPolicy(ax:string):boolean {
 const choices=Array.from(ax.matchAll(/Return policy[ \t]*:[ \t]*([^\r\n]*)/g),m=>observedV2PolicyName(m[1].replace(/, Secondary Actions:.*$/, '').trim()));
 return choices.length>0&&choices.every(value=>value==='No Return Accepted (248164940010)');
}

/** Read the actual expanded legacy Features menu, never its (+N) summary. */
export function observedV2SemanticFeatures(snapshot:unknown):{observed:boolean;values:string[]}{
 const no={observed:false,values:[] as string[]};if(typeof snapshot!=='string')return no;
 const lines=snapshot.split('\n'),features=lines.flatMap((l,i)=>/^\s*- button "Features"$/.test(l)?[i]:[]),selected=lines.flatMap((l,i)=>/^\s*- menu "Selected List of selected values":$/.test(l)?[i]:[]);
 if(features.length!==1||selected.length!==1||selected[0]<=features[0])return no;
 const before=lines.slice(features[0]+1,selected[0]);const firstButton=before.find(l=>/^\s*- button /.test(l));if(!firstButton||!firstButton.includes('[expanded]'))return no;if(before.filter(l=>/^-?\s*-?\s*button .*\[expanded\]/.test(l.trim())).length!==1)return no;
 const at=selected[0],indent=lines[at].search(/\S/),entries:string[]=[];let end=at+1;
 for(;end<lines.length&&lines[end].search(/\S/)>indent;end++){const m=/^\s*- menuitemcheckbox "([^"\r\n]+)"( \[checked\])?$/.exec(lines[end]);if(!m||!m[2])return no;entries.push(m[1]);}
 if(!entries.length||new Set(entries).size!==entries.length)return no;
 // If All options is also rendered, its explicit states must agree.
 const all=lines.findIndex((l,i)=>i>=end&&/^\s*- menu "All options/.test(l));if(all>=0){const depth=lines[all].search(/\S/),states=new Map<string,boolean>();for(let i=all+1;i<lines.length&&lines[i].search(/\S/)>depth;i++){const m=/^\s*- menuitemcheckbox "([^"\r\n]+)"( \[checked\])?$/.exec(lines[i]);if(!m||states.has(m[1]))return no;states.set(m[1],!!m[2]);}if(entries.some(v=>states.get(v)!==true)||Array.from(states).some(([v,on])=>on&&!entries.includes(v)))return no;}
 return{observed:true,values:entries};
}

