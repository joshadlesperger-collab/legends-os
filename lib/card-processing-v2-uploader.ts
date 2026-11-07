import { measureV2 } from "./card-processing-v2-timing.ts";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { z } from "zod";
import { digest, event, issue, nowIso } from "./card-processing-v2.ts";
import { acquireV2Lock, readV2State, v2Dir, withV2State } from "./card-processing-v2-store.ts";
import { draftCsv } from "./card-processing-v2-transport.ts";
import { recordV2Import, validateV2DraftForUpload } from "./card-processing-v2-draft-lifecycle.ts";

/** Candidate Feed transport. Actual 2026-11-03 FX_LISTING Draft upload was
 * rejected BAF.Error.5; Draft support is NOT validated for this API route.
 * https://developer.ebay.com/api-docs/sell/static/feed/fx-feeds-overview.html
 * https://developer.ebay.com/api-docs/sell/static/feed/fx-feeds-quick-reference.html
 * https://developer.ebay.com/api-docs/master/sell/feed/openapi/3/sell_feed_v1_oas3.json
 */
export const V2_FEED_BASE = "https://api.ebay.com/sell/feed/v1";
const taskIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/), hash = z.string().regex(/^[a-f0-9]{64}$/);
const statusSchema = z.object({ taskId: taskIdSchema, feedType: z.literal("FX_LISTING").optional(), schemaVersion: z.literal("1.0").optional(),
  status: z.enum(["CREATED", "QUEUED", "IN_PROCESS", "COMPLETED", "COMPLETED_WITH_ERROR", "ABORTED", "FAILED"]),
  uploadSummary: z.object({ successCount: z.number().int().nonnegative().optional(), failureCount: z.number().int().nonnegative().optional() }).passthrough().optional(),
}).passthrough();
export type DraftFeedTask = z.infer<typeof statusSchema>;
export type DraftFeedBinding = { key: string; sku: string; captureIds: string[]; lineNumber: number };
export type DraftFeedRow = DraftFeedBinding & { status: "success" | "failed" | "uncertain"; draftId?: string; errorCode: string; warningCode: string };

/** Bounded RFC4180 parsing with physical input line provenance. Never evaluate CSV. */
export function parseV2FeedCsv(csv: string): { cells: string[]; lineNumber: number }[] {
  if (Buffer.byteLength(csv, "utf8") > 16_000_000) throw Error("Draft feed exceeds the bounded file size");
  const rows: { cells: string[]; lineNumber: number }[] = []; let cells: string[] = [], field = "", quoted = false, afterQuote = false, line = 1, startLine = 1;
  csv = csv.replace(/^\uFEFF/, "");
  const finishField = () => { cells.push(field); field = ""; afterQuote = false; if (cells.length > 500) throw Error("Too many feed columns"); };
  const finishRow = () => { finishField(); if (cells.some(c => c.length)) rows.push({ cells, lineNumber: startLine }); cells = []; if (rows.length > 1000) throw Error("Too many feed rows"); };
  for (let n = 0; n < csv.length; n++) {
    const c = csv[n];
    if (quoted) {
      if (c === '"') { if (csv[n + 1] === '"') { field += '"'; n++; } else { quoted = false; afterQuote = true; } }
      else { field += c; if (c === "\n") line++; }
    } else if (c === '"') { if (field || afterQuote) throw Error("Malformed CSV quoting"); quoted = true; }
    else if (c === ",") finishField();
    else if (c === "\r" || c === "\n") { if (c === "\r" && csv[n + 1] === "\n") n++; finishRow(); line++; startLine = line; }
    else { if (afterQuote && !/\s/.test(c)) throw Error("Unexpected content after CSV quote"); if (!afterQuote) field += c; }
  }
  if (quoted) throw Error("Unterminated CSV field"); if (field || cells.length || afterQuote) finishRow(); return rows;
}
export function assertV2DraftOnlyCsv(csv: string) {
  const rows = parseV2FeedCsv(csv).filter(r => !r.cells[0]?.startsWith("#INFO"));
  // Full category templates use Info rather than the legacy #INFO envelope.
  // Accept this exact official family only, never arbitrary metadata/data rows.
  if (rows[0]?.cells[0] === 'Info') {
    if (rows[0].cells.length !== 3 || rows[0].cells.join(',') !== 'Info,Version=1.0.0,Template=fx_category_template_EBAY_US') throw Error('Unsupported full category Draft metadata');
    rows.shift();
  }
  const header = rows.shift(); if (!header || !/^\*?Action(?:\(|$)/i.test(header.cells[0])) throw Error("Official Draft action header is required");
  if (!rows.length || rows.length > 500 || rows.some(r => r.cells[0] !== "Draft" || r.cells.length !== header.cells.length)) throw Error("Only bounded Draft rows can be uploaded; Add/Revise/Relist are prohibited");
  return { header, rows };
}
async function boundedBytes(response: Response, maximum = 16_000_000) {
  if (Number(response.headers.get("content-length")) > maximum) throw Error("eBay feed response exceeds bounded size");
  const reader = response.body?.getReader(); if (!reader) return Buffer.alloc(0);
  const parts: Uint8Array[] = []; let size = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > maximum) { await reader.cancel(); throw Error("eBay feed response exceeds bounded size"); } parts.push(value); }
  return Buffer.concat(parts);
}
async function boundedText(response: Response, maximum = 16_000_000) { return (await boundedBytes(response, maximum)).toString("utf8"); }
/** The official result contract allows csv.gz. Decompress in memory with a hard
 * output bound; never extract remote files or execute downloaded content. */
export function decodeV2DraftFeedResult(bytes: Uint8Array) {
  if (bytes.length > 16_000_000) throw Error("Feed result exceeds bounded size");
  const buffer = Buffer.from(bytes);
  if (buffer[0] === 0x1f && buffer[1] === 0x8b) {
    try { return gunzipSync(buffer, { maxOutputLength: 16_000_000 }).toString("utf8"); }
    catch { throw Error("Compressed feed result is invalid or exceeds the bounded output size"); }
  }
  if (buffer[0] === 0x50 && buffer[1] === 0x4b) throw Error("ZIP result requires an explicitly supported single-file decoder; no rows were inferred");
  return buffer.toString("utf8");
}
function httpFailure(phase: string, status: number) { return Error(`eBay Draft feed ${phase} returned HTTP ${status}; access or task reconciliation is required. No automatic retry.`); }
export function createDraftFeedClient(token: string, fetcher: typeof fetch = fetch) {
  if (!token.trim()) throw Error("Existing seller OAuth access is required for Draft feed uploads");
  const headers = { Authorization: `Bearer ${token}`, "X-EBAY-C-MARKETPLACE-ID": "EBAY_US" };
  const request = async (suffix: string, init: RequestInit = {}) => {
    try { return await fetcher(`${V2_FEED_BASE}${suffix}`, { ...init, headers: { ...headers, ...init.headers }, redirect: "error", signal: AbortSignal.timeout(30_000) }); }
    catch { throw Error("eBay Draft feed request did not return a confirmed result; reconcile the same operation. No automatic retry."); }
  };
  return {
    async createTask() {
      const response = await request("/task", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ feedType: "FX_LISTING", schemaVersion: "1.0" }) });
      if (response.status !== 202) throw httpFailure("task creation", response.status);
      const location = response.headers.get("location"); if (!location) throw Error("Created feed task has no retained Location; reconcile existing tasks before retrying");
      const u = new URL(location, V2_FEED_BASE);
      if (u.origin !== "https://api.ebay.com" || u.search || u.hash || !u.pathname.startsWith("/sell/feed/v1/task/")) throw Error("Unexpected eBay task Location; reconcile before retrying");
      return taskIdSchema.parse(u.pathname.slice("/sell/feed/v1/task/".length));
    },
    async uploadFile(taskId: string, csv: string) {
      taskIdSchema.parse(taskId); assertV2DraftOnlyCsv(csv);
      const form = new FormData(); form.set("file", new Blob([csv], { type: "text/csv" }), "legends-v2-drafts.csv");
      const response = await request(`/task/${taskId}/upload_file`, { method: "POST", body: form });
      if (![200, 202].includes(response.status)) throw httpFailure("file upload", response.status);
    },
    async getTask(taskId: string): Promise<DraftFeedTask> {
      taskIdSchema.parse(taskId); const response = await request(`/task/${taskId}`);
      if (response.status !== 200) throw httpFailure("status read", response.status);
      const task = statusSchema.parse(JSON.parse(await boundedText(response, 1000000)));
      if (task.taskId !== taskId) throw Error("eBay returned a foreign feed task; stop for reconciliation"); return task;
    },
    async downloadResult(taskId: string) {
      taskIdSchema.parse(taskId); const response = await request(`/task/${taskId}/download_result_file`);
      if (response.status !== 200) throw httpFailure("result download", response.status);
      return decodeV2DraftFeedResult(await boundedBytes(response));
    },
  };
}

export function parseDraftFeedResults(csv: string, expected: DraftFeedBinding[]): DraftFeedRow[] {
  const rows = parseV2FeedCsv(csv), header = rows.shift()?.cells; if (!header) throw Error("Feed result report is empty");
  const sellerHubHeader = ["LineNumber", "DraftID", "Title", "Status", "Link to complete draft", "ErrorCode", "ErrorMessage"];
  if (header.length === sellerHubHeader.length && header.every((name, n) => name === sellerHubHeader[n])) return parseSellerHubDraftResults(rows, expected);
  const column = (name: string) => header.findIndex(h => h.trim().toLowerCase() === name.toLowerCase());
  const action = column("Action"), status = column("Status"), draft = column("DraftID"), line = column("Line Number"), sku = [column("CustomLabel"), column("Custom label (SKU)"), column("SKU")].find(n => n >= 0) ?? -1;
  const error = column("ErrorCode"), warning = column("WarningCode"), item = column("ItemID"), reference = column("ReferenceID");
  if ([action, status, line].some(n => n < 0)) throw Error("Feed result lacks required Draft and exact row-mapping fields");
  if (!expected.length || new Set(expected.map(e => e.lineNumber)).size !== expected.length || new Set(expected.map(e => e.key)).size !== expected.length || new Set(expected.map(e => e.sku)).size !== expected.length) throw Error("Input row bindings are ambiguous");
  const found = new Map<string, DraftFeedRow>(), ids = new Set<string>();
  for (const row of rows) {
    const data = row.cells; const bound = expected.find(e => e.lineNumber === Number(data[line]));
    if (!bound || found.has(bound.key) || data[action] !== "Draft" || (item >= 0 && data[item]?.trim()) || (reference >= 0 && data[reference]?.trim()) || sku >= 0 && data[sku]?.trim() && data[sku].trim() !== bound.sku) throw Error("Feed result has an unknown, duplicate or non-Draft row; reconcile without reuploading");
    const draftId = /^\d+$/.test(data[draft] ?? "") ? data[draft] : undefined;
    if (draftId && ids.has(draftId)) throw Error("Two input rows returned the same draft ID"); if (draftId) ids.add(draftId);
    const success = data[status] === "Success" && !data[error]?.trim() && !!draftId;
    const code = (value: string | undefined) => /^[A-Za-z0-9_. -]{0,100}$/.test(value?.trim() ?? "") ? value?.trim() ?? "" : "UNRECOGNIZED_CODE";
    found.set(bound.key, { ...bound, status: success ? "success" : !draftId && data[status] === "Failure" && Boolean(data[error]?.trim()) ? "failed" : "uncertain", ...(draftId ? { draftId } : {}), errorCode: code(data[error]), warningCode: code(data[warning]) });
  }
  return expected.map(bound => found.get(bound.key) ?? { ...bound, status: "uncertain", errorCode: "MISSING_RESULT_ROW", warningCode: "" });
}

/** Actual Seller Hub Draft download uses 1-based DATA ordinals, not physical
 * CSV input lines (which also contain #INFO/header). Bind only to frozen input
 * order; never use titles, a result count, or a guessed SKU to identify rows. */
function parseSellerHubDraftResults(rows: ReturnType<typeof parseV2FeedCsv>, expected: DraftFeedBinding[]): DraftFeedRow[] {
  if (!expected.length || expected.some((e, n) => !Number.isSafeInteger(e.lineNumber) || e.lineNumber < 1 || n > 0 && e.lineNumber <= expected[n - 1].lineNumber)
    || new Set(expected.map(e => e.lineNumber)).size !== expected.length || new Set(expected.map(e => e.key)).size !== expected.length || new Set(expected.map(e => e.sku)).size !== expected.length) throw Error("Input row bindings are ambiguous");
  const found = new Map<string, DraftFeedRow>(), ids = new Set<string>();
  const code = (value: string) => /^[A-Za-z0-9_. -]{0,100}$/.test(value.trim()) ? value.trim() : "UNRECOGNIZED_CODE";
  for (let n = 0; n < rows.length; n++) {
    let data = rows[n].cells;
    // The retained official report emits an unquoted newline followed by an
    // indented empty error field. Accept ONLY that exact empty continuation.
    if (data.length === 6 && rows[n + 1]?.cells.length === 2 && /^\s+$/.test(rows[n + 1].cells[0]) && rows[n + 1].cells[1] === "") {
      data = [...data, ""]; n++;
    }
    if (data.length !== 7 || !/^[1-9]\d*$/.test(data[0])) throw Error("Seller Hub result has malformed exact row mapping");
    const ordinal = Number(data[0]), bound = expected[ordinal - 1];
    if (!Number.isSafeInteger(ordinal) || !bound || found.has(bound.key)) throw Error("Seller Hub result has an unknown or duplicate row");
    const draftId = /^\d+$/.test(data[1]) ? data[1] : undefined, link = data[4].trim();
    if (data[1] && !draftId) throw Error("Seller Hub result has an invalid draft ID");
    if (draftId && ids.has(draftId)) throw Error("Two input rows returned the same draft ID");
    if (draftId) ids.add(draftId);
    let exactDraftLink = false;
    if (link) {
      let url: URL; try { url = new URL(link); } catch { throw Error("Seller Hub result has an invalid draft link"); }
      exactDraftLink = url.origin === "https://www.ebay.com" && !url.username && !url.password && !url.hash && url.pathname === "/sl/list"
        && url.searchParams.getAll("mode").length === 1 && url.searchParams.get("mode") === "AddItem"
        && url.searchParams.getAll("draft_id").length === 1 && url.searchParams.get("draft_id") === draftId
        && Array.from(url.searchParams.keys()).every(key => key === "mode" || key === "draft_id");
      if (!exactDraftLink) throw Error("Seller Hub result link must identify the same draft ID in Draft-only mode");
    }
    const success = data[3] === "SUCCESS" && Boolean(draftId) && exactDraftLink && !data[5].trim() && !data[6].trim();
    const failed = ["FAILED", "FAILURE"].includes(data[3]) && !draftId && !link && Boolean(data[5].trim() || data[6].trim());
    found.set(bound.key, { ...bound, status: success ? "success" : failed ? "failed" : "uncertain", ...(draftId ? { draftId } : {}), errorCode: code(data[5]), warningCode: "" });
  }
  return expected.map(bound => found.get(bound.key) ?? { ...bound, status: "uncertain", errorCode: "MISSING_RESULT_ROW", warningCode: "" });
}

const bindingSchema = z.object({ key: hash, sku: z.string().min(1), captureIds: z.array(hash).min(1), lineNumber: z.number().int().positive() }).strict();
export const v2UploadJournalSchema = z.object({ version: z.literal(1), key: hash, inputHash: hash, bindings: z.array(bindingSchema).min(1),
  status: z.enum(["prepared", "create-requested", "task-created", "upload-requested", "processing", "results-ready", "uncertain", "browser-handoff"]),
  taskId: taskIdSchema.optional(), at: z.string().datetime(), updatedAt: z.string().datetime(), taskStatus: z.string().optional(),
  resultPath: z.string().optional(), resultHash: hash.optional(), resultObservedAt: z.string().datetime().optional(), blocker: z.string().optional(),
}).strict();
export type V2UploadJournal = z.infer<typeof v2UploadJournalSchema>;
async function atomicJournal(filename: string, journal: V2UploadJournal) {
  const temp = `${filename}.${randomUUID()}.tmp`, out = await fs.open(temp, "wx");
  try { await out.writeFile(JSON.stringify(v2UploadJournalSchema.parse(journal), null, 2)); await out.sync(); } finally { await out.close(); } await fs.rename(temp, filename);
}
export type V2UploaderDependencies = { getAccessToken: () => Promise<string>; fetcher?: typeof fetch; maxPolls?: number; pollDelayMs?: number; sleep?: (ms: number) => Promise<void> };

/** Actual OAuth Feed uploader. Call AFTER the bounded local run releases its worker
 * lease. Existing begin intents are mandatory; this path cannot create offers,
 * modify old inventory, publish, or claim saved-field verification from an import. */
async function uploadV2DraftIntentsTimedLocal(root: string, keys: string[], deps: V2UploaderDependencies) {
  if (!keys.length || keys.length > 20 || new Set(keys).size !== keys.length) throw Error("Select 1 to 20 distinct existing V2 draft intents");
  keys = [...keys].sort(); // Caller order cannot create a different batch or row identity.
  keys.forEach(k => hash.parse(k)); const maxPolls = deps.maxPolls ?? 3, delay = deps.pollDelayMs ?? 2000;
  if (!Number.isInteger(maxPolls) || maxPolls < 1 || maxPolls > 10 || !Number.isInteger(delay) || delay < 0 || delay > 5000) throw Error("Uploader polling must stay bounded");
  const release = await acquireV2Lock("worker", root); let rows: DraftFeedRow[] = [], taskId: string | undefined, journalPath = "", resultObservedAt = "", finalStatus: V2UploadJournal["status"] = "prepared";
  try {
    const state = await readV2State(root); const submissions = keys.map(key => state.submissions[key]);
    if (submissions.some(s => !s)) throw Error("Every selected capture requires an existing V2 draft intent");
    if (submissions.some(s => Object.values(state.submissions).some(other => !keys.includes(other.key) && other.payload.captureIds.some(c => s.payload.captureIds.includes(c))))) throw Error("Capture ownership overlaps an existing draft intent");
    if (submissions.some(s => /[\r\n]/.test(s.payload.description))) throw Error("This supported bulk route requires single-line pre-upload descriptions; generate richer descriptions only in the same draft editor afterward");
    // Reconstruct only the frozen transport. Resume reads must not fail merely
    // because hosted URLs expired after an already accepted upload.
    const csv = draftCsv(submissions.map(s => s.payload), Math.min(...submissions.map(s => Date.parse(s.at)))), parsed = assertV2DraftOnlyCsv(csv);
    const bindings = submissions.map((s, n) => ({ key: s.key, sku: s.payload.sku, captureIds: s.payload.captureIds, lineNumber: parsed.rows[n].lineNumber }));
    const inputHash = createHash("sha256").update(csv).digest("hex"), batchKey = digest({ bindings, inputHash });
    const dir = path.join(v2Dir(root), "uploads"); await fs.mkdir(dir, { recursive: true }); journalPath = path.join(dir, `${batchKey}.json`);
    // Per-intent ownership fences subsets/reordered requests and is committed
    // before a createTask POST. Also honor any older journal without owner files.
    for (const filename of (await fs.readdir(dir)).filter(f => /^[a-f0-9]{64}\.json$/.test(f))) {
      const previous = v2UploadJournalSchema.parse(JSON.parse(await fs.readFile(path.join(dir, filename), "utf8")));
      if (previous.key !== batchKey && previous.bindings.some(b => keys.includes(b.key) || b.captureIds.some(c => bindings.some(n => n.captureIds.includes(c))))) throw Error("Existing feed task owns overlapping captures; resume its exact batch rather than creating another");
    }
    const ownerSchema = z.object({ version: z.literal(1), batchKey: hash, inputHash: hash, captureIds: z.array(hash).min(1) }).strict();
    for (const binding of bindings) {
      const ownerPath = path.join(dir, `intent-${binding.key}.json`);
      let existing: z.infer<typeof ownerSchema> | undefined;
      try { existing = ownerSchema.parse(JSON.parse(await fs.readFile(ownerPath, "utf8"))); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
      if (existing && (existing.batchKey !== batchKey || existing.inputHash !== inputHash || digest(existing.captureIds) !== digest(binding.captureIds))) throw Error("This intent already belongs to another upload batch; reconcile it without reuploading");
      if (!existing) await fs.writeFile(ownerPath, JSON.stringify({ version: 1, batchKey, inputHash, captureIds: binding.captureIds }), { flag: "wx" });
    }
    let journal: V2UploadJournal;
    try { journal = v2UploadJournalSchema.parse(JSON.parse(await fs.readFile(journalPath, "utf8"))); if (journal.inputHash !== inputHash || digest(journal.bindings) !== digest(bindings)) throw Error("Upload checkpoint input changed"); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      if (submissions.some(s => s.draftId || s.status !== "intent")) throw Error("Known or uncertain drafts cannot create another feed; reconcile the existing upload journal");
      draftCsv(submissions.map(s => s.payload)); // Fresh media required before a NEW upload journal.
      const at = nowIso(); journal = { version: 1, key: batchKey, inputHash, bindings, status: "prepared", at, updatedAt: at }; await fs.writeFile(path.join(dir, `${batchKey}.csv`), csv, { flag: "wx" }); await atomicJournal(journalPath, journal); }
    const save = async (status: V2UploadJournal["status"]) => { journal.status = status; journal.updatedAt = nowIso(); await atomicJournal(journalPath, journal); };
    if (journal.status === "browser-handoff") throw Error("This rejected Feed task has a bound Seller Hub browser handoff; no API request or retry is permitted");
    if (journal.status === "create-requested" || journal.status === "uncertain" && !journal.taskId) throw Error("Task creation outcome is uncertain. Reconcile the retained create request through seller Feed tasks; never create another automatically");
    // Actual seller evidence disproved this production route. Injection exists
    // only for deterministic transport tests; there is no seller/config bypass.
    if (!deps.fetcher && ["prepared", "task-created"].includes(journal.status)) throw Error("FX_LISTING Draft capability is unvalidated after actual BAF.Error.5 rejection. New API create/upload is disabled; use the evidence-bound Seller Hub handoff. Same-task GET recovery remains available.");
    let token: string;
    try { token = await deps.getAccessToken(); } catch { throw Error("Existing seller OAuth connection is unavailable; no feed request was sent"); }
    const client = createDraftFeedClient(token, deps.fetcher);
    try {
      if (journal.status === "prepared") {
        for (const key of keys) await validateV2DraftForUpload(root, key);
        await save("create-requested"); journal.taskId = await client.createTask(); await save("task-created");
      }
      taskId = journal.taskId; if (!taskId) throw Error("Upload journal is missing the exact task ID");
      if (journal.status === "task-created") {
        if (Date.now() - Date.parse(journal.at) > 60 * 60000) throw Error("Created task or inventory clearance is older than 60 minutes; reconcile it before uploading");
        for (const key of keys) await validateV2DraftForUpload(root, key);
        draftCsv(submissions.map(s => s.payload));
        await save("upload-requested"); await client.uploadFile(taskId, csv); await save("processing");
      }
      // upload-requested or uncertain-with-ID resumes with GET only. No POST retry.
      if (journal.status !== "results-ready") {
        for (let n = 0; n < maxPolls; n++) {
          const task = await client.getTask(taskId); journal.taskStatus = task.status; await save(journal.status === "upload-requested" || journal.status === "uncertain" ? "uncertain" : "processing");
          if (["COMPLETED", "COMPLETED_WITH_ERROR"].includes(task.status)) {
            const result = await client.downloadResult(taskId); // Retain raw evidence before attempting its schema/parser.
            const resultPath = `artifacts/card-processing-v2/uploads/${batchKey}-result.csv`, resultHash = createHash("sha256").update(result).digest("hex");
            try { await fs.writeFile(path.join(root, resultPath), result, { flag: "wx" }); }
            catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST" || createHash("sha256").update(await fs.readFile(path.join(root, resultPath))).digest("hex") !== resultHash) throw Error("Retained feed result differs; reconcile it without overwriting evidence"); }
            journal.resultPath = resultPath; journal.resultHash = resultHash; journal.resultObservedAt = nowIso(); await save("results-ready"); break;
          }
          if (["FAILED", "ABORTED", "CREATED"].includes(task.status)) { journal.blocker = "Task is not confirmed processing/completed. Reconcile this exact task; no upload replay."; await save("uncertain"); break; }
          if (n < maxPolls - 1) await (deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(delay);
        }
      }
      if (journal.status === "results-ready") {
        const result = await fs.readFile(path.join(root, journal.resultPath!), "utf8"); if (createHash("sha256").update(result).digest("hex") !== journal.resultHash) throw Error("Retained import result changed"); rows = parseDraftFeedResults(result, bindings);
        if (!journal.resultObservedAt || Date.now() - Date.parse(journal.resultObservedAt) > 60 * 60000) {
          const refreshed = await client.downloadResult(taskId);
          if (createHash("sha256").update(refreshed).digest("hex") !== journal.resultHash) throw Error("Fresh same-task result differs from retained evidence; reconcile without overwriting it");
          journal.resultObservedAt = nowIso(); await save("results-ready");
        }
        resultObservedAt = journal.resultObservedAt!;
      }
    } catch (e) {
      journal.blocker = "Feed access or operation outcome needs reconciliation. Credentials and raw provider responses are excluded; no automatic mutation retry.";
      await save(journal.status === "prepared" || journal.status === "task-created" ? journal.status : "uncertain");
      await withV2State(s => {
        event(s, "draft-feed-held", `Feed upload checkpoint ${batchKey}: ${journal.status}; no automatic mutation retry`);
        if (journal.status === "uncertain") for (const key of keys) {
          s.submissions[key].status = "uncertain";
          for (const card of Object.values(s.cards).filter(c => s.submissions[key].payload.captureIds.includes(c.captureId))) issue(card, "IMPORT_UNCERTAIN", "Feed operation outcome requires reconciliation of its retained task. Never create or upload another batch for these captures.", "Draft reconciliation");
        }
      }, root);
      throw e;
    }
    finalStatus = journal.status;
    await withV2State(s => {
      event(s, "draft-feed-checkpoint", `Feed task ${taskId}; ${journal.status}; journal ${batchKey}`);
      if (!rows.length) for (const card of Object.values(s.cards).filter(c => bindings.some(b => b.captureIds.includes(c.captureId)))) {
        if (journal.status === "uncertain") {
          const bound = bindings.find(b => b.captureIds.includes(card.captureId))!; s.submissions[bound.key].status = "uncertain";
          issue(card, "IMPORT_UNCERTAIN", `Feed task ${taskId} has an uncertain outcome. Reconcile this exact task before any further write.`, "Draft reconciliation"); continue;
        }
        if (!card.issues.length) card.nextAction = `Feed task ${taskId} is ${journal.taskStatus ?? journal.status}. Resume this exact task with read-only status/results checks; do not reupload.`;
      }
    }, root);
  } finally { await release(); }
  // The lifecycle owns its own lease. Retain raw result plus exact per-row observation.
  for (const row of rows) {
    if (row.status !== "success" || !row.draftId) {
      await withV2State(s => { const sub = s.submissions[row.key]; sub.status = "uncertain"; for (const card of Object.values(s.cards).filter(c => row.captureIds.includes(c.captureId))) issue(card, "IMPORT_UNCERTAIN", `Feed row ${row.lineNumber} requires same-operation reconciliation (${row.errorCode || row.status}); no reupload.`, "Draft reconciliation"); }, root); continue;
    }
    const current = (await readV2State(root)).submissions[row.key];
    if (current.draftId === row.draftId && current.jobId === taskId && ["submitted", "verified"].includes(current.status)) continue;
    const observedAt = resultObservedAt, observation = { kind: "live-ebay-draft-import-row", seller: "imaydit58", action: "Draft", jobId: taskId!, draftId: row.draftId, sku: row.sku, result: "Success", observedAt };
    const bytes = Buffer.from(JSON.stringify(observation, null, 2)), relative = `artifacts/card-processing-v2/uploads/import-${row.key}-${randomUUID()}.json`;
    await fs.writeFile(path.join(root, relative), bytes, { flag: "wx" });
    await recordV2Import(root, row.key, { jobId: taskId!, draftId: row.draftId, observedAt, evidence: { path: relative, sha256: createHash("sha256").update(bytes).digest("hex") } });
  }
  return { taskId, status: finalStatus, journalPath: path.relative(root, journalPath), rows, verified: false, canPublish: false };
}

const rejectionEvidence = z.object({ path: z.string().min(1).max(500), sha256: hash }).strict();
/** Reconcile a proven all-row API rejection into one immutable browser handoff.
 * No external calls, state/card edits, intent replacement or API retry occurs. */
export async function reconcileV2RejectedFeedForBrowser(root: string, journalRelative: string, raw: unknown) {
  const packet = z.object({ result: rejectionEvidence, task: rejectionEvidence, drafts: rejectionEvidence }).strict().parse(raw);
  const local = async (relative: string) => {
    const file = await fs.realpath(path.resolve(root, relative)), base = await fs.realpath(path.join(root, 'artifacts'));
    const tail = path.relative(base, file); if (!tail || tail.startsWith('..') || path.isAbsolute(tail)) throw Error('Reconciliation evidence must be a retained local artifact');
    const stat = await fs.stat(file); if (!stat.isFile() || stat.size > 16_000_000) throw Error('Evidence exceeds bounded size'); return file;
  };
  const read = async (ref: z.infer<typeof rejectionEvidence>) => { const bytes = await fs.readFile(await local(ref.path)); if (createHash('sha256').update(bytes).digest('hex') !== ref.sha256) throw Error('Reconciliation evidence hash mismatch'); return bytes; };
  const release = await acquireV2Lock('worker', root);
  try {
    const journalPath = await local(journalRelative), journal = v2UploadJournalSchema.parse(JSON.parse(await fs.readFile(journalPath, 'utf8')));
    if (!journal.taskId || !['uncertain', 'results-ready', 'browser-handoff'].includes(journal.status)) throw Error('Only an existing completed rejected task can transfer transport');
    const task = statusSchema.parse(JSON.parse((await read(packet.task)).toString('utf8')));
    if (task.taskId !== journal.taskId || task.status !== 'COMPLETED_WITH_ERROR' || task.uploadSummary?.successCount !== 0 || task.uploadSummary?.failureCount !== journal.bindings.length) throw Error('Same-task terminal all-row rejection summary required');
    const resultBytes = await read(packet.result), result = resultBytes.toString('utf8'), rows = parseDraftFeedResults(result, journal.bindings);
    if (rows.some(row => row.status !== 'failed' || row.draftId || row.errorCode !== 'BAF.Error.5')) throw Error('Every bound row must prove the exact unsupported Draft-action rejection; mixed/unknown outcomes cannot transfer');
    const drafts = z.object({ kind: z.literal('live-seller-drafts-empty'), seller: z.literal('imaydit58'), source: z.literal('live-seller-read'), observedAt: z.string().datetime(), draftCount: z.literal(0) }).strict().parse(JSON.parse((await read(packet.drafts)).toString('utf8')));
    const age = Date.now() - Date.parse(drafts.observedAt); if (age < 0 || age > 60 * 60000) throw Error('Fresh seller Drafts zero observation required');
    const csvPath = journalRelative.replace(/\.json$/, '.csv'); if (csvPath === journalRelative) throw Error('Canonical upload journal path required');
    const csv = await fs.readFile(await local(csvPath), 'utf8'); if (createHash('sha256').update(csv).digest('hex') !== journal.inputHash) throw Error('Frozen input CSV changed');
    assertV2DraftOnlyCsv(csv);
    const state = await readV2State(root), submissions = journal.bindings.map(binding => state.submissions[binding.key]);
    if (submissions.some((sub, n) => !sub || sub.draftId || !['intent', 'uncertain'].includes(sub.status) || sub.jobId || digest(sub.payload.captureIds) !== digest(journal.bindings[n].captureIds) || sub.payload.sku !== journal.bindings[n].sku)) throw Error('Existing exact intents must remain unimported and capture-bound');
    const expected = draftCsv(submissions.map(sub => sub.payload), Math.min(...submissions.map(sub => Date.parse(sub.at))));
    if (expected !== csv) throw Error('Frozen payload differs from rejected input');
    const handoff = { version: 1, kind: 'v2-rejected-feed-browser-handoff', seller: 'imaydit58', taskId: journal.taskId, batchKey: journal.key, keys: journal.bindings.map(b => b.key), bindings: journal.bindings, csvPath, csvSha256: journal.inputHash, rejection: packet, observedDraftsAt: drafts.observedAt, externalWrites: 0, newIntents: 0, canPublish: false, nextAction: 'Upload this exact Draft CSV once through Seller Hub Reports, retain browser job and exact per-row DraftIDs; then import and save/reopen the same IDs. Unknown browser outcomes require reconciliation, never another upload.' };
    const handoffPath = journalRelative.replace(/\.json$/, '-browser-handoff.json'), bytes = Buffer.from(JSON.stringify(handoff, null, 2));
    try { await fs.writeFile(path.join(root, handoffPath), bytes, { flag: 'wx' }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !bytes.equals(await fs.readFile(path.join(root, handoffPath)))) throw Error('Existing handoff differs; preserve it and reconcile'); }
    journal.status = 'browser-handoff'; journal.taskStatus = task.status; journal.resultPath = packet.result.path; journal.resultHash = packet.result.sha256; journal.resultObservedAt = drafts.observedAt; journal.updatedAt = nowIso(); journal.blocker = 'FX_LISTING Draft action rejected BAF.Error.5; API route unvalidated. Only the exact retained browser handoff may proceed.';
    await atomicJournal(journalPath, journal);
    return { handoffPath, ...handoff };
  } finally { await release(); }
}

export async function uploadV2DraftIntents(root:string,keys:string[],deps:V2UploaderDependencies){return measureV2(root,"ebay-bulk-upload",()=>uploadV2DraftIntentsTimedLocal(root,keys,deps));}
