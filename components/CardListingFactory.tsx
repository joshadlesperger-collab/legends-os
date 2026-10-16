"use client";

import { useEffect, useRef, useState } from "react";
import { applyIdentityCorrection, generateTitle, projectListing, type CardIdentity } from "@/lib/card-listing-factory";
import { assignPhoto, pairPhotoIds, type PairedCard, type PairOrder, type PhotoSide } from "@/lib/card-photo-pairing";
import CardPricingReview from "@/components/CardPricingReview";
import { projectPricing } from "@/lib/card-pricing-review";
import { emptyPricing, type SoldComp } from "@/lib/card-pricing-review";
import { recognitionSchema, recognizedIdentity } from "@/lib/card-recognition";
import { prepareEbayDraftReview } from "@/lib/card-ebay-draft";
import { blankMarginIssue, previewDimensions, withPhotoSourceReview } from "@/lib/card-photo-source";

type Photo = { id: string; file: File; previewUrl: string; originalUrl: string; width: number; height: number; framingIssue?: string };
const emptyIdentity = (): CardIdentity => ({ sport: "Baseball", player: "", year: new Date().getFullYear(), manufacturer: "", set: "", cardNumber: "" });
const newCard = (frontImageId?: string, backImageId?: string): PairedCard => ({ id: crypto.randomUUID(), draft: { identity: emptyIdentity(), quantity: 1, verified: false, frontImageId, backImageId } });
const sports: CardIdentity["sport"][] = ["Baseball", "Football", "Basketball", "Hockey", "Soccer", "Other"];
const textFields = { player: "Player", manufacturer: "Manufacturer", set: "Set", cardNumber: "Card number", team: "Team", parallel: "Parallel / variety", serialNumber: "Serial number (e.g. 30 or 30/50)", grade: "Grade / grading company", condition: "Observed condition" } as const;
const MAX_PHOTOS = 40;
const MAX_BYTES = 100 * 1024 * 1024;

// Decode sequentially, retain originals, and use small previews to bound decoded browser memory.
async function preview(file: File) {
  const source = URL.createObjectURL(file);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve(); image.onerror = () => reject(new Error("Unreadable image")); image.src = source;
    });
    const dimensions = previewDimensions(image.naturalWidth, image.naturalHeight);
    const canvas = document.createElement("canvas");
    canvas.width = dimensions.width; canvas.height = dimensions.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image preview unavailable");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const framingIssue = blankMarginIssue(context.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("Image preview failed")), "image/jpeg", 0.85));
    return { previewUrl: URL.createObjectURL(blob), width: image.naturalWidth, height: image.naturalHeight, framingIssue };
  } finally { URL.revokeObjectURL(source); }
}

export default function CardListingFactory() {
  const [mode, setMode] = useState<"single" | "bulk">("single");
  const [order, setOrder] = useState<PairOrder>("alternating");
  const [cards, setCards] = useState<PairedCard[]>([]);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [selected, setSelected] = useState(0);
  const [warning, setWarning] = useState("");
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [automatic, setAutomatic] = useState(false);
  const [progress, setProgress] = useState("");
  const [capabilities, setCapabilities] = useState<{ recognitionConfigured: boolean; soldCompsConfigured: boolean }>();
  const pipeline = useRef<AbortController>();
  const resources = useRef(new Set<string>());
  const importing = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    try { setAutomatic(localStorage.getItem("legends-photo-automation-consent-v1") === "enabled"); } catch { /* Session-only mode when storage is unavailable. */ }
    const urls = resources.current;
    void fetch("/api/card-listing-factory/recognize").then(response => response.ok ? response.json() : undefined).then(value => { if (mounted.current && value) setCapabilities(value); }).catch(() => {});
    return () => { mounted.current = false; pipeline.current?.abort(); urls.forEach(url => URL.revokeObjectURL(url)); urls.clear(); };
  }, []);
  useEffect(() => {
    if (!photos.length) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [photos.length]);
  const card = cards[selected];
  const reviewedDraft = card ? withPhotoSourceReview(card.draft, photos) : undefined;
  const projection = reviewedDraft ? projectListing(reviewedDraft) : undefined;
  const ebayHandoff = reviewedDraft ? prepareEbayDraftReview(reviewedDraft) : undefined;
  const canApprove = reviewedDraft && !projectListing({ ...reviewedDraft, verified: true }).requiresReview;
  const findPhoto = (id?: string) => photos.find(p => p.id === id);
  function updateDraft(change: (draft: PairedCard["draft"]) => PairedCard["draft"]) {
    setCards(current => current.map(c => c.id === card.id ? { ...c, draft: change(c.draft) } : c));
  }
  function correction(fields: Partial<CardIdentity>) { updateDraft(draft => applyIdentityCorrection(draft, fields)); }
  async function requestResearch(draft: PairedCard["draft"], signal: AbortSignal) {
    const response = await fetch("/api/card-listing-factory/research", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ identity: draft.identity }), signal });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Sold research failed.");
    return result as { status: string; message: string; comps: SoldComp[]; excluded: { title: string; reason: string }[] };
  }
  async function prepareCards(targets: PairedCard[], pool: Photo[]) {
    if (pipeline.current) return;
    const controller = new AbortController(); pipeline.current = controller; setBusy(true);
    try {
      for (let index = 0; index < targets.length; index++) {
        const target = targets[index];
        const ids = [target.draft.frontImageId, target.draft.backImageId];
        const pair = ids.map(id => pool.find(photo => photo.id === id));
        if (!pair[0] || !pair[1]) continue;
        setProgress(`Reading card ${index + 1} of ${targets.length}…`);
        try {
          const images = await Promise.all(pair.map(async photo => {
            const blob = await (await fetch(photo!.previewUrl)).blob();
            return new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error("Preview unavailable")); reader.readAsDataURL(blob); });
          }));
          const response = await fetch("/api/card-listing-factory/recognize", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ images }), signal: controller.signal });
          const body = await response.json(); if (!response.ok) throw new Error(body.error || "Recognition failed.");
          const result = recognitionSchema.parse(body);
          if (!result.pairMatches || result.frontImageIndex === "unknown") throw new Error("Photos could not be established as a front/back pair of the same card. Check pairing and photo clarity.");
          let nextDraft: PairedCard["draft"] = { ...target.draft, identity: recognizedIdentity(result), verified: false, manualTitle: undefined,
            frontImageId: ids[Number(result.frontImageIndex)], backImageId: ids[1 - Number(result.frontImageIndex)],
            pricing: undefined, automation: { message: "Photo identity prepared. Review before approving.", warnings: result.warnings } };
          if (!projectListing({ ...nextDraft, verified: true }).requiresReview) {
            setProgress(`Researching sold comps for card ${index + 1} of ${targets.length}…`);
            try {
              const research = await requestResearch(nextDraft, controller.signal);
              nextDraft = { ...nextDraft, pricing: { ...emptyPricing(), comps: research.comps }, automation: { message: research.message, warnings: [...result.warnings, ...research.excluded.map(row => `${row.title}: ${row.reason}`)] } };
            } catch (error) { if (controller.signal.aborted) throw error; nextDraft.automation!.message = "Photo identity prepared; sold research failed. No price was invented."; }
          } else nextDraft.automation!.message = "Photo identity needs corrections before sold research. Missing fields were left blank.";
          if (controller.signal.aborted || !mounted.current) break;
          setCards(current => current.map(card => card.id === target.id ? { ...card, draft: nextDraft } : card));
        } catch (error) {
          if (controller.signal.aborted || !mounted.current) break;
          const message = error instanceof Error && error.message.length < 300 ? error.message : "Automatic preparation failed. Existing fields were preserved.";
          setCards(current => current.map(card => card.id === target.id ? { ...card, draft: { ...card.draft, automation: { message, warnings: [] } } } : card));
        }
      }
    } finally { pipeline.current = undefined; if (mounted.current) { setBusy(false); setProgress(""); } }
  }
  async function researchSelected() {
    if (pipeline.current || !card) return;
    const controller = new AbortController(); pipeline.current = controller; setBusy(true); setProgress("Researching exact sold comps…");
    const id = card.id;
    try {
      const result = await requestResearch(card.draft, controller.signal);
      if (!controller.signal.aborted && mounted.current) setCards(current => current.map(value => value.id === id ? { ...value, draft: { ...value.draft,
        pricing: result.status === "ready" ? { ...(value.draft.pricing ?? emptyPricing()), comps: result.comps, approvedSnapshot: undefined } : value.draft.pricing,
        automation: { message: result.message, warnings: result.excluded.map(row => `${row.title}: ${row.reason}`) } } } : value));
    } catch { if (!controller.signal.aborted && mounted.current) setWarning("Sold research failed. Existing evidence was preserved."); }
    finally { pipeline.current = undefined; if (mounted.current) { setBusy(false); setProgress(""); } }
  }
  async function ingest(files: FileList | null, side?: PhotoSide) {
    if (!files?.length || importing.current) return;
    const batch = Array.from(files);
    if ((side && batch.length !== 1) || (!side && mode === "single" && batch.length !== 2)) {
      setWarning(side ? "Choose one photo for this side." : "Choose exactly two photos, or add a blank card and upload each side separately."); return;
    }
    if (batch.some(f => !["image/jpeg", "image/png", "image/webp"].includes(f.type) || f.size === 0 || f.size > 20 * 1024 * 1024)) {
      setWarning("Choose JPEG, PNG or WebP photos, up to 20 MB each. Export HEIC photos as JPEG first. No files from this selection were added."); return;
    }
    if (photos.length + batch.length > MAX_PHOTOS || [...photos.map(p => p.file), ...batch].reduce((n, f) => n + f.size, 0) > MAX_BYTES) {
      setWarning("Session limit: 40 photos or 100 MB of originals. Remove unused photos or clear the session before adding more."); return;
    }
    importing.current = true; setBusy(true); setWarning("");
    const incoming: Photo[] = [];
    const targetId = card?.id;
    try {
      for (const file of batch) {
        const prepared = await preview(file);
        incoming.push({ id: crypto.randomUUID(), file, ...prepared, originalUrl: URL.createObjectURL(file) });
        if (!mounted.current) throw new Error("Session closed");
      }
      incoming.forEach(p => { resources.current.add(p.previewUrl); resources.current.add(p.originalUrl); });
      setPhotos(current => [...current, ...incoming]);
      if (side && targetId) {
        const changed = assignPhoto(cards, targetId, side, incoming[0].id);
        setCards(current => assignPhoto(current, targetId, side, incoming[0].id));
        if (automatic) await prepareCards(changed.filter(value => value.id === targetId), [...photos, ...incoming]);
      }
      else {
        const pairs = pairPhotoIds(incoming.map(p => p.id), order).map(([front, back]) => newCard(front, back));
        setCards(current => [...current, ...pairs]); setSelected(cards.length);
        if (incoming.length % 2) setWarning("Last card needs a back photo. Use Add back photo to complete it.");
        if (automatic) await prepareCards(pairs, [...photos, ...incoming]);
      }
    } catch {
      incoming.forEach(p => { for (const url of [p.previewUrl, p.originalUrl]) { URL.revokeObjectURL(url); resources.current.delete(url); } });
      if (mounted.current) setWarning("Could not preview this selection. Use readable JPEG, PNG or WebP images up to 32 megapixels. No photos were added.");
    } finally { importing.current = false; if (mounted.current) setBusy(false); }
  }
  function release(photo: Photo) { for (const url of [photo.previewUrl, photo.originalUrl]) { URL.revokeObjectURL(url); resources.current.delete(url); } }
  function clear() { photos.forEach(release); setPhotos([]); setCards([]); setSelected(0); setWarning(""); }
  function removeCard() {
    setCards(current => current.filter(c => c.id !== card.id)); setSelected(Math.max(0, selected - 1));
    // Photos remain in the pool so mistaken deletion can be repaired without re-uploading.
  }
  function exportJson() {
    const output = cards.map(c => { const draft = withPhotoSourceReview(c.draft, photos); return ({ id: c.id, identity: draft.identity, quantity: draft.quantity,
      approved: !projectListing(draft).requiresReview,
      identityApproved: !projectListing(draft).requiresReview,
      pricingReview: projectPricing(draft),
      ebayDraftHandoff: prepareEbayDraftReview(draft),
      readyForLocalDraftReview: !projectListing(draft).requiresReview && projectPricing(draft).approved,
      automation: draft.automation,
      frontImageId: draft.frontImageId ?? null, backImageId: draft.backImageId ?? null,
      mainImageId: draft.frontImageId ?? null,
      imageIds: [draft.frontImageId, draft.backImageId].filter((id): id is string => Boolean(id)),
      frontImageName: findPhoto(draft.frontImageId)?.file.name ?? null,
      backImageName: findPhoto(draft.backImageId)?.file.name ?? null, listing: projectListing(draft) }); });
    const photoManifest = photos.map(p => ({ id: p.id, name: p.file.name, size: p.file.size, lastModified: p.file.lastModified, width: p.width, height: p.height, listingSource: "original-file-only", framingIssue: p.framingIssue, previewPurpose: "display-and-recognition-only" }));
    const url = URL.createObjectURL(new Blob([JSON.stringify({ schema: "legends-card-listing-review-v1", destination: "local-review-only", photos: photoManifest, cards: output }, null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = "legends-listing-review.json"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <main className="page factory-page">
    <div className="eyebrow">Legends OS · Listing Factory</div><h1>Card Listing Factory</h1>
    <p>Upload photos → automatic identity and front/main-photo assignment → exact sold-comp research → your review. Ambiguous cards and unavailable evidence stop for correction. eBay draft creation and publishing are not connected.</p>
    <label><span><input type="checkbox" disabled={busy} checked={automatic} onChange={event => { setAutomatic(event.target.checked); try { localStorage.setItem("legends-photo-automation-consent-v1", event.target.checked ? "enabled" : "disabled"); } catch { /* Preserve current session choice. */ } }} /> Automatically prepare new photo pairs (send previews to OpenAI)</span></label>
    <p>With automatic preparation on, photo previews are sent to OpenAI for recognition. Fields remain unapproved until reviewed. {capabilities ? `Photo recognition: ${capabilities.recognitionConfigured ? "configured" : "not configured"}. Provider lookup: ${capabilities.soldCompsConfigured ? "configured" : "not configured"}. eBay browser-assisted research remains available without a provider connection.` : "Checking automation connections…"}</p>
    <p role="note">Photos and edits last only until you leave or refresh this page. Export review data before leaving; the export contains field data and filenames, not the photos.</p>
    <div className="factory-actions">
      <button disabled={busy} onClick={() => setMode("single")} aria-pressed={mode === "single"}>Single Card</button>
      <button disabled={busy} onClick={() => setMode("bulk")} aria-pressed={mode === "bulk"}>Bulk Upload</button>
      <button disabled={busy || cards.length >= 40} onClick={() => { setCards(current => [...current, newCard()]); setSelected(cards.length); }}>Add blank card</button>
      <button disabled={busy || !photos.length && !cards.length} onClick={clear}>Clear session</button>
    </div>
    {mode === "bulk" && <label>Photo order<select disabled={busy} value={order} onChange={e => setOrder(e.target.value as PairOrder)}><option value="alternating">Front, back, front, back</option><option value="fronts-first">All fronts, then all backs (same card order)</option></select></label>}
    <label className="factory-upload" style={dragging ? { borderColor: "var(--gold)", background: "var(--surface-2)" } : undefined}
      onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = busy ? "none" : "copy"; setDragging(!busy); }}
      onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
      onDrop={event => { event.preventDefault(); setDragging(false); if (!busy) void ingest(event.dataTransfer.files); }}>
      <strong>{mode === "single" ? "Drop front and back photos here, or choose files" : "Drop multiple photos here, or choose files"}</strong>
      <input disabled={busy} aria-label="Choose card photos" type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={e => { void ingest(e.target.files); e.target.value = ""; }} />
    </label>
    <p>For multiple cards, choose Bulk Upload and select the photo order before dropping files. Check every pair: the photo assigned to Front is always the main image, followed by Back. JPEG, PNG, WebP · 20 MB per photo · 40 photos / 100 MB per session.</p>
    {busy && <p role="status">{progress || "Preparing photo previews…"} {pipeline.current && <button type="button" onClick={() => pipeline.current?.abort()}>Stop preparation</button>}</p>}
    {warning && <p role="alert">{warning} <button onClick={() => setWarning("")}>Dismiss</button></p>}
    <p>{cards.length} cards · {photos.length} photos · {cards.filter(c => !projectListing(c.draft).requiresReview).length} approved for local review</p>
    {cards.length > 0 && <div className="factory-review">
      <nav aria-label="Cards to review">{cards.map((c, i) => <button disabled={busy} key={c.id} onClick={() => setSelected(i)} aria-pressed={selected === i}>{i + 1}. {c.draft.identity.player || "Unidentified card"}<small>{projectListing(c.draft).requiresReview ? "Needs review" : "Approved locally"}</small></button>)}</nav>
      {card && projection && <section>
        <fieldset disabled={busy} style={{ border: 0, padding: 0, minWidth: 0 }}>
        <h2>Review card {selected + 1}</h2>
        <div className="factory-actions"><button type="button" onClick={() => void prepareCards([card], photos)} disabled={!card.draft.frontImageId || !card.draft.backImageId}>Prepare this card automatically</button><a href={`https://www.ebay.com/sch/i.html?${new URLSearchParams({ _nkw: generateTitle(card.draft.identity), LH_Sold: "1", LH_Complete: "1" })}`} target="_blank" rel="noreferrer">Research eBay sold listings</a><button type="button" onClick={() => void researchSelected()} disabled={!capabilities?.soldCompsConfigured || projectListing({ ...card.draft, verified: true }).requiresReview}>Sold comps (connected provider)</button></div>
        <p>Preparing again replaces identity suggestions and price evidence, then requires review again.</p>
        {card.draft.automation && <div role="status"><strong>{card.draft.automation.message}</strong>{card.draft.automation.warnings.length > 0 && <details><summary>Recognition / evidence exceptions</summary><ul>{card.draft.automation.warnings.map((message,index) => <li key={index}>{message}</li>)}</ul></details>}</div>}
        <div className="factory-photos">{(["front", "back"] as const).map(side => {
          const photo = findPhoto(side === "front" ? card.draft.frontImageId : card.draft.backImageId);
          return <div key={side}><h3>{side === "front" ? "Front · Main image #1" : "Back · Image #2"}</h3>
            {photo ? <><a href={photo.previewUrl} target="_blank" rel="noreferrer" aria-label={`Open ${side} preview`}><img src={photo.previewUrl} alt={`${side}: ${photo.file.name}`} /></a>
              <p><a href={photo.originalUrl} download={photo.file.name}>Download original {side} photo</a> · {photo.width} × {photo.height}</p>
              {photo.framingIssue && <p role="alert">{photo.framingIssue}</p>}</> : <p>Missing photo</p>}
            {photo && <small>{photo.file.name}</small>}
            <label>Assign {side} photo<select disabled={busy} value={photo?.id ?? ""} onChange={e => setCards(current => assignPhoto(current, card.id, side, e.target.value || undefined))}><option value="">No photo</option>{photos.map((p, i) => <option key={p.id} value={p.id}>{i + 1}. {p.file.name}</option>)}</select></label>
            <label>Add {side} photo<input disabled={busy} type="file" accept="image/jpeg,image/png,image/webp" onChange={e => { void ingest(e.target.files, side); e.target.value = ""; }} /></label>
          </div>;
        })}</div>
        <div className="factory-actions"><button disabled={busy} onClick={() => setCards(current => current.map(c => c.id === card.id ? { ...c, draft: { ...c.draft, frontImageId: c.draft.backImageId, backImageId: c.draft.frontImageId, verified: false } } : c))}>Swap front / back</button><button disabled={busy} onClick={removeCard}>Remove card (keep photos)</button></div>
        <div className="factory-fields">
          <label>Sport<select value={card.draft.identity.sport} onChange={e => correction({ sport: e.target.value as CardIdentity["sport"] })}>{sports.map(s => <option key={s}>{s}</option>)}</select></label>
          {Object.entries(textFields).map(([key, label]) => <label key={key}>{label}<input value={card.draft.identity[key as keyof typeof textFields] ?? ""} onChange={e => correction({ [key]: e.target.value })} /></label>)}
          <label>Year<input type="number" value={card.draft.identity.year || ""} onChange={e => correction({ year: Number(e.target.value) })} /></label>
          <label>Print run (/N)<input type="number" min={1} step={1} value={card.draft.identity.numberedTo ?? ""} onChange={e => correction({ numberedTo: e.target.value ? Number(e.target.value) : undefined })} /></label>
          {(["rookie", "autograph", "graded"] as const).map(key => <label key={key}><span><input type="checkbox" checked={!!card.draft.identity[key]} onChange={e => correction({ [key]: e.target.checked })} /> {key}</span></label>)}
        </div>
        <p>Quantity: <strong>1</strong> physical card per pair. Add each additional copy as its own card.</p>
        <p><strong>Storage:</strong> {projection.storageLocation}</p><p><strong>Proposed title ({projection.title.length}/80):</strong> {projection.title}</p>
        <details><summary>Item specifics</summary>{Object.entries(projection.specifics).map(([key, value]) => <p key={key}>{key}: {value}</p>)}</details>
        <p className="factory-description"><strong>Description:</strong> {projection.description}</p>
        {projection.reviewReasons.length > 0 && <div role="status"><strong>Review required:</strong><ul>{projection.reviewReasons.map(reason => <li key={reason}>{reason}</li>)}</ul></div>}
        <button disabled={busy || !canApprove || card.draft.verified} onClick={() => updateDraft(draft => projectListing({ ...draft, verified: true }).requiresReview ? draft : { ...draft, verified: true })}>Confirm identity and photo pair for local review</button>
        <p>This confirmation does not approve an eBay publish. Any identity or photo change requires confirmation again.</p>
        <CardPricingReview draft={reviewedDraft!} onChange={pricing => updateDraft(draft => ({ ...draft, pricing }))} />
        <details><summary>eBay draft preparation · imaydit58</summary>
          <p>The intended seller is imaydit58. This prepares a local handoff, not an eBay offer or a listing.</p>
          <p>{ebayHandoff?.localReviewReady ? "Local review is approved and ready for the connection checks below." : "Finish identity, photo and price approvals before preparing the handoff."}</p>
          <ul>{ebayHandoff?.connectionRequirements.map(reason => <li key={reason}>{reason}</li>)}</ul>
          <p>Export review data includes this handoff and its outstanding checks. Creating an unpublished offer and publishing remain disabled.</p>
        </details>
        </fieldset>
      </section>}
    </div>}
    {photos.some(p => !cards.some(c => c.draft.frontImageId === p.id || c.draft.backImageId === p.id)) && <details><summary>Unused photos (available for reassignment)</summary>{photos.filter(p => !cards.some(c => c.draft.frontImageId === p.id || c.draft.backImageId === p.id)).map(p => <p key={p.id}>{p.file.name} <button disabled={busy} onClick={() => { release(p); setPhotos(current => current.filter(x => x.id !== p.id)); }}>Remove unused photo</button></p>)}</details>}
    {cards.length > 0 && <p><button disabled={busy} onClick={exportJson}>Export review data (JSON)</button> Includes approval status and review warnings for each card. Keep your original photos.</p>}
  </main>;
}
