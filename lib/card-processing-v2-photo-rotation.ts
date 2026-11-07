/** Immutable derivative instructions. Manual registration requires an idle
 * worker; first-pass provider instructions are attached by its owned result commit. */
import fs from 'node:fs/promises';import path from 'node:path';import {createHash} from 'node:crypto';import sharp from 'sharp';import {z} from 'zod';
import {digest,event,type V2State} from './card-processing-v2.ts';import {readV2State,v2Dir,acquireV2Lock,processAlive,withV2State} from './card-processing-v2-store.ts';import {v2DecodableImage} from './card-processing-v2-image-decode.ts';
import {readV2ProviderPhotoRotations} from './card-processing-v2-provider-orientation.ts';
const hash=z.string().regex(/^[a-f0-9]{64}$/),ref=z.object({path:z.string().min(1),sha256:hash}).strict();
const photo=z.object({path:z.string().min(1),hash,side:z.enum(['front','back']),clockwiseDegrees:z.union([z.literal(0),z.literal(90),z.literal(180),z.literal(270)]),visualEvidence:ref}).strict();
const manifest=z.object({kind:z.literal('v2-reviewed-original-pair-rotation'),instructionId:z.string().min(1),taskId:z.string().min(1),reviewer:z.string().min(10),observedAt:z.string().datetime(),selection:ref,sourceTransferId:z.string().min(1).optional(),sourceScope:z.literal('authorized-new-scans').optional(),rows:z.array(z.object({cardId:z.string().min(1),captureId:hash,photos:z.array(photo).length(2)}).strict()).min(1).max(100)}).strict();
const sha=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
async function evidence(root:string,r:z.infer<typeof ref>,max=16000000){if(path.isAbsolute(r.path)||r.path.split(/[\\/]/).includes('..'))throw Error('Rotation evidence must stay under artifacts');const base=await fs.realpath(path.join(root,'artifacts')),file=await fs.realpath(path.join(root,r.path)),relative=path.relative(base,file),st=await fs.lstat(file);if(!relative||relative.startsWith('..')||path.isAbsolute(relative)||!st.isFile()||st.isSymbolicLink()||st.size>max)throw Error('Bounded rotation evidence required');const bytes=await fs.readFile(file);if(sha(bytes)!==r.sha256)throw Error('Rotation evidence hash changed');return bytes;}
const samePath=(a:string,b:string)=>path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();
export async function registerV2PhotoRotations(root:string,raw:unknown){
 const source=ref.parse(raw),body=manifest.parse(JSON.parse((await evidence(root,source)).toString('utf8'))),age=Date.now()-Date.parse(body.observedAt);if(age<0||age>3600000)throw Error('Fresh actual visual review required');
 const state=await readV2State(root);if(state.lastRun?.status==='running'&&processAlive(state.lastRun.pid))throw Error('Wait for current preparation worker before registering rotation');
 const queue=JSON.parse(await fs.readFile(path.join(root,'artifacts/engineering-mission/work-queue.json'),'utf8')),instruction=queue.instructions?.find((i:{id:string})=>i.id===body.instructionId);if(!instruction||!instruction.text?.trim()||!instruction.taskIds?.includes(body.taskId)||!instruction.policyRefs?.includes('draft-only-no-publication')||queue.instructions.some((i:{supersedes?:string[]})=>i.supersedes?.includes(body.instructionId)))throw Error('Current captured scoped rotation authority required');
 const selection=JSON.parse((await evidence(root,body.selection)).toString('utf8'));if(!Array.isArray(selection.captures)||(body.sourceScope==='authorized-new-scans'?(!!body.sourceTransferId||selection.instructionId!==body.instructionId||selection.taskId!==body.taskId):(!body.sourceTransferId||selection.sourceTransferId!==body.sourceTransferId)))throw Error('Exact selected transfer scope required');
 const ids=new Set<string>(),hashes=new Set<string>();for(const row of body.rows){const card=state.cards[row.cardId];if(ids.has(row.cardId)||!card||card.captureId!==row.captureId||(body.sourceScope==='authorized-new-scans'?!!card.resetTransfer:card.resetTransfer?.resetId!==body.sourceTransferId)||card.draftId||card.verification||card.nonpriceVerification||Object.values(state.submissions).some(s=>s.payload.captureIds.includes(row.captureId)))throw Error('Exact unsubmitted capture ownership required');ids.add(row.cardId);
 if(new Set(row.photos.map(p=>p.side)).size!==2||!selection.captures.some((c:{cardId?:string;captureId?:string;photos:{path:string;hash:string}[]})=>(body.sourceScope!=='authorized-new-scans'||(c.cardId===row.cardId&&c.captureId===row.captureId))&&c.photos?.length===2&&row.photos.every(p=>c.photos.some(q=>samePath(q.path,p.path)&&q.hash===p.hash))))throw Error('Exact selected original pair required');
 for(const p of row.photos){if(hashes.has(p.hash)||!card.photos.some(q=>q.side===p.side&&samePath(q.path,p.path)&&q.hash===p.hash))throw Error('Original pair side/hash binding changed');hashes.add(p.hash);const st=await fs.lstat(p.path);if(!st.isFile()||st.isSymbolicLink()||st.size>35000000||sha(await fs.readFile(p.path))!==p.hash)throw Error('Original changed');await evidence(root,p.visualEvidence);}}
 const prior=await readV2PhotoRotations(root);for(const row of body.rows)for(const p of row.photos){if(prior.some(r=>r.captureId===row.captureId&&r.photo.hash===p.hash&&r.photo.clockwiseDegrees!==p.clockwiseDegrees))throw Error('Conflicting reviewed derivative rotation');}
 const release=await acquireV2Lock('worker',root);try{const current=await readV2State(root);if(body.rows.some(r=>digest(current.cards[r.cardId])!==digest(state.cards[r.cardId])))throw Error('Capture changed during rotation review');const directory=path.join(v2Dir(root),'photo-rotations');await fs.mkdir(directory,{recursive:true});let registration={version:1,kind:'v2-reviewed-photo-rotation-registration',source,manifest:body,authorityHash:digest(instruction),registeredAt:new Date().toISOString(),originalsModified:false,derivativesOnly:true};const file=path.join(directory,digest(body)+'.json');try{await fs.writeFile(file,JSON.stringify(registration,null,2),{flag:'wx',flush:true});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;const existing=JSON.parse(await fs.readFile(file,'utf8'));if(digest(existing.manifest)!==digest(body))throw Error('Rotation registration conflict');registration=existing;}await withV2State(s=>{const marker='Derivative orientation '+digest(body);if(!s.events.some(e=>e.stage==='photo-rotation-registered'&&e.detail===marker)){for(const row of body.rows)for(const p of row.photos)if(p.clockwiseDegrees!==0)delete s.media[p.hash];event(s,'photo-rotation-registered',marker);}},root);return registration;}finally{await release();}
}
/** Load once per run. Contradictory historical rotations fail closed; this
 * first version deliberately has no implicit overwrite/supersession protocol. */
export async function readV2PhotoRotations(root:string,options:{state?:V2State;cardIds?:string[]}={}){
 const directory=path.join(v2Dir(root),'photo-rotations');let files:string[];
 try{files=await fs.readdir(directory);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')files=[];else throw e;}
 if(files.length>200)throw Error('Rotation registry exceeds bound');
 const queue=files.length?JSON.parse(await fs.readFile(path.join(root,'artifacts/engineering-mission/work-queue.json'),'utf8')):null;
 const rows:Array<{cardId:string;captureId:string;photo:z.infer<typeof photo>;source:z.infer<typeof ref>}>=[],selected=options.cardIds?new Set(options.cardIds):undefined;
 for(const file of files){
  if(!/^[a-f0-9]{64}\.json$/.test(file))throw Error('Unexpected rotation registry file');
  const data=JSON.parse(await fs.readFile(path.join(directory,file),'utf8')),body=manifest.parse(data.manifest),instruction=queue?.instructions?.find((i:{id:string})=>i.id===body.instructionId);
  if(!instruction||digest(instruction)!==data.authorityHash||queue.instructions.some((i:{supersedes?:string[]})=>i.supersedes?.includes(body.instructionId)))throw Error('Rotation authority changed');
  if(digest(body)+'.json'!==file||data.originalsModified!==false||data.derivativesOnly!==true||digest(JSON.parse((await evidence(root,ref.parse(data.source))).toString('utf8')))!==digest(body))throw Error('Rotation registry evidence changed');
  for(const row of body.rows){if(selected&&!selected.has(row.cardId))continue;for(const p of row.photos)rows.push({cardId:row.cardId,captureId:row.captureId,photo:p,source:data.source});}
 }
 rows.push(...await readV2ProviderPhotoRotations(root,options));
 const angles=new Map<string,number>();for(const row of rows){const key=row.captureId+':'+row.photo.hash;if(angles.has(key)&&angles.get(key)!==row.photo.clockwiseDegrees)throw Error('Conflicting reviewed/provider derivative rotation');angles.set(key,row.photo.clockwiseDegrees);}
 return rows;
}
export async function rotateV2ReviewedDerivative(bytes:Uint8Array,review:{photo:z.infer<typeof photo>},root=process.cwd()){
 const p=photo.parse(review.photo);if(sha(bytes)!==p.hash)throw Error('Rotation source hash changed');const decoded=await v2DecodableImage(bytes,root);
 // Two pipelines are intentional: repeated rotate calls in one sharp pipeline
 // replace rather than compose. EXIF normalization precedes reviewed rotation.
 const normalized=await sharp(decoded,{limitInputPixels:80000000}).rotate().toBuffer();return sharp(normalized,{limitInputPixels:80000000}).rotate(p.clockwiseDegrees).jpeg({quality:95}).toBuffer();
}

/** Production integration reads registered, hash-bound instructions only. Zero
 * degrees preserves the ordinary EXIF path and unchanged bytes until output. */
export async function v2OrientedImage(bytes:Uint8Array,root=process.cwd(),rotations?:Awaited<ReturnType<typeof readV2PhotoRotations>>){
 const hash=sha(bytes),matches=(rotations??await readV2PhotoRotations(root)).filter(r=>r.photo.hash===hash);
 if(!matches.length||matches[0].photo.clockwiseDegrees===0)return v2DecodableImage(bytes,root);
 if(matches.some(r=>r.photo.clockwiseDegrees!==matches[0].photo.clockwiseDegrees))throw Error('Conflicting derivative orientation');
 return rotateV2ReviewedDerivative(bytes,matches[0],root);
}

/** A review may approve prepared orientation without claiming originals were upright.
 * Visual observations bind the raw finding before the manifest ref is attached. */
export async function assertV2PreparedOrientation(root:string,card:{id:string;captureId:string;photos:{hash:string}[]},source:{path:string;sha256:string},rawObservation:unknown){
 const matches=(await readV2PhotoRotations(root)).filter(r=>r.cardId===card.id&&r.captureId===card.captureId&&r.source.path===source.path&&r.source.sha256===source.sha256);
 if(matches.length!==2||new Set(matches.map(r=>r.photo.hash)).size!==2||!card.photos.every(p=>matches.some(r=>r.photo.hash===p.hash))||!matches.some(r=>r.photo.clockwiseDegrees!==0))throw Error('Exact registered nonzero pair orientation required');
 for(const r of matches)if(digest(JSON.parse((await evidence(root,r.photo.visualEvidence)).toString('utf8')))!==digest(rawObservation))throw Error('Prepared orientation visual finding differs');
}
