/** Client-safe names. Persisted timing owner IDs never belong in user labels. */
export function v2BrowserSubstepLabel(step:string):string|null{
 const name=/^browser-substep:[^:]+:(.+)$/.exec(step)?.[1];if(!name)return null;
 const labels:Record<string,string>={'editor-ready':'Wait for saved editor fields','local-finalize':'Verify and archive locally','local-checkpoint':'Persist operation checkpoint','navigation':'Open the saved draft','dom-read':'Read saved fields','ax-read':'Read page details','feature-expand':'Open feature choices','upload-ack':'Confirm file received','remote-processing':'Wait for eBay processing','selection':'Select the exact cards','save':'Save changed fields','local-validation':'Check captured evidence','evidence-retain':'Retain captured evidence','agent-gap':'Handoff/recovery'};
 return labels[name]??'Browser operation';
}

export const V2_TIMING_STEP_LABELS:Record<string,string>={'draft-match-snapshot':'Check unpublished drafts once','draft-match-plan':'Match retained card identities','draft-match-quantity-save':'Save combined draft quantities','draft-match-quantity-reconcile':'Recover saved quantity acknowledgement','draft-match-finalize':'Move matched photos and save completion','browser-saved-grid-readback':'Check saved bulk result table','batch-start-readiness':'Check selection, media and seller before starting','selected-media-preflight':'Validate all selected original images before paid calls'};
