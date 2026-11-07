/** A JavaScript timeout cannot cancel a native browser operation. Timed-out
 * promises stay fenced until they settle or the operator isolates/rebinds the
 * tab with retained proof. No upload/save/provider operations belong here. */
const sessions=new WeakMap();let sequence=0;
export class V2BrowserAttemptError extends Error{constructor(message,snapshot){super(message);this.name='V2BrowserAttemptError';this.snapshot=snapshot;}}
const validMs=(value,fallback,max)=>{const n=value??fallback;if(!Number.isFinite(n)||n<=0||n>max)throw Error('Bounded browser deadline required');return n;};
function stateFor(tab){let s=sessions.get(tab);if(!s){s={busy:false,pending:new Map(),needsRecovery:false,retired:false,retries:new Map(),last:null};sessions.set(tab,s);}return s;}
function snapshot(s){return{attemptId:s.last?.attemptId??null,draftId:s.last?.draftId??null,startedAt:s.last?.startedAt??null,busy:s.busy,pendingOperations:Array.from(s.pending.values()).map(p=>({step:p.step,startedAt:p.startedAt})),unknownInFlight:s.pending.size>0,needsRecovery:s.needsRecovery,retired:s.retired,retries:s.last?s.retries.get(s.last.draftId)??0:0,lastCheckpoint:s.last?.checkpoint??null};}
export function inspectV2BrowserAttempt(tab){return snapshot(stateFor(tab));}
export function beginV2BrowserAttempt(tab,draftId,options={}){
 if(options.deadline!==undefined&&!Number.isFinite(options.deadline))throw Error('Finite browser deadline required');
 const s=stateFor(tab);if(s.busy||s.pending.size||s.needsRecovery||s.retired)throw new V2BrowserAttemptError('Previous browser attempt must be reconciled before replay',snapshot(s));
 const stepTimeoutMs=validMs(options.stepTimeoutMs,20000,30000),cardTimeoutMs=validMs(options.cardTimeoutMs,40000,60000),now=performance.now(),deadline=Math.min(now+cardTimeoutMs,options.deadline??Infinity),wallDeadline=Date.now()+Math.max(0,deadline-now);
 if(deadline<=now)throw new V2BrowserAttemptError('Browser call deadline reached before next card',snapshot(s));
 const attemptId='v2-browser-'+Date.now()+'-'+(++sequence);s.busy=true;s.last={attemptId,draftId,startedAt:new Date().toISOString(),checkpoint:null};
 const failure=message=>{s.needsRecovery=true;return new V2BrowserAttemptError(message,snapshot(s));};
 return{attemptId,draftId,deadline,
  remaining:()=>Math.max(0,deadline-performance.now()),
  snapshot:()=>snapshot(s),
  checkpoint:ref=>{s.last.checkpoint=ref??{retained:true};},
  async run(step,operation){
   if(s.last.attemptId!==attemptId||s.pending.size||s.needsRecovery)throw failure('Unresolved browser operation prevents overlapping replay');
   const remaining=deadline-performance.now();if(remaining<=0)throw failure('Per-card or whole-call browser deadline reached');
   const limit=Math.min(stepTimeoutMs,remaining),key=Symbol(step),stepStarted=performance.now(),stepWallStarted=Date.now(),pending={step,startedAt:new Date().toISOString()};s.pending.set(key,pending);
   let timer;const operationPromise=Promise.resolve().then(operation);
   // Handle both late success and late rejection. Neither can resume this
   // capture, retain an observation, or trigger the next browser operation.
   const settled=operationPromise.then(value=>{s.pending.delete(key);return value;},error=>{s.pending.delete(key);throw error;});
   try{const value=await Promise.race([settled,new Promise((_,reject)=>{timer=setTimeout(()=>reject(failure('Browser operation exceeded its deadline; native cancellation is unconfirmed')),limit);})]);
    // A suspended/starved event loop may deliver a promise fulfillment before
    // its overdue timer. Independently reject that late success before any
    // observation retention, next operation or completion can follow.
    if(performance.now()-stepStarted>=limit||Date.now()-stepWallStarted>=limit||performance.now()>=deadline||Date.now()>=wallDeadline)throw failure('Browser operation settled after its deadline; reconcile before retry');
    return value;
   }
   catch(error){s.needsRecovery=true;throw error;}
   finally{clearTimeout(timer);}
  },
  fail(){s.needsRecovery=true;},
  finish(){s.busy=false;}
 };
}
function proof(s,p){const age=Date.now()-Date.parse(p?.observedAt);if(!s.last||p?.attemptId!==s.last.attemptId||p.draftId!==s.last.draftId||typeof p.checkpoint?.path!=='string'||!p.checkpoint.path||!/^[a-f0-9]{64}$/.test(p.checkpoint.sha256)||!Number.isFinite(age)||age<0||age>300000||!s.needsRecovery||s.busy||(s.retries.get(p.draftId)??0)>=1)throw new V2BrowserAttemptError('One fresh exact retained recovery proof is required',snapshot(s));}
export function confirmV2BrowserRecovery(tab,p){const s=stateFor(tab);proof(s,p);if(p.quiescent!==true||s.pending.size||s.retired)throw new V2BrowserAttemptError('Pending native operation has not settled; replay remains fenced',snapshot(s));s.retries.set(p.draftId,1);s.needsRecovery=false;return snapshot(s);}
export function rebindV2BrowserRecovery(oldTab,newTab,p){const old=stateFor(oldTab);proof(old,p);let u;try{u=new URL(p.observedUrl);}catch{throw Error('Actual rebound exact draft URL required');}const ids=['draftId','draft_id'].flatMap(k=>u.searchParams.getAll(k));if(newTab===oldTab||p.oldTabIsolated!==true||u.origin!=='https://www.ebay.com'||!['/lstng','/sl/list'].includes(u.pathname)||ids.length!==1||ids[0]!==p.draftId)throw Error('Explicit isolated rebound tab and same-ID observation required');const next=stateFor(newTab);if(next.busy||next.pending.size||next.needsRecovery||next.retired)throw Error('Rebound tab is not quiescent');old.retired=true;next.retries=new Map(old.retries);next.retries.set(p.draftId,1);return snapshot(next);}
