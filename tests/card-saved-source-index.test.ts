import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {savedSourceCandidates} from '../lib/card-saved-source-index.ts';
import type {Identity} from '../lib/card-orchestrator.ts';
test('saved source handoff verifies identity and bytes and excludes buyer columns',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'source-index-'));
 try{
  fs.mkdirSync(path.join(root,'reports/inventory-snapshots'),{recursive:true});
  fs.mkdirSync(path.join(root,'artifacts/card-orchestrator'),{recursive:true});
  const identity={player:'Example',season:'2025',set:'Chrome',manufacturer:'Topps',cardNumber:'1',sport:'Baseball',team:'Team',parallel:'Base',serial:'',printRun:null,condition:'Near mint or better',autograph:false,patch:false} satisfies Identity;
  const source='reports/inventory-snapshots/active.csv',file=path.join(root,source),indexFile=path.join(root,'artifacts/card-orchestrator/saved-source-index.json');
  fs.writeFileSync(file,'original');
  const index={observedAt:'2026-10-26T00:00:00Z',sourceEvidence:[{path:source,sha256:createHash('sha256').update('original').digest('hex')}],cards:[{cardId:'card',identity,candidates:[{itemId:'123',title:'Example',kind:'active',itemPrice:'2.00',buyerEmail:'private@example.test'}]}]};
  fs.writeFileSync(indexFile,JSON.stringify(index));
  const result=savedSourceCandidates('card',identity,root);
  assert.equal(result.status,'available-unverified');assert.equal(result.activeRequiresRefresh,true);
  assert.equal(JSON.stringify(result).includes('private@example.test'),false);
  assert.equal(savedSourceCandidates('card',{...identity,parallel:'Other'},root).status,'unavailable');
  fs.writeFileSync(file,'modified');assert.equal(savedSourceCandidates('card',identity,root).status,'stale');
  index.sourceEvidence[0].path='../outside.csv';fs.writeFileSync(indexFile,JSON.stringify(index));
  assert.equal(savedSourceCandidates('card',identity,root).status,'unavailable');
  fs.writeFileSync(indexFile,'broken');assert.equal(savedSourceCandidates('card',identity,root).status,'unavailable');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
