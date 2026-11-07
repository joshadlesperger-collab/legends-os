"use client";

import Link from "next/link";
import {v2ArchivePresentation} from "@/lib/card-processing-v2-archive-status";
import CardProcessingProgress from "./CardProcessingProgress";
import CardProcessingBatchHistory from "./CardProcessingBatchHistory";
import CardProcessingPriceCheck from "./CardProcessingPriceCheck";
import { v2BatchProgress,type V2ProcessingBatch } from "@/lib/card-processing-v2-batch-progress";
import { ProcessingTiming, CardTiming, StepTable } from "./CardProcessingTiming";
import { useCallback, useEffect, useRef, useState } from "react";
import type { V2Card, V2State, v2Summary } from "@/lib/card-processing-v2";
import type { V2CategoryCapability } from "@/lib/card-processing-v2-category";
import { classifyV2IdentificationWarnings } from "@/lib/card-processing-v2-identification-warnings";
import styles from "./CardProcessingV2.module.css";

type Stage = V2Card["stage"];
function IdentificationNotes({ finding }: { finding: V2Card["identification"] }) {
  const notes = finding ? classifyV2IdentificationWarnings(finding).advisory : [];
  return notes.length ? <details><summary>Photo notes · no hold</summary><ul>{notes.map((note, index) => <li key={index}>{note}</li>)}</ul></details> : null;
}
type ProcessingCandidate = { id: string; cardId?: string; photoCount: 2; label: string; stage: string; eligible: boolean; detail: string; frontUrl: string; backUrl: string };
type CandidateSnapshot = { token: string; activationRequired: boolean; unmatchedPhotos: number; candidates: ProcessingCandidate[] };
import type {V2ActivitySnapshot} from "@/lib/card-processing-v2-activity";

type Snapshot = {
  readyBatches?: {id:string;label:string;folder:string;createdAt:string;organizedAt:string;readyCount:number;completedCount:number;heldCount:number;cards:{cardId:string}[];intake:{startedAt:string;actualMicros:number}}[];
  intake?: {id:string;startedAt:string;finishedAt?:string;phase:string;detail:string;busy:boolean;interrupted:boolean;total:number;identified:number;exceptions:number;actualMicros:number;pendingCost:boolean;elapsedMs:number}|null;
  batchActivity?: V2ActivitySnapshot;
  uploader?: {available:boolean;status:"unavailable"|"ready"|"expired"|"awaiting-ack"|"busy";message:string;expiresAt?:string};
  background?: {available:boolean;loginRequired:boolean;busy:boolean;stalled:boolean;phase:string;detail:string;batchId?:string;terminal?:boolean};
  state: V2State;
  batches?: V2ProcessingBatch[];
  browserJobs?: {id:string;stage:string;cardIds:string[]}[];
  summary: ReturnType<typeof v2Summary>;
  configuration: { folder: string; pairing: string; identificationConfigured: boolean; categoryCount: number; bulkMethodStatus: string; categoryCapabilities?: V2CategoryCapability[] };
  running: boolean;
};
const stages: { stage: Stage; label: string; detail: string; short: string }[] = [
  { stage: "waiting", label: "Not started", detail: "No identification pass yet", short: "Not started" },
  { stage: "identified", label: "Identified", detail: "Card identity retained", short: "Identified" },
  { stage: "consolidated", label: "Consolidated", detail: "Exact copies grouped", short: "Consolidated" },
  { stage: "prepared", label: "Prepared", detail: "Completeness checked", short: "Prepared" },
  { stage: "verified", label: "Verified in eBay", detail: "Saved draft checked", short: "Verified in eBay draft" },
  { stage: "exception", label: "Exceptions", detail: "A next action retained", short: "Needs attention" },
];
const usd = (amount: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(amount);
function when(value?: string) {
  return value ? new Date(value).toLocaleString("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "No run yet";
}

export default function CardProcessingV2() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [intakeStarting, setIntakeStarting] = useState(false);
  const [intakeStartDetail, setIntakeStartDetail] = useState("");
  const [intakeLimit,setIntakeLimit]=useState("");
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");
  const [connectingBackground,setConnectingBackground]=useState(false);
  const [filter, setFilter] = useState<Stage | "all" | "ready-for-pricing">("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [progressOpen,setProgressOpen]=useState(false);
  const [progressJobId,setProgressJobId]=useState<string|null>(null);
  const [progressPending,setProgressPending]=useState<string[]>([]);
  const [progressError,setProgressError]=useState("");
  const clickStartedAt=useRef<string|undefined>(undefined);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerLoading, setPickerLoading] = useState(false);
  const [pickerError, setPickerError] = useState("");
  const [candidates, setCandidates] = useState<CandidateSnapshot | null>(null);
  const [selectionMode, setSelectionMode] = useState<"all" | "selected">("all");
  const [selectedCandidateIds, setSelectedCandidateIds] = useState<string[]>([]);
  const [selectedReadyBatchIds,setSelectedReadyBatchIds]=useState<string[]>([]);
  const pickerRef = useRef<HTMLDialogElement>(null);
  const candidateRequest = useRef(0);
  const active = useRef(true);
  const pendingRead = useRef(false);

  const refresh = useCallback(async () => {
    if (pendingRead.current) return;
    pendingRead.current = true;
    try {
      const response = await fetch("/api/card-processing-v2", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw Error(data.error || "Could not refresh processing status.");
      if (active.current) { setSnapshot(data); setError(""); }
    } catch (reason) {
      if (active.current) setError(reason instanceof Error ? reason.message : "Could not refresh processing status.");
    } finally {
      pendingRead.current = false;
      if (active.current) setLoading(false);
    }
  }, []);

  useEffect(() => { active.current = true; void refresh(); return () => { active.current = false; }; }, [refresh]);
  // A slow worker startup or a run in another window must also become visible.
  useEffect(() => {
    const refreshVisible=()=>{if(document.visibilityState==='visible')void refresh();};
    const timer = setInterval(refreshVisible, snapshot?.running || starting || progressOpen ? 3000 : 10000);
    document.addEventListener('visibilitychange',refreshVisible);
    return () => {clearInterval(timer);document.removeEventListener('visibilitychange',refreshVisible);};
  }, [snapshot?.running, starting, progressOpen, refresh]);

  useEffect(() => {
    const dialog = pickerRef.current;
    if (pickerOpen && !dialog?.open) dialog?.showModal();
    else if (!pickerOpen && dialog?.open) dialog.close();
  }, [pickerOpen]);

  useEffect(()=>{if(progressOpen&&!progressJobId){const batch=snapshot?.batches?.find(item=>item.clickedAt===clickStartedAt.current);if(batch)setProgressJobId(batch.jobId);}},[snapshot?.batches,progressOpen,progressJobId]);

  async function loadCandidates() {
    const request = ++candidateRequest.current;
    setPickerLoading(true); setPickerError(""); setCandidates(null); setSelectedCandidateIds([]);
    try {
      const response = await fetch("/api/card-processing-v2?candidates=1", { cache: "no-store" });
      const result = await response.json();
      if (!response.ok) throw Error(result.error || "Could not read the available photo pairs.");
      if (!result || typeof result.token !== "string" || !Array.isArray(result.candidates)) throw Error("Photo selection could not be read. Refresh before processing.");
      if (active.current && request === candidateRequest.current) { setCandidates(result); if (result.activationRequired) setSelectionMode("all"); }
    } catch (reason) {
      if (active.current && request === candidateRequest.current) setPickerError(reason instanceof Error ? reason.message : "Could not read the available photo pairs.");
    } finally { if (active.current && request === candidateRequest.current) setPickerLoading(false); }
  }
  function closePicker() {
    if (starting) return;
    candidateRequest.current++; setPickerOpen(false); setPickerLoading(false);
  }
  function openPicker() {
    clickStartedAt.current=new Date().toISOString();
    setSelectionMode("all"); setPickerOpen(true); void loadCandidates();
  }
  async function resumeBackground(){
    const batchId=snapshot?.background?.batchId;if(!batchId)return;
    setConnectingBackground(true);setError("");
    try{const response=await fetch("/api/card-processing-v2",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"resume-background",batchId})});const data=await response.json();if(!response.ok)throw Error(data.error||"Could not resume the saved batch.");setProgressJobId(batchId);setProgressOpen(true);await refresh();}
    catch(reason){setError(reason instanceof Error?reason.message:"Could not resume the saved batch.");}
    finally{setConnectingBackground(false);}
  }
  async function connectBackground(){
    setConnectingBackground(true);setError("");
    try{const response=await fetch("/api/card-processing-v2",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"connect-background"})});const data=await response.json();if(!response.ok)throw Error(data.error||"Could not open the separate eBay sign-in window.");await refresh();}
    catch(reason){setError(reason instanceof Error?reason.message:"Could not connect eBay.");}
    finally{setConnectingBackground(false);}
  }
  async function identifyAndSort() {
    setStarting(true);setIntakeStarting(true);setIntakeStartDetail('Reading new scans and pairing photos… Your click was received; please do not click again.');setError('');const intakeClickedAt=new Date().toISOString();
    try{const response=await fetch('/api/card-processing-v2?candidates=1',{cache:'no-store'}),available=await response.json();if(!response.ok)throw Error(available.error||'Could not read new scans.');
      const limit=intakeLimit?Number(intakeLimit):500;if(!Number.isSafeInteger(limit)||limit<1||limit>500)throw Error('Choose an intake limit from 1 to 500, or leave it blank.');const eligible=available.candidates?.filter((c:ProcessingCandidate)=>c.eligible).slice(0,limit)??[];if(!eligible.length)throw Error('No new eligible photo pairs are waiting. Existing work stays separate.');
      setIntakeStartDetail(`Starting identification for ${eligible.length} cards… Waiting for the saved run acknowledgement; please do not click again.`);
      const started=await fetch('/api/card-processing-v2',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'identify-sort',clickedAt:intakeClickedAt,selection:{mode:'selected',token:available.token,candidateIds:eligible.map((c:ProcessingCandidate)=>c.id)}})}),result=await started.json();if(!started.ok)throw Error(result.error||'Could not start identification.');setFeedback('Identify & Sort started. Results and named batch folders are saved automatically.');await refresh();
    }catch(reason){setError(reason instanceof Error?reason.message:'Could not start identification.');}finally{setStarting(false);setIntakeStarting(false);setIntakeStartDetail('');}
  }
  async function resumeIntake(){if(!snapshot?.intake)return;setStarting(true);try{const response=await fetch('/api/card-processing-v2',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'resume-identify-sort',jobId:snapshot.intake.id})}),result=await response.json();if(!response.ok)throw Error(result.error||'Could not resume identification.');await refresh();}catch(reason){setError(reason instanceof Error?reason.message:'Could not resume identification.');}finally{setStarting(false);}}
  async function createNamedDrafts(scope:string|string[]){if(busy)return;const frozenScope:{readyBatchIds:string[]}|{readyBatchId:string}=Array.isArray(scope)?{readyBatchIds:[...scope].sort()}:{readyBatchId:scope};if('readyBatchIds' in frozenScope&&(!frozenScope.readyBatchIds.length||frozenScope.readyBatchIds.length>100))return;setStarting(true);setError('');clickStartedAt.current=new Date().toISOString();try{
    const query='readyBatchIds' in frozenScope?`readyBatchIds=${encodeURIComponent(frozenScope.readyBatchIds.join(','))}`:`readyBatchId=${encodeURIComponent(frozenScope.readyBatchId)}`;
    const response=await fetch(`/api/card-processing-v2?candidates=1&${query}`,{cache:'no-store'}),available=await response.json();if(!response.ok)throw Error(available.error||'Could not read these ready batches.');const pairs=available.candidates.filter((c:ProcessingCandidate)=>c.eligible);if(!pairs.length)throw Error('These batches have no cards waiting for drafts.');
    setProgressPending(pairs.map((c:ProcessingCandidate)=>c.label));setProgressJobId(null);setProgressError('');setProgressOpen(true);
    const started=await fetch('/api/card-processing-v2',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'process',selection:{mode:'all',token:available.token,...frozenScope},clickedAt:clickStartedAt.current})}),result=await started.json();if(!started.ok)throw Error(result.error||'Could not start these batches.');setSelectedReadyBatchIds([]);setProgressJobId(result.jobId);await refresh();
   }catch(reason){const message=reason instanceof Error?reason.message:'Could not start this batch.';setError(message);setProgressError(message);}finally{setStarting(false);}
  }
  async function processSelection() {
    if (!candidates || !chosenCandidates.length && !candidates.activationRequired) { setPickerError("Choose at least one eligible front/back pair."); return; }

    setProgressPending(chosenCandidates.map(candidate=>candidate.label)); setProgressJobId(null);setProgressError("");setPickerOpen(false);setProgressOpen(true);
    setStarting(true); setError(""); setFeedback("");
    setPickerError("");
    try {
      const selection = selectionMode === "all" ? { mode: "all", token: candidates.token } : { mode: "selected", token: candidates.token, candidateIds: chosenCandidates.map(candidate => candidate.id) };
      const response = await fetch("/api/card-processing-v2", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "process", selection, clickedAt:clickStartedAt.current??new Date().toISOString() }) });
      const result = await response.json();
      if (!response.ok) throw Error(result.error || "Processing could not start.");
      setProgressJobId(result.jobId);
      setPickerOpen(false);
      setFeedback(candidates.activationRequired ? "V2 activation started. Existing photos will be protected before you process new scans." : "Processing started. Checkpoints and any exceptions will appear below.");
      await refresh();
      // Keep polling through the worker's initial startup, without claiming completion.
      await new Promise(resolve => setTimeout(resolve, 1500));
      await refresh();
    } catch (reason) {
      const message=reason instanceof Error ? reason.message : "Processing could not start.";setPickerError(message);setProgressError(message);
    } finally { if (active.current) setStarting(false); }
  }

  const cards = snapshot ? Object.values(snapshot.state.cards) : [];
  const readyForPricingCount = cards.filter(card => v2ArchivePresentation(card).readyForPricing).length;
  const pendingCards = cards.filter(card => !v2ArchivePresentation(card).archived);
  const pendingPhotos = pendingCards.reduce((total,card)=>total+card.photos.length,0);
  const groupCounts = new Map<string, number>();
  for (const card of cards) if (card.groupId) groupCounts.set(card.groupId, (groupCounts.get(card.groupId) ?? 0) + 1);
  const normalizedSearch = search.trim().toLowerCase();
  const selected = cards.filter(card => (filter === "all" || (filter === "ready-for-pricing" ? v2ArchivePresentation(card).readyForPricing : card.stage === filter))
    && (!normalizedSearch || [card.title, card.identity?.name, card.identity?.product, card.sku, card.nextAction].some(value => value?.toLowerCase().includes(normalizedSearch))))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  const pages = Math.max(1, Math.ceil(selected.length / 50));
  const currentPage = Math.min(page, pages - 1);
  const visible = selected.slice(currentPage * 50, currentPage * 50 + 50);
  const busy = starting || connectingBackground || !!snapshot?.running || !!snapshot?.intake?.busy || !!snapshot?.background?.busy;
  const eligibleReadyBatches=(snapshot?.readyBatches??[]).filter(batch=>batch.readyCount>0);
  const selectedReadyBatches=eligibleReadyBatches.filter(batch=>selectedReadyBatchIds.includes(batch.id));
  const selectedReadyCardCount=selectedReadyBatches.reduce((total,batch)=>total+batch.readyCount,0);
  const cost = snapshot?.summary.cost;
  const lastRun = snapshot?.state.lastRun;
  const verifiedDraftGroups = new Set(cards.filter(card => card.stage === "verified" && card.verification && card.draftId).map(card => card.draftId)).size;
  const methodStatus = snapshot?.configuration.bulkMethodStatus;
  const eligibleCandidates = candidates?.candidates.filter(candidate => candidate.eligible) ?? [];
  const selectedIds = new Set(selectedCandidateIds);
  const chosenCandidates = eligibleCandidates.filter(candidate => selectionMode === "all" || selectedIds.has(candidate.id));
  const chosenPhotoCount = chosenCandidates.reduce((total, candidate) => total + candidate.photoCount, 0);

  const intakePercent = snapshot?.intake?.total ? Math.min(100, Math.max(0, Math.floor(snapshot.intake.identified / snapshot.intake.total * 100))) : 0;

  return <main className={styles.page}>
    <header className={styles.header}>
      <div><div className={styles.eyebrow}>Sell / Scan to draft</div><h1>Card Processing <span>V2</span></h1><p>One place for new scans, verified identities, and complete draft handoffs.</p></div>
      <div><Link className={styles.quietLink} href="/card-processing-v2/price-check">Review full draft price report ↗</Link><br/><Link className={styles.quietLink} href="/listing-factory">Open existing Listing Factory ↗</Link></div>
    </header>

    <section className={styles.start} aria-labelledby="process-heading">
      <div><span className={styles.kicker}>Step 1 · New scans</span><h2 id="process-heading">Identify & Sort</h2><p>Identify each front/back pair once, then organize product batches into named folders. Original filenames are preserved. You choose when each batch becomes drafts.</p><details><summary>Limit this intake (optional)</summary><label htmlFor="intake-limit">Maximum new cards (up to 500)</label><input id="intake-limit" type="number" min="1" max="500" step="1" placeholder="All eligible, up to 500" value={intakeLimit} onChange={event=>setIntakeLimit(event.target.value)} disabled={busy}/></details></div>
      <div><button type="button" className={styles.process} onClick={()=>{void identifyAndSort();}} disabled={busy||loading||!snapshot||!snapshot.configuration.identificationConfigured} aria-busy={intakeStarting||snapshot?.intake?.busy||false}>{intakeStarting?'Starting—reading scans…':snapshot?.intake?.busy?'Identifying & sorting…':'Identify & Sort New Scans'}</button><p role="status" aria-live="polite" aria-atomic="true">{intakeStarting?intakeStartDetail:''}</p></div>
    </section>
    {!intakeStarting&&snapshot?.intake&&<section className={styles.panel} aria-label="Identification progress"><h2>{snapshot.intake.busy?'Identifying and sorting':snapshot.intake.phase==='complete'?'Identification saved':'Identification needs attention'}</h2><p role="status">{snapshot.intake.detail}</p><p>{snapshot.intake.phase==='starting'?'Started · preparing accepted photos':snapshot.intake.phase==='sorting'?'Sorting identified cards into batches':snapshot.intake.busy?'Identification in progress':snapshot.intake.phase==='complete'?'Identification and sorting complete':'Identification needs attention'}</p><progress aria-label="Cards identified" value={snapshot.intake.identified} max={Math.max(1,snapshot.intake.total)} /><p><strong>{intakePercent}% identified</strong> · {snapshot.intake.identified} / {snapshot.intake.total} identified · {Math.floor(snapshot.intake.elapsedMs/60000)}m {Math.floor(snapshot.intake.elapsedMs/1000)%60}s elapsed · {usd(snapshot.intake.actualMicros/1e6)} recorded AI cost{snapshot.intake.exceptions?` · ${snapshot.intake.exceptions} exceptions`:''}{snapshot.intake.pendingCost?' · additional usage unresolved':''}</p><details><summary>Intake time by step</summary><StepTable spans={snapshot.state.timings??[]} from={snapshot.intake.startedAt} to={snapshot.intake.finishedAt??new Date().toISOString()} runId={snapshot.intake.id}/></details>{(snapshot.intake.interrupted||snapshot.intake.phase==='exception')&&<button type="button" disabled={busy} onClick={()=>{void resumeIntake();}}>Resume identification</button>}</section>}
    <section className={styles.panel} aria-labelledby="ready-batches-heading"><span className={styles.kicker}>Step 2 · Your named batches</span><h2 id="ready-batches-heading">Select batches for eBay drafts</h2><p>Saved identifications are reused. Pricing stays with Grok; nothing is published.</p>
      <div className={styles.pickerTools}><div><button type="button" disabled={busy||!eligibleReadyBatches.length||eligibleReadyBatches.length>100} onClick={()=>setSelectedReadyBatchIds(eligibleReadyBatches.map(batch=>batch.id))}>Select all ready batches</button><button type="button" disabled={busy||!selectedReadyBatchIds.length} onClick={()=>setSelectedReadyBatchIds([])}>Clear selection</button></div><span role="status">{selectedReadyBatches.length} batches · {selectedReadyCardCount} cards selected</span><button type="button" className={styles.process} disabled={busy||!selectedReadyBatches.length||selectedReadyBatches.length>100||selectedReadyCardCount>500} onClick={()=>{void createNamedDrafts(selectedReadyBatches.map(batch=>batch.id));}}>Create selected drafts</button></div>
      {selectedReadyCardCount>500&&<p role="status">Choose up to 500 cards per run.</p>}
      {!snapshot?.readyBatches?.length?<p>No named batches yet. Identify & Sort your new scans first.</p>:<div className={styles.namedBatchScroll}><table><thead><tr><th>Select</th><th>Batch / folder</th><th>Cards</th><th>Identified</th><th>Identification time</th><th>Total AI / card</th><th>Process</th><th>Next step</th></tr></thead><tbody>{snapshot.readyBatches.map(batch=>{const remaining=batch.readyCount,processing=snapshot.batches?.find(item=>item.readyBatchId===batch.id||item.readyBatchIds?.includes(batch.id)),progress=processing?v2BatchProgress(snapshot.state,processing):undefined,sharedRun=!!processing?.readyBatchIds&&processing.readyBatchIds.length>1;return <tr key={batch.id}><td><input type="checkbox" aria-label={`Select ${batch.label}`} checked={remaining>0&&selectedReadyBatchIds.includes(batch.id)} disabled={busy||!remaining} onChange={event=>setSelectedReadyBatchIds(current=>event.target.checked?Array.from(new Set([...current,batch.id])):current.filter(id=>id!==batch.id))}/></td><td><strong>{batch.label}</strong><small className={styles.batchFolder}>{batch.folder}</small></td><td>{remaining} waiting / {batch.cards.length}</td><td>{when(batch.createdAt)}</td><td>{Math.max(0,(Date.parse(batch.organizedAt)-Date.parse(batch.intake.startedAt))/1000).toFixed(1)}s{progress&&<small className={styles.batchFolder}>{sharedRun&&<>Shared run · {progress.totalCount} cards · </>}Draft execution: {Math.round(progress.executionElapsedMs/1000)}s · Whole cycle: {Math.round(progress.fullCycleElapsedMs/1000)}s</small>}</td><td>{usd((progress?.totalAttributedMicros??batch.intake.actualMicros)/Math.max(1,progress?.totalCount??batch.cards.length)/1e6)}{sharedRun&&progress&&<small className={styles.batchFolder}>Shared run · {progress.totalCount} cards</small>}</td><td>{processing?.processVersion??'Named batches · v1'}<small className={styles.batchFolder}>Identify once · no account-wide searches</small></td><td><button type="button" disabled={busy||!remaining} onClick={()=>{void createNamedDrafts(batch.id);}}>{remaining?'Create Drafts':batch.completedCount===batch.cards.length?'Drafted / archived':'Processing / see progress'}</button></td></tr>;})}</tbody></table></div>}
    </section>
    <details><summary>Advanced: process loose photo pairs directly</summary><p>Use named batches above for the normal two-stage flow.</p><button type="button" disabled={busy||loading||!snapshot} onClick={openPicker}>Choose loose photos</button></details>
    <section className={styles.pickerNotice} aria-label="Background eBay connection"><p role="status">{snapshot?.background?.detail??"Connect your dedicated eBay browser once. Batches then run without a chat handoff."}</p><p>This uses a separate browser session. You can keep using your mouse, keyboard and everyday browser.</p>{!snapshot?.background?.busy&&<button type="button" disabled={busy} onClick={()=>{void connectBackground();}}>{connectingBackground?"Opening sign-in…":snapshot?.background?.available?"Check eBay connection":"Connect eBay"}</button>}{snapshot?.background?.batchId&&snapshot.background.terminal&&snapshot.background.phase!=="complete"&&<button type="button" disabled={busy} onClick={()=>{void resumeBackground();}}>Resume saved batch</button>}</section>

    <div className={styles.statusLine} role="status" aria-live="polite">
      <span className={`${styles.dot} ${snapshot?.running ? styles.running : ""}`} aria-hidden="true" />
      <span>{loading ? "Reading saved checkpoints…" : snapshot?.running ? "Processing is running. Status refreshes automatically." : lastRun && !starting ? `Last run ${lastRun.status === "running" ? "interrupted" : lastRun.status} · ${when(lastRun.finishedAt || lastRun.startedAt)} CT` : feedback || "Ready to read new scans when you start a run."}</span>
      <button type="button" onClick={() => { void refresh(); }} disabled={loading}>Refresh</button>
    </div>
    {!!snapshot?.batches?.length && <button type="button" className={styles.quietLink} onClick={()=>{const batch=snapshot.batches![0];setProgressJobId(batch.jobId);setProgressPending([]);setProgressError("");clickStartedAt.current=batch.clickedAt;setProgressOpen(true);}}>View latest batch progress ↗</button>}
    {error && <div className={styles.error} role="alert">{error}</div>}

    <section className={styles.lanes} aria-label="Processing stages">
      <button type="button" aria-pressed={filter === "ready-for-pricing"} onClick={() => { setFilter(filter === "ready-for-pricing" ? "all" : "ready-for-pricing"); setPage(0); }}><span>Ready for pricing</span><strong>{snapshot ? readyForPricingCount.toLocaleString() : "—"}</strong><small>Non-price fields checked · photos archived</small></button>
      {stages.map(({ stage, label, detail }) => <button type="button" key={stage} aria-pressed={filter === stage} className={stage === "exception" ? styles.exceptionLane : ""} onClick={() => { setFilter(filter === stage ? "all" : stage); setPage(0); }}>
        <span>{label}</span><strong>{snapshot ? snapshot.summary.counts[stage]?.toLocaleString() ?? "0" : "—"}</strong><small>{detail}</small>
      </button>)}
    </section>

    {snapshot && <CardProcessingBatchHistory state={snapshot.state} batches={snapshot.batches}/>}
    {snapshot && <CardProcessingPriceCheck/>}
    {snapshot && <ProcessingTiming state={snapshot.state} batches={snapshot.batches} activity={snapshot.batchActivity}/>}
    <div className={styles.workspace}>
      <section className={styles.cards} aria-labelledby="cards-heading">
        <div className={styles.cardHeader}><div><h2 id="cards-heading">{filter === "all" ? "Card queue" : filter === "ready-for-pricing" ? "Ready for pricing" : stages.find(stage => stage.stage === filter)?.label}</h2><p>All tracked work: {cards.length.toLocaleString()} cards · {snapshot?.summary.photoCount ?? 0} photos · {verifiedDraftGroups.toLocaleString()} fully verified draft groups</p></div><button type="button" className={styles.all} onClick={() => { setFilter("all"); setSearch(""); setPage(0); }} disabled={filter === "all" && !search}>Show all cards</button></div>
        <label className={styles.search}><span>Find a card</span><input value={search} onChange={e => { setSearch(e.target.value); setPage(0); }} placeholder="Name, product, or SKU" maxLength={160} type="search" /></label>
        {!visible.length ? <div className={styles.empty}><div aria-hidden="true">▤</div><h3>{loading ? "Reading your queue" : cards.length ? "No cards in this view" : "Your next batch starts here"}</h3><p>{cards.length ? "Choose another stage or change your search." : "Start V2 once to protect existing scans. Then add new front and back pairs to your configured folder and process them. Uncertain cards retain a specific next action."}</p></div>
          : <div className={styles.table}><table><thead><tr><th>Card</th><th>Progress</th><th>Next action</th><th>eBay item</th></tr></thead><tbody>{visible.map(card => <tr key={card.id}>
            <td><div className={styles.cardIdentity}><div className={styles.photos}>{(["front", "back"] as const).map(side => <img key={side} src={`/api/card-processing-v2/photo?${new URLSearchParams({ card: card.id, side })}`} alt={`${card.identity?.name || "New scan pair"}, ${side} original preview`} loading="lazy" width={42} height={60} />)}</div><div><strong>{card.title || card.identity?.name || "New scan pair"}</strong><small>{card.identity ? `${card.identity.year} · ${card.identity.product} · #${card.identity.number}` : "Awaiting identification"}</small><small>{card.sku}</small>{card.groupId && <small>Exact copy group · {groupCounts.get(card.groupId)} physical card(s)</small>}</div></div></td>
            <td><span className={`${styles.badge} ${card.stage === "exception" ? styles.needsAttention : card.stage === "verified" ? styles.verified : ""}`}>{v2ArchivePresentation(card).stageLabel || stages.find(stage => stage.stage === card.stage)?.short}</span><small>{when(card.updatedAt)} CT</small></td>
            <td>{v2ArchivePresentation(card).archiveText && <p>{v2ArchivePresentation(card).archiveText}</p>}<p>{v2ArchivePresentation(card).nextAction}</p>{snapshot && <CardTiming card={card} state={snapshot.state}/>}<IdentificationNotes finding={card.identification}/>{card.issues.length > 0 && <details><summary>{card.issues.length} exception{card.issues.length === 1 ? "" : "s"}</summary><ul>{card.issues.map((item, index) => <li key={`${item.code}-${index}`}>{item.detail}<small>Next owner: {item.owner}</small></li>)}</ul></details>}</td>
            <td>{v2ArchivePresentation(card).href ? <a href={v2ArchivePresentation(card).href} target="_blank" rel="noreferrer">{v2ArchivePresentation(card).linkLabel} ↗</a> : <span className={styles.muted}>Not verified</span>}</td>
          </tr>)}</tbody></table></div>}
        {selected.length > 50 && <nav className={styles.paging} aria-label="Card queue pages"><button type="button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous</button><span>{currentPage * 50 + 1}–{Math.min((currentPage + 1) * 50, selected.length)} of {selected.length}</span><button type="button" disabled={currentPage + 1 >= pages} onClick={() => setPage(currentPage + 1)}>Next</button></nav>}
      </section>

      <aside className={styles.sidebar}>
        <section className={styles.panel}><div className={styles.kicker}>Before draft creation</div><h2>Completeness is a gate</h2><ul className={styles.checklist}><li>Searchable title within eBay’s limit</li><li>Category-specific item specifics</li><li>Matched, upright front and back photos</li><li>Supported condition fields</li><li>Reviewed description</li></ul><p>Prepared means local checks passed. Ready for pricing means the official upload results and saved bulk table were checked and original photos moved. Pricing and shipping remain deferred. Earlier individual-field verification receipts remain part of their original history.</p></section>
        <section className={styles.panel}><div className={styles.kicker}>eBay category resources</div><h2>Current fields and condition</h2><ul className={styles.categoryResources}>{([{ id: "261328", label: "Sports singles" }, { id: "183454", label: "Collectible card games" }, { id: "183050", label: "Non-sport singles" }] as const).map(category => {
          const capability = snapshot?.configuration.categoryCapabilities?.find(item => item.categoryId === category.id);
          return <li key={category.id}><div><strong>{category.label}</strong><span>{capability?.status === "ready" ? "Ready" : capability?.status === "blocked" ? "Needs attention" : "Not yet read"}</span></div>{capability ? <details><summary>Category status</summary><p>{capability.detail}</p>{capability.conditionHelpText && <p>eBay condition guidance: {capability.conditionHelpText}</p>}</details> : null}</li>;
        })}</ul><p>Required item specifics and Near mint condition identifiers come from current eBay metadata. Missing access or unsupported fields stay blocked.</p></section>
        <section className={styles.panel}><div className={styles.kicker}>Draft transport</div><h2>Bulk draft flow</h2><p>After identification, unpublished drafts are checked once. Exact matches add to an existing draft’s quantity while preserving its price; unmatched cards continue to bulk upload. Required defaults are saved once, followed by a result table check and photo movement. Individual photo, specifics and description dialogs are not reopened for every card.</p><details><summary>Historical method checkpoint</summary><p>{methodStatus === "validated" ? "Historical method evidence validated." : methodStatus === "not-validated" ? "The older complete-field method checkpoint is not validated. Current bulk-result receipts record the fields actually observed." : methodStatus || "Reading the retained checkpoint…"}</p></details></section>
        <section className={styles.panel}><div className={styles.kicker}>Model responsibilities</div><h2>Identity first. Pricing separate.</h2><p><strong>OpenAI</strong> identifies the card and prepares supported fields. Verified card information is reused.</p><p><strong>Grok</strong> owns pricing proposals through the separate pricing handoff. Unresolved pricing stays visible.</p><p>eBay AI descriptions are used only where supported and after correct identity fields. Publication remains with you.</p></section>
        <section className={styles.panel}><div className={styles.kicker}>Measured cost</div><h2>{cost ? usd(cost.measuredUsd) : "—"}<span className={styles.costLabel}> recorded identification cost</span></h2><dl className={styles.cost}><div><dt>Per identified card</dt><dd>{cost?.usdPerIdentifiedCard === null || cost?.usdPerIdentifiedCard === undefined ? "Not yet measurable" : usd(cost.usdPerIdentifiedCard)}</dd></div><div><dt>Unsettled calls</dt><dd>{cost?.unsettledCalls ?? "—"}</dd></div></dl><p>{cost?.scope || "Only retained usage is reported. Unavailable billing stays unknown."}</p></section>
      </aside>
    </div>

    <section className={styles.footerPanel} aria-labelledby="setup-heading"><h2 id="setup-heading">Processing setup</h2><dl><div><dt>Scan folder</dt><dd>{snapshot?.configuration.folder || "Loading…"}</dd></div><div><dt>Photo pairing</dt><dd>{snapshot?.configuration.pairing || "Loading…"}</dd></div><div><dt>Identification</dt><dd>{snapshot ? snapshot.configuration.identificationConfigured ? "Configured" : "Configuration required" : "Loading…"}</dd></div><div><dt>Category templates</dt><dd>{snapshot?.configuration.categoryCount ?? "—"} retained</dd></div></dl>{!!snapshot?.state.notices.length && <ul className={styles.notices}>{snapshot.state.notices.map((notice, index) => <li key={index}>{notice}</li>)}</ul>}</section>
    {!!snapshot?.state.events.length && <details className={styles.history}><summary>Recent checkpoints</summary><ol>{snapshot.state.events.slice(-15).reverse().map((event, index) => <li key={`${event.at}-${index}`}><time>{when(event.at)} CT</time><span>{event.detail}</span></li>)}</ol></details>}
    <dialog ref={pickerRef} className={styles.picker} aria-labelledby="v2-photo-picker-title" aria-describedby="v2-photo-picker-description" onCancel={event => { event.preventDefault(); closePicker(); }} onClose={() => { if (!starting) setPickerOpen(false); }}>
      <header className={styles.pickerHeader}><div><div className={styles.kicker}>Choose your next batch</div><h2 id="v2-photo-picker-title">{candidates?.activationRequired ? "Protect existing photos first" : "Which photos should we process?"}</h2><p id="v2-photo-picker-description">{candidates?.activationRequired ? "First activate V2 to protect photos already in your folder. This step does not process existing photos. After activation, add new scans and choose all eligible photos or specific card pairs." : "Choose all eligible photos or select specific cards. Each selection includes its front and back together."}</p></div><button type="button" className={styles.pickerClose} aria-label="Cancel photo selection" onClick={closePicker} disabled={starting}>×</button></header>
      <fieldset className={styles.pickerModes} disabled={busy || pickerLoading}><legend>Photo selection</legend>
        <label><input type="radio" name="v2-photo-mode" value="all" checked={selectionMode === "all"} onChange={() => setSelectionMode("all")} /><span><strong>All eligible photos</strong><small>Include every eligible front/back pair shown below.</small></span></label>
        <label><input type="radio" name="v2-photo-mode" value="selected" checked={selectionMode === "selected"} disabled={!!candidates?.activationRequired} onChange={() => { setSelectionMode("selected"); setSelectedCandidateIds([]); }} /><span><strong>Choose specific cards</strong><small>Select the pairs you want to process now.</small></span></label>
      </fieldset>
      <div className={styles.pickerTools}><span>{pickerLoading ? "Reading photo pairs…" : `${eligibleCandidates.length} eligible card${eligibleCandidates.length === 1 ? "" : "s"} · ${(candidates?.candidates.length ?? 0) - eligibleCandidates.length} needing review`}</span><div>
        <button type="button" disabled={busy || pickerLoading || !eligibleCandidates.length} onClick={() => { setSelectionMode("selected"); setSelectedCandidateIds(eligibleCandidates.map(candidate => candidate.id)); }}>Select all eligible</button>
        <button type="button" disabled={busy || pickerLoading || !!candidates?.activationRequired} onClick={() => { setSelectionMode("selected"); setSelectedCandidateIds([]); }}>Clear selection</button>
        <button type="button" disabled={busy || pickerLoading} onClick={() => { void loadCandidates(); }}>Refresh photos</button>
      </div></div>
      {pickerError && <p className={styles.pickerError} role="alert">{pickerError}</p>}
      {!snapshot?.background?.available&&<p className={styles.pickerNotice}>If eBay needs sign-in, this batch will wait in its separate browser before any identification charges.</p>}
      {!!candidates?.unmatchedPhotos && <p className={styles.pickerNotice}>{candidates.unmatchedPhotos} unmatched photo{candidates.unmatchedPhotos === 1 ? " is" : "s are"} retained. Only complete front/back pairs can be selected.</p>}
      <div className={styles.pickerList} aria-busy={pickerLoading}>
        {pickerLoading ? <p className={styles.pickerEmpty}>Checking new scans and saved checkpoints…</p> : !candidates?.candidates.length ? <p className={styles.pickerEmpty}>No paired cards are available. Add new front and back scans to your configured folder, then refresh. Existing work stays protected.</p> : candidates.candidates.map(candidate => {
          const checked = candidate.eligible && (selectionMode === "all" || selectedIds.has(candidate.id));
          return <label key={candidate.id} className={`${styles.pickerCard} ${!candidate.eligible ? styles.pickerHeld : ""} ${checked ? styles.pickerChosen : ""}`}>
            <input type="checkbox" checked={checked} disabled={!candidate.eligible || busy || pickerLoading} aria-label={`Process ${candidate.label}, front and back photos`} aria-describedby={`candidate-detail-${candidate.id}`} onChange={event => {
              const current = selectionMode === "all" ? eligibleCandidates.map(item => item.id) : selectedCandidateIds;
              setSelectionMode("selected"); setSelectedCandidateIds(event.target.checked ? [...current.filter(id => id !== candidate.id), candidate.id] : current.filter(id => id !== candidate.id));
            }} />
            <span className={styles.pickerPhotos}><span><img src={candidate.frontUrl} alt={`${candidate.label}, front`} loading="lazy" width={64} height={88} /><small>Front</small></span><span><img src={candidate.backUrl} alt={`${candidate.label}, back`} loading="lazy" width={64} height={88} /><small>Back</small></span></span>
            <span className={styles.pickerCardText}><strong>{candidate.label}</strong><span>{candidate.eligible ? "Eligible" : candidate.stage === "protected" ? "Protected" : "Needs review"} · {candidate.stage.replace(/-/g, " ")} · 2 photos</span><small id={`candidate-detail-${candidate.id}`}>{candidate.detail}</small></span>
          </label>;
        })}
      </div>
      <footer className={styles.pickerFooter}><div role="status" aria-live="polite"><strong>{candidates?.activationRequired ? "Activate before selecting new scans" : `${chosenCandidates.length} card${chosenCandidates.length === 1 ? "" : "s"} selected`}</strong><span>{candidates?.activationRequired ? "Existing photos stay in their current workflow" : `${chosenPhotoCount} photos · front/back pairs stay together`}</span></div><div><button type="button" onClick={closePicker} disabled={starting}>Cancel</button><button type="button" className={styles.process} disabled={busy || pickerLoading || !candidates || !chosenCandidates.length && !candidates.activationRequired || !!snapshot?.running} onClick={() => { void processSelection(); }}>{starting ? "Starting background run…" : candidates?.activationRequired ? "Activate V2" : `Process ${chosenPhotoCount} selected photos`}</button></div></footer>
    </dialog>
    <CardProcessingProgress open={progressOpen} state={snapshot?.state} batch={snapshot?.batches?.find(batch=>batch.jobId===progressJobId)} activity={snapshot?.batchActivity} pending={progressPending} clickedAt={clickStartedAt.current} workflow={snapshot?.background?.batchId===progressJobId?snapshot.background:undefined} error={progressError} onClose={()=>setProgressOpen(false)}/>
  </main>;
}

