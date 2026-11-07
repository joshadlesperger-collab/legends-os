import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const interval = 300000;
export function atomic(file, value) {
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2));
  fs.renameSync(temp, file);
}
export function gate(state, now) {
  if (state.active) throw Error('Pending job: resume or block it before reserving another search');
  if (now >= Date.parse(state.stopAt)) throw Error('Overnight deadline reached');
  if (now < Date.parse(state.nextAllowedAt)) throw Error(`Cooldown until ${state.nextAllowedAt}`);
}
export function withLock(root, action) {
  fs.mkdirSync(root, { recursive: true });
  const lock = path.join(root, 'writer.lock');
  // Never expire a writer by elapsed time: a slow live process must retain ownership.
  const fd = fs.openSync(lock, 'wx');
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    return action();
  } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}
function main() {
  const base = path.resolve('artifacts/knowledge-graph');
  const root = path.join(base, 'collection-orchestrator');
  const [command = 'status', arg, extra] = process.argv.slice(2);
  fs.mkdirSync(root, { recursive: true });
  if (command === 'recover-lock') {
    const lock = path.join(root, 'writer.lock');
    const owner = JSON.parse(fs.readFileSync(lock, 'utf8'));
    try { process.kill(owner.pid, 0); throw Error('Writer is still alive; lock retained'); }
    catch (e) { if (e.code !== 'ESRCH') throw e; }
    fs.unlinkSync(lock);
    console.log('Dead writer lock recovered; pending stage remains resumable');
    return;
  }
  withLock(root, () => {
    const stateFile = path.join(root, 'state.json');
    const legacy = JSON.parse(fs.readFileSync(path.join(base, 'collection-automation-checkpoint.json'), 'utf8'));
    const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {
      version: 1, stopAt: legacy.stopAt, nextAllowedAt: new Date(Date.parse(legacy.lastSearchAt) + interval).toISOString(),
      nextTask: legacy.nextTask, active: null, history: [], stoppedQueries: [],
    };
    const save = () => atomic(stateFile, state);
    const now = Date.now();
    if (command === 'reserve') {
      if (!arg) throw Error('Provide a stable search/page key');
      gate(state, now);
      if (state.stoppedQueries.includes(arg) || state.history.some(j => j.key === arg)) throw Error('Search/page already completed or stopped');
      state.active = { id: crypto.randomUUID(), key: arg, stage: 'reserved', reservedAt: new Date(now).toISOString(), navigateBefore: new Date(now + 30000).toISOString() };
      state.nextAllowedAt = new Date(now + interval + 30000).toISOString();
      save();
    } else if (command === 'capture') {
      const job = state.active;
      if (!job || job.id !== arg || job.stage !== 'reserved') throw Error('Expected reserved job ID');
      const packetPath = path.resolve(extra || '');
      if (!packetPath.startsWith(base + path.sep) || !packetPath.endsWith('.json')) throw Error('Packet must be inside knowledge-graph artifacts');
      const packet = JSON.parse(fs.readFileSync(packetPath, 'utf8'));
      const sourcePath = path.resolve(base, packet.sourceFilename || '');
      if (!sourcePath.startsWith(base + path.sep)) throw Error('Invalid source path');
      const raw = fs.readFileSync(sourcePath);
      if (crypto.createHash('sha256').update(raw).digest('hex') !== packet.sourceSha256) throw Error('Source hash mismatch');
      const source = JSON.parse(raw);
      const url = new URL(source.url);
      if (url.hostname !== 'www.ebay.com' || url.searchParams.get('LH_Sold') !== '1' || url.searchParams.get('LH_Complete') !== '1' || url.searchParams.get('LH_Auction') !== '1') throw Error('Sold/completed/auction URL evidence required');
      if (source.filtersVerified !== true || !Array.isArray(source.cards) || source.captureKind !== 'rendered-dom-listing-cards') throw Error('Visible filter verification and raw result cards required');
      const captured = Date.parse(source.capturedAt);
      if (!Number.isFinite(captured) || captured < Date.parse(job.reservedAt) || captured > now) throw Error('Invalid capture timestamp');
      if (!Array.isArray(packet.rows) || !packet.rows.length || packet.rows.some(r => !/^\d+$/.test(r.itemId) || !r.soldDateText || !r.flags?.includes('sale_status_not_verified'))) throw Error('Missing sold evidence/uncertainty flags');
      const immutable = path.join(root, `${job.id}.json`);
      const priorIndex = JSON.parse(fs.readFileSync(path.join(base, 'compsapi-collection/index.json'), 'utf8'));
      const known = new Set(priorIndex.rows.map(r => r.itemId));
      job.newIds = new Set(packet.rows.filter(r => !known.has(r.itemId)).map(r => r.itemId)).size;
      const serialized = JSON.stringify(packet);
      if (fs.existsSync(immutable)) {
        if (fs.readFileSync(immutable, 'utf8') !== serialized) throw Error('Existing immutable packet differs');
      } else fs.writeFileSync(immutable, serialized, { flag: 'wx' });
      job.packet = immutable; job.stage = 'captured'; job.capturedAt = source.capturedAt;
      state.nextAllowedAt = new Date(now + interval).toISOString(); save();
    } else if (command === 'process') {
      const job = state.active;
      if (!job || job.stage === 'reserved') throw Error('Capture pending; never navigate again for a reserved job');
      const stages = ['captured', 'merged', 'collected', 'normalized', 'backtested', 'rendered'];
      const scripts = ['prepare-market-pages.ts', 'collect-compsapi.ts', 'normalize-market.ts', 'backtest-market.ts', 'render-market-collection.ts'];
      while (job.stage !== 'rendered') {
        const index = stages.indexOf(job.stage);
        if (index < 0) throw Error('Unknown processing stage');
        let args = [];
        if (index === 0) {
          const existing = JSON.parse(fs.readFileSync(path.join(base, 'saved-pages-index.json'), 'utf8'));
          args = [...new Set([...existing.summary.sources.map(s => s.path), job.packet])];
        } else if (index === 1) args = ['--report-only'];
        // A crash reruns only the unfinished deterministic, local-only stage.
        execFileSync(process.execPath, ['--experimental-strip-types', `scripts/${scripts[index]}`, ...args], { stdio: 'ignore' });
        job.stage = stages[index + 1]; save();
      }
      job.completedAt = new Date().toISOString();
      if (job.newIds === 0) { job.stopReason = 'zero-new-listings'; state.stoppedQueries.push(job.key); }
      state.history.push(job); state.active = null; save();
    } else if (command === 'block') {
      if (!state.active || state.active.id !== arg || !extra) throw Error('Provide active job ID and blocker reason');
      state.active.blocker = extra; state.stoppedQueries.push(state.active.key);
      state.history.push(state.active); state.active = null; save();
    } else if (command !== 'status') throw Error('Unknown command');
    save(); console.log(JSON.stringify(state, null, 2));
  });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (e) { console.error(e.message); process.exitCode = 1; }
}
