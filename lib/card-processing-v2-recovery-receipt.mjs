/** Distinguish retry receipts from raw observation evidence. A filename alone
 * never grants recovery; malformed claimed receipts remain fail-closed. */
export function classifyV2RecoveryRecord(value,filename){
 const object=value&&typeof value==='object'&&!Array.isArray(value),typed=object&&value.kind==='v2-readback-recovery-receipt',legacyName=/^(?:recovery-|recovery-receipt-|readback-recovery-receipt-)[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.json$/i.test(filename);
 const claimsReceipt=typed||legacyName||object&&('lease'in value||'recoveredAt'in value);
 if(!claimsReceipt)return{kind:'observation-evidence'};
 if(!object||typed&&value.version!==1||typeof value.draftId!=='string'||!/^\d+$/.test(value.draftId)||typeof value.lease?.attemptId!=='string'||!value.lease.attemptId||!Array.isArray(value.lease.draftIds)||!value.lease.draftIds.includes(value.draftId)||!Number.isFinite(Date.parse(value.lease.startedAt))||!Number.isFinite(Date.parse(value.recoveredAt))||typeof value.evidence?.path!=='string'||!value.evidence.path||!/^[a-f0-9]{64}$/.test(value.evidence.sha256))throw Error('Malformed prior recovery receipt; reconcile evidence before any retry');
 return{kind:'recovery-receipt',draftId:value.draftId,attemptId:value.lease.attemptId};
}
