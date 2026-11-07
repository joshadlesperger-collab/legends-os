/** Bounded parsed-content cache. Callers must still read and validate each source.
 * Limits bound retained source text, not total JavaScript heap size. */
export function backlogJsonCache(maxCharacters=32_000_000,maxEntryCharacters=16_000_000,maxEntries=8) {
  const entries=new Map<string,{text:string,value:unknown}>();
  let characters=0;
  function freeze(value:unknown):unknown {
    if(value&&typeof value==="object"){
      for(const child of Object.values(value))freeze(child);
      Object.freeze(value);
    }
    return value;
  }
  return (key:string,text:string):unknown=>{
    const previous=entries.get(key);
    if(previous?.text===text){entries.delete(key);entries.set(key,previous);return previous.value;}
    if(previous){entries.delete(key);characters-=previous.text.length;}
    const value=JSON.parse(text);
    if(text.length>maxEntryCharacters||text.length>maxCharacters||maxEntries<1)return value;
    freeze(value);
    while(entries.size>=maxEntries||characters+text.length>maxCharacters){
      const oldest=entries.keys().next().value!;characters-=entries.get(oldest)!.text.length;entries.delete(oldest);
    }
    entries.set(key,{text,value});characters+=text.length;
    return value;
  };
}
