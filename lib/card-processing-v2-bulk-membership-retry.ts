export type V2BulkMembershipEvidence={path:string;sha256:string};
/** Observed incomplete/duplicate workspace controls, not a claim about cause. */
export class V2BulkMembershipNotReadyError extends Error{
 readonly code='BULK_MEMBERSHIP_NOT_READY';
 readonly evidence:V2BulkMembershipEvidence;
 constructor(evidence:V2BulkMembershipEvidence){super('Shared workspace contains additional, missing or changed draft SKUs');this.name='V2BulkMembershipNotReadyError';this.evidence=evidence;}
}
/** One fresh read-only workspace attempt; never retries seller writes. */
export async function withV2FreshBulkMembershipRetry<T>(read:()=>Promise<T>,retainRetry:(error:V2BulkMembershipNotReadyError)=>Promise<void>):Promise<T>{
 try{return await read();}catch(error){if(!(error instanceof V2BulkMembershipNotReadyError))throw error;await retainRetry(error);return read();}
}
