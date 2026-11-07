import type {V2State} from './card-processing-v2.ts';

/** Unknown actual cost remains unknown; a validated full reservation can isolate its spending risk. */
export function v2IdentificationAccounting(calls:V2State['calls'],activeCalls=new Set<string>()) {
 let committedMicros=0,boundedPendingReservationMicros=0,unboundedPending=false;
 for(const call of calls){
  if(call.status==='settled'&&call.actualMicros!==null){committedMicros+=call.actualMicros;continue;}
  const b=call.bound,ceiling=b?Math.ceil(b.maxInputTokens*b.inputUsdPerMillion+b.maxOutputTokens*b.outputUsdPerMillion):NaN;
  const bounded=!!b&&!!b.authority&&!!b.pricingSource&&Number.isSafeInteger(ceiling)&&ceiling>0&&call.reservedMicros===ceiling
   &&!call.failure?.usageBoundExceeded&&(call.status==='uncertain'||call.status==='reserved'&&activeCalls.has(call.id));
  committedMicros+=call.reservedMicros;
  if(bounded)boundedPendingReservationMicros+=call.reservedMicros;else unboundedPending=true;
 }
 return {committedMicros,boundedPendingReservationMicros,pendingUsage:calls.some(c=>c.status!=='settled'||c.actualMicros===null),safe:!unboundedPending&&Number.isSafeInteger(committedMicros)&&Number.isSafeInteger(boundedPendingReservationMicros)};
}
