"use client";
import { useRef, useState } from "react";
import { summarizeScanFolder, type ScanFile, type ScanSummary } from "@/lib/scan-folder";
import styles from "./ListingFactory.module.css";
export default function ScanFolderReader({onRead}:{onRead?:(files:ScanFile[])=>void}){
 const [mode,setMode]=useState<"named"|"alternating"|"fronts-only">("named");
 const [files,setFiles]=useState<ScanFile[]>([]);const [summary,setSummary]=useState<ScanSummary>();
 const [busy,setBusy]=useState(false);const [error,setError]=useState("");const [progress,setProgress]=useState("");
 const input=useRef<HTMLInputElement>(null);
 async function read(selected:FileList|null){
  if(!selected?.length)return;setBusy(true);setError("");setSummary(undefined);setFiles([]);
  const images=Array.from(selected).filter(f=>/\.(jpe?g|png|webp|tiff?|bmp|heic)$/i.test(f.name));
  try{
   if(images.length>20000)throw new Error("Select a folder containing at most 20,000 image files.");
   const result:ScanFile[]=[];
   for(let i=0;i<images.length;i++){
    const file=images[i];if(file.size>100*1024*1024)throw new Error(`Image exceeds 100 MB: ${file.name}`);
    const digest=await crypto.subtle.digest("SHA-256",await file.arrayBuffer());
    result.push({path:file.webkitRelativePath||file.name,hash:Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,"0")).join("")});
    if(i%20===0)setProgress(`Reading ${i+1} of ${images.length} images…`);
   }
   result.sort((a,b)=>a.path.localeCompare(b.path,undefined,{numeric:true}));setFiles(result);setSummary(summarizeScanFolder(result,mode));onRead?.(result);
   setProgress(`Read ${images.length} images just now. Photos remain on your computer.`);
  }catch(e){setError(e instanceof Error?e.message:"Folder could not be read.");setProgress("");}finally{setBusy(false);if(input.current)input.current.value="";}
 }
 return <section className="panel" style={{marginBottom:20}}><div className={styles.section}><div><h2>{onRead ? "Compare another folder" : "Scan folder"}</h2><p>{onRead ? "The local snapshot already includes your Card Inbox. Optionally match another folder against the saved captures." : "Read your Card Inbox and review its photo pairing candidates."}</p></div><div className={styles.actions}>{!onRead ? <label>Photo arrangement<select disabled={busy} value={mode} onChange={e=>{const next=e.target.value as typeof mode;setMode(next);if(summary)setSummary(summarizeScanFolder(files,next));}}><option value="named">Matching front / back filenames</option><option value="alternating">Alternating front / back in filename order</option><option value="fronts-only">One front image per card</option></select></label> : null}<button disabled={busy} onClick={()=>input.current?.click()}>{busy?"Reading folder…":"Read scan folder"}</button><input ref={input} type="file" multiple hidden aria-label="Select scan folder" {...{webkitdirectory:"",directory:""}} onChange={e=>{void read(e.target.files);}}/></div></div>
 <p className="text-secondary">{onRead ? "Selected photos are hashed in your browser and matched by content. This does not add inventory or upload photos." : "Choose your Card Inbox folder and the photo arrangement that matches your scans. Folder access requires your selection."}</p>
 {error?<p role="alert" className={styles.error}>{error}</p>:null}<p role="status">{progress}</p>
 {summary && !onRead?<><div className="metric-grid"><div className="metric"><div className="metric-label">Scanned card candidates</div><div className="metric-value">{summary.pairedCards}</div><div className="metric-detail">{mode==="named"?"Matched front/back filenames":mode==="alternating"?"Assumes alternating images in filename order":"Assumes one unique front per card"}</div></div><div className="metric"><div className="metric-label">Images needing pairing review</div><div className="metric-value">{summary.unmatchedImages}</div><div className="metric-detail">Not counted as completed card pairs</div></div><div className="metric"><div className="metric-label">Duplicate image files</div><div className="metric-value">{summary.duplicateFiles}</div><div className="metric-detail">Identical file content excluded</div></div><div className="metric"><div className="metric-label">Waiting to be listed</div><div className="metric-value">Unverified</div><div className="metric-detail">Existing draft/live reconciliation required</div></div></div><p>Read {summary.imageFiles} image files · {summary.uniqueImages} distinct image contents. Distinct original front captures represent physical copies; byte-identical copies do not add stock. These pairing candidates do not verify identity or eBay status.</p><details><summary>Photo files read ({files.length})</summary><ul>{files.slice(0,100).map(f=><li key={f.path}>{f.path}</li>)}</ul>{files.length>100?<p>Showing first 100 filenames.</p>:null}</details></>:null}
 </section>;
}
