import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  acquireV2Lock, processAlive, publicV2Snapshot, readV2Config, readV2State, v2Dir, withV2State,
} from "../lib/card-processing-v2-store.ts";
import {recordV2ActivityCheckpoint} from '../lib/card-processing-v2-activity.ts';

async function temporary<T>(run: (root: string) => Promise<T>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "v2-store-"));
  try { return await run(root); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}
test('short concurrent checkpoints serialize before callbacks without replay or ownership theft',()=>temporary(async root=>{
 let entered!:()=>void;const started=new Promise<void>(r=>{entered=r;});let invocations=0;
 const first=withV2State(async s=>{entered();await new Promise(r=>setTimeout(r,180));s.notices.push('first');},root);
 await started;
 const second=withV2State(s=>{invocations++;assert.ok(s.notices.includes('first'));s.notices.push('second');},root);
 await Promise.all([first,second]);const state=await readV2State(root);assert.equal(invocations,1);assert.deepEqual(state.notices,['first','second']);
}));

test('public timing snapshot exposes original-batch controller responsibility without mutating inventory',async()=>temporary(async root=>{
 await withV2State(()=>undefined,root);
 const before=await fs.readFile(path.join(v2Dir(root),'state.json'),'utf8'),batchId='66666666-6666-4666-8666-666666666666',candidateId='a'.repeat(64),now=new Date().toISOString();
 await fs.mkdir(path.join(v2Dir(root),'processing-batches'),{recursive:true});
 await fs.writeFile(path.join(v2Dir(root),'processing-batches',batchId+'.json'),JSON.stringify({jobId:batchId,status:'accepted',clickedAt:now,acceptedAt:now,captures:[{candidateId,photos:[{hash:'b'.repeat(64),side:'front'},{hash:'c'.repeat(64),side:'back'}]}],baselineCallIds:[]}));
 await recordV2ActivityCheckpoint(root,{batchId,lane:'agent',phase:'agent-handoff',owner:'internal-controller',candidateIds:[candidateId],step:'Worker returned',nextStep:'Inspect original pair'});
 const snapshot=await publicV2Snapshot(root);assert.equal(snapshot.batchActivity?.batchId,batchId);assert.equal(snapshot.batchActivity?.controller?.nextStep,'Inspect original pair');assert.equal(snapshot.batchActivity?.productiveWorkClaimed,false);
 assert.equal(await fs.readFile(path.join(v2Dir(root),'state.json'),'utf8'),before);
}));

test("a fresh V2 install has an isolated empty checkpoint and preserves the existing scan-folder convention", async () => temporary(async root => {
  const state = await readV2State(root);
  assert.equal(state.version, 2); assert.equal(state.revision, 0);
  assert.deepEqual(state.cards, {}); assert.deepEqual(state.calls, []);
  const config = await readV2Config(root);
  assert.equal(config.folder, process.env.CARD_SCANNER_PATH || process.env.CARD_INBOX_PATH || (process.platform === "win32" ? "C:\\CardScans" : path.join(root, "CardScans")));
  assert.equal(config.pairing, "named"); assert.equal(config.batchLimit, 10);
  assert.deepEqual(config.categories, []); assert.equal(config.identification, undefined);
  await assert.rejects(fs.stat(v2Dir(root)), { code: "ENOENT" }, "read-only defaults must not manufacture state files");
}));

test("invalid V2 configuration is an explicit error rather than an empty or reset configuration", async () => temporary(async root => {
  await fs.mkdir(v2Dir(root), { recursive: true });
  const filename = path.join(v2Dir(root), "config.json"), invalid = '{"folder":"C:/CardScans","pairing":"guess"}';
  await fs.writeFile(filename, invalid);
  await assert.rejects(readV2Config(root), /configuration is invalid/);
  assert.equal(await fs.readFile(filename, "utf8"), invalid);
}));

test("corrupt checkpoints stop processing and retain original bytes", async () => temporary(async root => {
  await fs.mkdir(v2Dir(root), { recursive: true });
  const filename = path.join(v2Dir(root), "state.json"), invalid = '{"version":2,"revision":';
  await fs.writeFile(filename, invalid);
  await assert.rejects(readV2State(root), /unreadable/);
  await assert.rejects(withV2State(s => { s.notices.push("must not commit"); }, root), /unreadable/);
  assert.equal(await fs.readFile(filename, "utf8"), invalid);
  assert.ok(!(await fs.readdir(v2Dir(root))).includes("state.lock"), "failed reads release owned locks");
}));

test("a failed transaction or schema violation cannot overwrite the last valid checkpoint", async () => temporary(async root => {
  await withV2State(s => { s.notices.push("retained checkpoint"); }, root);
  const filename = path.join(v2Dir(root), "state.json"), before = await fs.readFile(filename, "utf8");
  await assert.rejects(withV2State(s => { s.notices.push("discard me"); throw Error("intentional transaction failure"); }, root), /intentional transaction failure/);
  assert.equal(await fs.readFile(filename, "utf8"), before);
  await assert.rejects(withV2State(s => { (s as unknown as { version: number }).version = 999; }, root));
  assert.equal(await fs.readFile(filename, "utf8"), before);
  assert.deepEqual((await readV2State(root)).notices, ["retained checkpoint"]);
}));

test("successful transactions persist validated state atomically and advance revision once", async () => temporary(async root => {
  const result = await withV2State(s => { s.notices.push("one"); return "committed"; }, root);
  assert.equal(result, "committed"); assert.equal((await readV2State(root)).revision, 1);
  await withV2State(async s => { s.notices.push("two"); }, root);
  const state = await readV2State(root);
  assert.equal(state.revision, 2); assert.deepEqual(state.notices, ["one", "two"]);
  assert.deepEqual(await fs.readdir(v2Dir(root)), ["state.json"]);
}));

test("a live lock cannot be stolen and another worker's token cannot be released", async () => temporary(async root => {
  const release = await acquireV2Lock("worker", root), filename = path.join(v2Dir(root), "worker.lock");
  const before = await fs.readFile(filename, "utf8");
  assert.equal(processAlive(process.pid), true);
  await assert.rejects(acquireV2Lock("worker", root), /active worker/);
  assert.equal(await fs.readFile(filename, "utf8"), before);
  await fs.writeFile(filename, JSON.stringify({ pid: process.pid, token: "foreign-worker-token" }));
  await assert.rejects(release(), /ownership changed/);
  assert.equal(JSON.parse(await fs.readFile(filename, "utf8")).token, "foreign-worker-token");
}));

test("a confirmed dead PID is recoverable while its lock bytes remain as crash evidence", async () => temporary(async root => {
  await fs.mkdir(v2Dir(root), { recursive: true });
  const deadPid = 2147483647; assert.equal(processAlive(deadPid), false);
  const filename = path.join(v2Dir(root), "worker.lock"), old = JSON.stringify({ pid: deadPid, token: "interrupted-worker-token" });
  await fs.writeFile(filename, old);
  const release = await acquireV2Lock("worker", root);
  const files = await fs.readdir(v2Dir(root)), recovered = files.find(name => name.startsWith("worker.lock.recovered-"));
  assert.ok(recovered); assert.equal(await fs.readFile(path.join(v2Dir(root), recovered), "utf8"), old);
  assert.equal(JSON.parse(await fs.readFile(filename, "utf8")).pid, process.pid);
  await release(); await assert.rejects(fs.stat(filename), { code: "ENOENT" });
}));

test("malformed lock files are preserved for reconciliation rather than guessed stale", async () => temporary(async root => {
  await fs.mkdir(v2Dir(root), { recursive: true });
  const filename = path.join(v2Dir(root), "worker.lock"); await fs.writeFile(filename, "");
  await assert.rejects(acquireV2Lock("worker", root), /reconciliation/);
  assert.equal(await fs.readFile(filename, "utf8"), "");
}));

test("concurrent callers admit only one owner for a live worker lock", async () => temporary(async root => {
  const attempts = await Promise.allSettled(Array.from({ length: 8 }, () => acquireV2Lock("worker", root)));
  const owners = attempts.filter((result): result is PromiseFulfilledResult<() => Promise<void>> => result.status === "fulfilled");
  assert.equal(owners.length, 1);
  assert.equal(attempts.filter(result => result.status === "rejected").length, 7);
  await owners[0].value();
}));

test("a second state writer cannot enter while a transaction is awaiting work", async () => temporary(async root => {
  let enter!: () => void, finish!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const allowedToFinish = new Promise<void>(resolve => { finish = resolve; });
  const first = withV2State(async s => { enter(); await allowedToFinish; s.notices.push("first owner only"); }, root);
  await entered;
  try { await assert.rejects(withV2State(s => { s.notices.push("second writer"); }, root), /active worker/); }
  finally { finish(); await first; }
  assert.deepEqual((await readV2State(root)).notices, ["first owner only"]);
  assert.equal((await readV2State(root)).revision, 1);
}));

test("dashboard snapshot does not claim a dead checkpoint PID is still running", async () => temporary(async root => {
  await withV2State(s => { s.lastRun = { id: "interrupted-job", pid: 2147483647, status: "running", startedAt: new Date().toISOString() }; }, root);
  const before = await fs.readFile(path.join(v2Dir(root), "state.json"), "utf8");
  const snapshot = await publicV2Snapshot(root);
  assert.equal(snapshot.running, false); assert.equal(snapshot.configuration.bulkMethodStatus, "not-validated");
  assert.equal(snapshot.summary.physicalCards, 0);
  assert.equal(await fs.readFile(path.join(v2Dir(root), "state.json"), "utf8"), before, "dashboard reads do not mutate the recovery checkpoint");
}));

test("concurrent stale-lock recovery admits one owner and retains crash evidence without moving a new live lock", async () => temporary(async root => {
  await fs.mkdir(v2Dir(root), { recursive: true });
  const filename = path.join(v2Dir(root), "worker.lock"), old = JSON.stringify({ pid: 2147483647, token: "dead-original-owner" });
  await fs.writeFile(filename, old);
  const attempts = await Promise.allSettled(Array.from({ length: 12 }, () => acquireV2Lock("worker", root)));
  const owners = attempts.filter((result): result is PromiseFulfilledResult<() => Promise<void>> => result.status === "fulfilled");
  assert.equal(owners.length, 1);
  const current = JSON.parse(await fs.readFile(filename, "utf8")); assert.equal(current.pid, process.pid);
  const recovered = (await fs.readdir(v2Dir(root))).filter(name => name.startsWith("worker.lock.recovered-"));
  assert.equal(recovered.length, 1); assert.equal(await fs.readFile(path.join(v2Dir(root), recovered[0]), "utf8"), old);
  await owners[0].value();
}));

test("retained safe metadata diagnostics do not turn a valid local configuration into corruption", async () => temporary(async root => {
  await fs.mkdir(v2Dir(root), { recursive: true });
  await fs.writeFile(path.join(v2Dir(root), "config.json"), JSON.stringify({ folder: path.join(root, "scans"), categories: [] }));
  await fs.writeFile(path.join(v2Dir(root), "category-metadata.json"), JSON.stringify({ observedAt: new Date().toISOString(), categories: [], capabilities: [{ categoryId: "261328", status: "blocked", detail: "Retained metadata needs review", diagnostic: { phase: "category-aspects", code: "SCHEMA_INVALID", paths: ["aspects.1.aspectValues"] } }], evidence: [] }));
  const config = await readV2Config(root); assert.deepEqual(config.categories, []); assert.equal(config.folder, path.join(root, "scans"));
}));
