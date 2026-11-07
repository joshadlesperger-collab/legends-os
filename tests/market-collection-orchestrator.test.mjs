import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { atomic, gate, withLock } from '../scripts/market-collection-orchestrator.mjs';
const testRoot = path.resolve('artifacts/knowledge-graph/orchestrator-tests');
fs.mkdirSync(testRoot, { recursive: true });

test('cooldown, unfinished jobs and deadline prevent another navigation reservation', () => {
  const s = { nextAllowedAt: new Date(300000).toISOString(), stopAt: new Date(900000).toISOString(), active: null };
  assert.throws(() => gate(s, 299999), /Cooldown/);
  gate(s, 300000);
  assert.throws(() => gate(s, 900000), /deadline/);
  assert.throws(() => gate({ ...s, active: { stage: 'captured' } }, 400000), /Pending/);
});
test('exclusive writer rejects overlap and releases even on failure', () => {
  const root = fs.mkdtempSync(path.join(testRoot, 'market-lock-'));
  try {
    assert.throws(() => withLock(root, () => {
      assert.throws(() => withLock(root, () => assert.fail()), /EEXIST/);
      throw Error('interrupted');
    }), /interrupted/);
    withLock(root, () => {});
  } finally { fs.rmSync(root, { recursive: true }); }
});
test('atomic checkpoint round trip preserves pending stage across reloads', () => {
  const root = fs.mkdtempSync(path.join(testRoot, 'market-state-'));
  try {
    const file = path.join(root, 'state.json');
    atomic(file, { active: { id: 'one', stage: 'captured' } });
    assert.equal(JSON.parse(fs.readFileSync(file)).active.stage, 'captured');
    atomic(file, { active: { id: 'one', stage: 'normalized' } });
    assert.equal(JSON.parse(fs.readFileSync(file)).active.stage, 'normalized');
  } finally { fs.rmSync(root, { recursive: true }); }
});

test('interrupted pipeline resumes its unfinished stage without repeating completed stages', () => {
  const root = fs.mkdtempSync(path.join(testRoot, 'market-resume-'));
  const cli = path.resolve('scripts/market-collection-orchestrator.mjs');
  const run = (...args) => JSON.parse(execFileSync(process.execPath, [cli, ...args], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }));
  try {
    const base = path.join(root, 'artifacts/knowledge-graph');
    fs.mkdirSync(path.join(base, 'compsapi-collection'), { recursive: true });
    fs.mkdirSync(path.join(root, 'scripts'));
    atomic(path.join(base, 'collection-automation-checkpoint.json'), { lastSearchAt: new Date(0).toISOString(), stopAt: new Date(Date.now() + 3600000).toISOString() });
    atomic(path.join(base, 'saved-pages-index.json'), { summary: { sources: [] } });
    atomic(path.join(base, 'compsapi-collection/index.json'), { rows: [] });
    const state = run('reserve', 'fixture-page');
    assert.throws(() => run('reserve', 'another-page'));
    const raw = JSON.stringify({ url: 'https://www.ebay.com/sch/i.html?LH_Sold=1&LH_Complete=1&LH_Auction=1', filtersVerified: true, captureKind: 'rendered-dom-listing-cards', capturedAt: new Date().toISOString(), cards: [] });
    fs.writeFileSync(path.join(base, 'raw.json'), raw);
    atomic(path.join(base, 'packet.json'), { sourceFilename: 'raw.json', sourceSha256: crypto.createHash('sha256').update(raw).digest('hex'), rows: [{ itemId: '123', soldDateText: 'Oct 23, 2026', flags: ['sale_status_not_verified'] }] });
    run('capture', state.active.id, path.join(base, 'packet.json'));
    for (const script of ['prepare-market-pages', 'collect-compsapi', 'normalize-market', 'backtest-market', 'render-market-collection']) {
      fs.writeFileSync(path.join(root, 'scripts', `${script}.ts`), `const fs = require('fs'); fs.appendFileSync('calls.txt', '${script}\\n'); ${script === 'normalize-market' ? "if (!fs.existsSync('retry')) { fs.writeFileSync('retry', 'yes'); process.exit(1); }" : ''}`);
    }
    assert.throws(() => run('process'));
    assert.equal(run('status').active.stage, 'collected');
    const finished = run('process');
    assert.equal(finished.active, null);
    assert.equal(finished.history[0].newIds, 1);
    const calls = fs.readFileSync(path.join(root, 'calls.txt'), 'utf8').trim().split('\n');
    assert.equal(calls.filter(s => s === 'prepare-market-pages').length, 1);
    assert.equal(calls.filter(s => s === 'normalize-market').length, 2);
    assert.throws(() => run('reserve', 'fixture-page'));
  } finally { fs.rmSync(root, { recursive: true }); }
});
