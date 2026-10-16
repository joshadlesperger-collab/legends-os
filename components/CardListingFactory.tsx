"use client";

import { useState } from "react";
import { applyIdentityCorrection, projectListing, type CardIdentity, type DraftCard } from "@/lib/card-listing-factory";

type Photo = { id: string; file: File; url: string };
type ReviewCard = { id: string; draft: DraftCard; front?: Photo; back?: Photo };
const emptyIdentity = (): CardIdentity => ({ sport:"Baseball", player:"", year:new Date().getFullYear(), manufacturer:"", set:"", cardNumber:"" });
const newCard = (front?:Photo,back?:Photo):ReviewCard => ({ id:crypto.randomUUID(),front,back,draft:{identity:emptyIdentity(),quantity:1,verified:false,frontImageId:front?.id,backImageId:back?.id} });
const fieldStyle = { width:"100%", padding:"10px",borderRadius:6,border:"1px solid #999", background:"transparent",color:"inherit" } as const;
const sports:CardIdentity["sport"][]=["Baseball","Football","Basketball","Hockey","Soccer","Other"];

export default function CardListingFactory(){
 const [mode,setMode]=useState<"single"|"bulk">("single");
 const [cards,setCards]=useState<ReviewCard[]>([]);
 const [selected,setSelected]=useState(0);
 const [warning,setWarning]=useState("");

 const card=cards[selected];
 function ingest(files:FileList|null){
  if(!files?.length)return;
  const accepted=Array.from(files).filter(f=>f.type.startsWith("image/"));
  if(accepted.length!==files.length){setWarning("Non-image files were skipped.");}
  const incoming=accepted.map(file=>({id:crypto.randomUUID(),file,url:URL.createObjectURL(file)}));
  if(mode==="single") {
    if(incoming.length!==2){setWarning("Single Card mode requires exactly two images, ordered front then back."); incoming.forEach(p=>URL.revokeObjectURL(p.url));return;}
    setCards(previous=>[...previous,newCard(incoming[0],incoming[1])]);setSelected(cards.length);
  } else {
    const pairs:ReviewCard[]=[];
    for(let i=0;i<incoming.length;i+=2)pairs.push(newCard(incoming[i],incoming[i+1]));
    setCards(previous=>[...previous,...pairs]);setSelected(cards.length);
    if(incoming.length%2)setWarning("The final image has no matching back. Assign it before approval.");
  }
 }
 function update(index:number,patch:Partial<ReviewCard>){setCards(current=>current.map((c,i)=>i===index?{...c,...patch}:c));}
 function correction(fields:Partial<CardIdentity>){update(selected,{draft:applyIdentityCorrection(card.draft,fields)});}
 function setQuantity(value:number){update(selected,{draft:{...card.draft,quantity:value,verified:false}});}
 function assignPhoto(side:"front"|"back",id:string) {
  const source=cards.find(c=>c.front?.id===id||c.back?.id===id);
  const photo=source?.front?.id===id?source.front:source?.back?.id===id?source.back:undefined;
  if(!photo)return;
  setCards(current=>current.map((c,index)=>{
   const matchingSide=c.front?.id===id?"front":c.back?.id===id?"back":null;
   if(index===selected)return {...c,[side]:photo,draft:{...c.draft,[side==="front"?"frontImageId":"backImageId"]:id,verified:false}};
   if(matchingSide)return {...c,[matchingSide]:undefined,draft:{...c.draft,[matchingSide==="front"?"frontImageId":"backImageId"]:undefined,verified:false}};
   return c;
  }));
 }
 function exportJson(){
  const output=cards.map(c=>({id:c.id,identity:c.draft.identity,quantity:c.draft.quantity,frontImageName:c.front?.file.name??null,backImageName:c.back?.file.name??null,listing:projectListing(c.draft)}));
  const blob=new Blob([JSON.stringify({schema:"legends-card-listing-review-v1",cards:output},null,2)],{type:"application/json"});
  const link=document.createElement("a");link.href=URL.createObjectURL(blob);link.download="legends-listing-review.json";link.click();setTimeout(()=>URL.revokeObjectURL(link.href),1000);
 }
 return <main className="page" style={{maxWidth:1200}}>
  <div className="eyebrow">Legends OS · Listing Factory</div><h1>Card Listing Factory</h1>
  <p>Upload one card or a batch from your phone or scanner. Images stay in this browser session; this preview does not upload photos or publish to eBay.</p>
  <div style={{display:"flex",gap:10,flexWrap:"wrap",marginBottom:16}}>
   <button type="button" onClick={()=>setMode("single")} aria-pressed={mode==="single"}>Single Card</button>
   <button type="button" onClick={()=>setMode("bulk")} aria-pressed={mode==="bulk"}>Bulk Upload</button>
  </div>
  <label style={{display:"block",border:"2px dashed #999",borderRadius:10,padding:20,marginBottom:16}}>
   <strong>{mode==="single"?"Add front and back images":"Add images in front, back, front, back order"}</strong>
   <div style={{marginTop:10}}><input aria-label="Choose card photos" type="file" accept="image/*" multiple onChange={e=>{ingest(e.target.files);e.target.value="";}}/></div>
  </label>
  {warning&&<p role="alert" style={{color:"#b76b00"}}>{warning} <button type="button" onClick={()=>setWarning("")}>Dismiss</button></p>}
  <p>{cards.length} cards in session · {cards.filter(c=>!projectListing(c.draft).requiresReview).length} approved for future draft export</p>
  {cards.length>0&&<div style={{display:"grid",gridTemplateColumns:"minmax(140px,1fr) minmax(0,3fr)",gap:16}}>
   <div style={{display:"flex",flexDirection:"column",gap:8}}>{cards.map((c,i)=><button type="button" key={c.id} onClick={()=>setSelected(i)} aria-pressed={selected===i} style={{textAlign:"left",padding:10,border:i===selected?"2px solid currentColor":"1px solid #999",borderRadius:8}}>{i+1}. {c.draft.identity.player||"Unidentified card"}<div style={{fontSize:12}}>{projectListing(c.draft).requiresReview?"Needs review":"Approved"}</div></button>)}</div>
   {card&&<section style={{minWidth:0}}>
    <h2>Review card {selected+1}</h2>
    <div style={{display:"grid",gridTemplateColumns:"repeat(2,minmax(0,1fr))",gap:10}}>
     {(["front","back"] as const).map(side=><div key={side}><strong>{side==="front"?"Front":"Back"}</strong><div style={{minHeight:100,border:"1px solid #999",borderRadius:8,overflow:"hidden"}}>{card[side]?<img src={card[side]!.url} alt={side+" card photo"} style={{width:"100%",maxHeight:300,objectFit:"contain"}}/>:<p>Missing photo</p>}</div><select aria-label={"Assign "+side+" image"} value={card[side]?.id??""} onChange={e=>assignPhoto(side,e.target.value)} style={fieldStyle}><option value="">Select a photo</option>{cards.flatMap(c=>[c.front,c.back]).filter((p):p is Photo=>Boolean(p)).map(p=><option key={p.id} value={p.id}>{p.file.name} ({p.id.slice(0,6)})</option>)}</select></div>)}
    </div>
    <p style={{fontSize:13}}>Confirm the front/back match, then enter or correct the identity. Automatic AI recognition and photo persistence are not yet connected.</p>
    <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(170px,1fr))",gap:12}}>
     <label>Sport<select style={fieldStyle} value={card.draft.identity.sport} onChange={e=>correction({sport:e.target.value as CardIdentity["sport"]})}>{sports.map(s=><option key={s}>{s}</option>)}</select></label>
     {(["player","manufacturer","set","cardNumber","team","parallel","serialNumber"] as const).map(key=><label key={key}>{key}<input style={fieldStyle} value={card.draft.identity[key]??""} onChange={e=>correction({[key]:e.target.value})}/></label>)}
     <label>Year<input style={fieldStyle} type="number" value={card.draft.identity.year} onChange={e=>correction({year:Number(e.target.value)})}/></label>
     <label>Print run (/N)<input style={fieldStyle} type="number" value={card.draft.identity.numberedTo??""} onChange={e=>correction({numberedTo:e.target.value?Number(e.target.value):undefined})}/></label>
     <label>Quantity<input style={fieldStyle} type="number" min={1} value={card.draft.quantity} onChange={e=>setQuantity(Number(e.target.value))}/></label>
    </div>
    <p><strong>Storage:</strong> {projectListing(card.draft).storageLocation}</p>
    <p><strong>Proposed title:</strong> {projectListing(card.draft).title}</p>
    <p><strong>Item specifics:</strong> {Object.entries(projectListing(card.draft).specifics).map(([k,v])=>k+": "+v).join(" · ")}</p>
    <p style={{whiteSpace:"pre-line"}}><strong>Description:</strong> {projectListing(card.draft).description}</p>
    {projectListing(card.draft).reviewReasons.length>0&&<div role="status"><strong>Review required:</strong><ul>{projectListing(card.draft).reviewReasons.map(x=><li key={x}>{x}</li>)}</ul></div>}
    <button type="button" disabled={!card.front||!card.back||!card.draft.identity.player||!card.draft.identity.set||!card.draft.identity.manufacturer||!card.draft.identity.cardNumber||card.draft.quantity<1} onClick={()=>update(selected,{draft:{...card.draft,verified:true}})}>Confirm card identity</button>
   </section>}
  </div>}
  {cards.length>0&&<p><button type="button" onClick={exportJson}>Export review data (JSON)</button> <small>Exports field data and image filenames only; original image files remain on your device.</small></p>}
 </main>;
}
