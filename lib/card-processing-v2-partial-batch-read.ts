export type V2RetainedBatchReadRow={draftId:string;sku:string;evidence:{path:string;sha256:string}};
/** Only completed, persisted rows survive a modal read failure. This carries no
 * assertion of verification; each row still enters the unchanged strict gate. */
export class V2PartialSavedBatchReadError extends Error{
 readonly observations:V2RetainedBatchReadRow[];
 readonly errorEvidence:{path:string;sha256:string};
 constructor(observations:V2RetainedBatchReadRow[],errorEvidence:{path:string;sha256:string}){super('Saved batch row reading interrupted; completed retained observations remain available');this.name='V2PartialSavedBatchReadError';this.errorEvidence={...errorEvidence};this.observations=observations.map(o=>({draftId:o.draftId,sku:o.sku,evidence:{...o.evidence}}));}
}
