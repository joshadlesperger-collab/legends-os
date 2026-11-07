export type AdmissionAttempt={ok:boolean;diagnostic?:{category:string;httpStatus:number|null;quota?:{daily:boolean;zeroLimit:boolean};retryAfterMs?:number}};
/** Caller must journal each attempt before sending. No implicit SDK retries or unbounded loops. */
export async function admitGenerationProvider(
 attempt:(index:number)=>Promise<AdmissionAttempt>,
 options:{maxAttempts?:number;sleep?:(ms:number)=>Promise<void>;random?:()=>number}={},
){
 const maximum=options.maxAttempts??3;
 if(!Number.isInteger(maximum)||maximum<1||maximum>3)throw Error('Admission permits one to three explicit attempts');
 const sleep=options.sleep??(ms=>new Promise(resolve=>setTimeout(resolve,ms)));
 const random=options.random??Math.random;const attempts:AdmissionAttempt[]=[];
 for(let index=0;index<maximum;index++){
  // Journal refusal must propagate: never retry a call which was not durably admitted.
  const result=await attempt(index);attempts.push(result);
  if(result.ok)return {ready:true,attempts};
  const status=result.diagnostic?.httpStatus;
  const transient=status===408||status===429||(status!==null&&status!==undefined&&status>=500&&status<=599)||result.diagnostic?.category==='timeout-or-abort';
  if(!transient||index===maximum-1||result.diagnostic?.quota?.daily||result.diagnostic?.quota?.zeroLimit)break;
  const delay=Math.max(result.diagnostic?.retryAfterMs??0,1000*2**index+Math.floor(Math.max(0,Math.min(1,random()))*250));
  if(delay>60000)break;
  await sleep(delay);
 }
 return {ready:false,attempts};
}
