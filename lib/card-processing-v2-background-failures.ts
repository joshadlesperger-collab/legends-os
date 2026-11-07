/** Public diagnostics are finite labels, never raw browser/provider exceptions. */
const messages:Record<string,string>={VERIFICATION_REQUIRED:'Complete the eBay verification in the separate Legends OS browser. Automatic challenge handling is disabled.',SIGN_IN_REQUIRED:'Sign in to imaydit58 in the separate Legends OS browser.',UNSUPPORTED_PAGE:'The eBay page layout is unsupported. Existing work is preserved.',AGREEMENT_REQUIRED:'The displayed agreement needs the retained seller authorization.',UPLOAD_UNCERTAIN:'The upload outcome is uncertain. Reconcile that same upload before any retry.',BROWSER_BUSY:'The dedicated browser is already processing another operation.'};
export function v2BackgroundFailure(error:unknown,phase:string){
 const raw=error&&typeof error==='object'&&'code' in error?error.code:undefined;
 const code=typeof raw==='string'&&Object.hasOwn(messages,raw)?raw:phase==='archiving'?'SAVED_FIELDS_OR_ARCHIVE':phase==='reconciliation'?'INVENTORY_OR_POLICY_SOURCE':phase==='preparing'?'PREPARATION_CHECKPOINT':'BACKGROUND_OPERATION';
 const detail=messages[code]??(code==='SAVED_FIELDS_OR_ARCHIVE'?'Saved fields or exact photo archival need recovery. The existing draft is preserved.':code==='INVENTORY_OR_POLICY_SOURCE'?'An inventory or policy source is incomplete, ambiguous or unavailable. No new draft is cleared.':code==='PREPARATION_CHECKPOINT'?'Preparation needs recovery from its retained identification and photo checkpoints.':'Background processing needs recovery from its retained checkpoint.');
 return{code,phase,detail,reuploadAllowed:false,canPublish:false};
}
/** Retained local schema diagnostics omit messages, inputs, enum values and
 * provider/browser objects. Only finite issue metadata may cross this boundary. */
export function v2BackgroundSchemaDiagnostic(error:unknown){
 if(!error||typeof error!=='object'||!('name' in error)||error.name!=='ZodError'||!('issues' in error)||!Array.isArray(error.issues))return undefined;
 const allowed=new Set(['too_big','too_small','invalid_type','invalid_value','invalid_format','unrecognized_keys','custom','invalid_union','invalid_key','invalid_element','not_multiple_of']);
 return{issues:error.issues.slice(0,20).map((issue:unknown)=>{
  const row=issue&&typeof issue==='object'?issue as Record<string,unknown>:{},code=typeof row.code==='string'&&allowed.has(row.code)?row.code:'custom';
  const path=Array.isArray(row.path)?row.path.slice(0,8).map(p=>typeof p==='number'&&Number.isSafeInteger(p)&&p>=0?p:typeof p==='string'&&/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(p)?p:'[redacted]'):[];
  return{code,path,...(typeof row.maximum==='number'&&Number.isFinite(row.maximum)?{maximum:row.maximum}:{}),...(typeof row.minimum==='number'&&Number.isFinite(row.minimum)?{minimum:row.minimum}:{})};
 })};
}
