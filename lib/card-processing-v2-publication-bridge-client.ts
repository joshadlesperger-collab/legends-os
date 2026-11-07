import {randomUUID} from 'node:crypto';
import type {V2NativePublicationTarget} from './card-processing-v2-selected-publication.ts';
import {V2_NATIVE_PUBLISHER_VERSION} from './card-processing-v2-selected-publication.ts';

const trustedHosts=new Set(['legends-os-beta.vercel.app','legends-os-legends17.vercel.app']);
export type V2PublicationClaim={id:string;reportId:string;targets:V2NativePublicationTarget[];leaseToken:string;leaseExpiresAt:string};
/** Existing operator login only. Password is sent solely to the allowlisted Legends login endpoint. */
export function createV2PublicationBridgeClient(site:string,password:string,deps:{fetch?:typeof fetch}={}){
 const base=new URL(site);if(base.protocol!=='https:'||!trustedHosts.has(base.hostname)||base.pathname!=='/'||base.search||base.hash||base.username||base.password||base.port)throw Error('The approved live Legends origin is required');
 if(!password)throw Error('The existing operator password is required');
 const request=deps.fetch??fetch;let cookie='',lane:Promise<unknown>=Promise.resolve();
 async function signIn(){const response=await request(new URL('/api/auth/login',base),{method:'POST',redirect:'manual',headers:{Origin:base.origin,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({password,next:'/card-processing-v2/price-check'}),signal:AbortSignal.timeout(20000)});
  const value=response.headers.get('set-cookie');if(response.status!==303||!value?.startsWith('legends_operator='))throw Error('Legends operator sign-in failed; no publisher action may continue');cookie=value.split(';')[0];}
 async function raw(action:Record<string,unknown>,retry=true):Promise<any>{if(!cookie)await signIn();const response=await request(new URL('/api/internal/card-processing-v2/publisher',base),{method:'POST',redirect:'manual',headers:{Origin:base.origin,Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify(action),signal:AbortSignal.timeout(20000)});
  if(response.status===401&&retry){cookie='';await signIn();return raw(action,false);}if(!response.ok)throw Error('Publication checkpoint was not accepted; stop before another remote action');return response.json();}
 const send=(action:Record<string,unknown>)=>{const work=lane.then(()=>raw(action));lane=work.catch(()=>undefined);return work;};
 return{workerId:randomUUID(),send,heartbeat:(workerId:string,status:'READY'|'BUSY'|'LOGIN_REQUIRED'|'ERROR',sellerObservedAt?:string)=>send({action:'heartbeat',workerId,seller:'imaydit58',version:V2_NATIVE_PUBLISHER_VERSION,status,...(sellerObservedAt?{sellerObservedAt}:{})}),
  claim:async(workerId:string):Promise<{job:V2PublicationClaim|null}>=>send({action:'claim',workerId})};
}
