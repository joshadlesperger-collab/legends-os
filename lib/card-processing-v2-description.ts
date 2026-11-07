import {v2FactualYear} from "./card-processing-v2-year.ts";
import type {V2Identity} from "./card-processing-v2.ts";
const normalize=(value:string)=>value.normalize("NFKD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim();
const contains=(text:string,fact:string)=>!fact.trim()||(` ${normalize(text)} `).includes(` ${normalize(fact)} `);
// eBay prose uses either noun inflection; keep every other variant word exact.
const containsVariant=(text:string,fact:string)=>contains(text.replace(/\bprizms\b/gi,"prizm"),fact.replace(/\bprizms\b/gi,"prizm"));
function readableDescription(value:string){
  let unsafe=false;
  const text=value.replace(/<[^>]*>/g,tag=>{const match=/^<\s*\/?\s*(p|div|br|span|b|i|strong|em|ul|ol|li)\b([^>]*)>$/i.exec(tag);if(!match){unsafe=true;return " ";}const attributes=match[2].replace(/\/\s*$/,"").trim();if(attributes&&!/^dir\s*=\s*(?:"(?:ltr|rtl|auto)"|'(?:ltr|rtl|auto)')$/i.test(attributes))unsafe=true;return " ";});
  if(/[<>]/.test(text))unsafe=true;
  const decoded=text.replace(/&(?:amp|nbsp|quot|apos|lt|gt|#\d+|#x[0-9a-f]+);/gi,entity=>{const named:Record<string,string>={amp:"&",nbsp:" ",quot:'"',apos:"'",lt:"<",gt:">"};const key=entity.slice(1,-1).toLowerCase();if(key in named)return named[key];const code=key.startsWith("#x")?parseInt(key.slice(2),16):parseInt(key.slice(1),10);if(code<1||code>0x10ffff||(code>=0xd800&&code<=0xdfff)){unsafe=true;return " ";}return String.fromCodePoint(code);});
  return {text:decoded,unsafe};
}
/** Shared formatting boundary; transport preserves reviewed inert HTML bytes. */
export function assessV2DescriptionFormatting(value:string){
  const readable=readableDescription(value),issues:string[]=[];
  if(readable.unsafe||value.length>20000)issues.push("Description contains unsafe formatting");
  if(!readable.text.trim()||/[\x00-\x08\x0b\x0c\x0e-\x1f]|^\s*[=+@-]/.test(readable.text))issues.push("Description is empty or unsafe");
  return {acceptable:issues.length===0,issues,text:readable.text};
}
/** One factual contract for preparation and saved readback. Base need not be stated literally; wording/style is otherwise unrestricted. */
export function assessV2Description(text:string,identity:V2Identity):{acceptable:boolean;issues:string[]}{
  const formatting=assessV2DescriptionFormatting(text),issues=[...formatting.issues];text=formatting.text;
  if(/pack[ -]?fresh|gem[ -]?mint|professionally graded|\b(?:PSA|BGS|SGC)\s*10\b|guaranteed\s+(?:value|grade|authenticity)|\b(?:flawless|pristine)\b/i.test(text))issues.push("Unsupported condition, grading or guarantee claim");
  for(const [field,fact]of Object.entries({name:identity.name,year:v2FactualYear(identity),product:identity.product,variant:identity.variant==="Base"?"":identity.variant,team:identity.team}))if(!(field==="variant"?containsVariant(text,fact):contains(text,fact)))issues.push(`Missing factual ${field}`);
  for(const match of Array.from(text.matchAll(/(?:\bcard\s*(?:number\b|no\b\.?|#)\s*(?:of\s+)?|#\s*)([A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*(?:\s*\/\s*[A-Za-z0-9]+)?)/gi)))if(normalize(match[1])!==normalize(identity.number))issues.push("Conflicting card number");
  const ccgCollector=identity.categoryId==='183454'&&/^\d+\s*\/\s*\d+$/.test(identity.number);
  const observed=Array.from(text.matchAll(/\b(\d+)\s*\/\s*(\d+)\b/g)).filter(m=>{
    if(normalize(`${m[1]} ${m[2]}`)===normalize(identity.year))return false;
    const serialLabel=/\b(?:serial(?:\s+(?:number|no\.?))?|numbered)\s*(?:of\s+)?[:#]?\s*$/i.test(text.slice(Math.max(0,m.index!-30),m.index));
    return !(ccgCollector&&!serialLabel&&normalize(m[0])===normalize(identity.number));
  });
  const own=/^(\d+)\s*\/\s*(\d+)$/.exec(identity.serial);
  if(observed.some(m=>!own||Number(m[1])!==Number(own[1])||Number(m[2])!==Number(own[2])))issues.push("Conflicting physical serial");
  return {acceptable:issues.length===0,issues};
}
export function factualV2Description(identity:V2Identity,condition="Near mint or better",quantity=1){
  if(!Number.isInteger(quantity)||quantity<1)throw Error("Positive physical quantity required");
  const photoText=quantity>1?"Photos show one representative copy. You will receive one card of this version in the stated condition.":"You will receive the exact card shown in the front and back photos.";
  return `${v2FactualYear(identity)?v2FactualYear(identity)+" ":""}${identity.manufacturer} ${identity.product} card featuring ${identity.name}. ${identity.variant}. Card #${identity.number}.${identity.serial?` Serial ${identity.serial}.`:""}${identity.team?` Team: ${identity.team}.`:""} ${identity.language}. ${identity.graded?"":"Ungraded. "}${condition}. ${photoText}`;
}

