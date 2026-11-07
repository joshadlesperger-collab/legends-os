import { loadCardBacklog } from "./card-backlog-store.ts";
import { BacklogReadError } from "./card-backlog-errors.ts";
export async function readStableBacklog(load = loadCardBacklog) {
  for(let attempt=0;;attempt++) {
    try {return await load();}
    catch(error) {if(!(error instanceof BacklogReadError)||error.code!=="SOURCE_CHANGED"||attempt>=1)throw error;}
  }
}
let evidencePending:ReturnType<typeof loadCardBacklog>|undefined;
/** Coalesce concurrent grid/photo requests without scanning or hashing the whole inbox. */
export function localEvidence(){
  evidencePending??=readStableBacklog(()=>loadCardBacklog({scans:[]})).finally(()=>{evidencePending=undefined;});
  return evidencePending;
}
let pending: ReturnType<typeof loadCardBacklog> | undefined;
let recent: Awaited<ReturnType<typeof loadCardBacklog>> | undefined;
let at = 0;
export async function localBacklog(fresh = true) {
  if (!fresh && recent && Date.now() - at < 15000) return recent;
  pending ??= readStableBacklog().then(snapshot => { recent=snapshot;at=Date.now();return snapshot; }).finally(() => { pending=undefined; });
  return pending;
}
