import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {validateCatalog} from "../lib/card-knowledge.ts";
import {validateCatalogAudit} from "../lib/card-catalog-audit.ts";
const read=(name:string)=>JSON.parse(readFileSync(`data/card-catalog/${name}.json`,'utf8'));
const catalog=validateCatalog(read('topps-chrome-basketball-2025-26'));
const audit=read('topps-chrome-basketball-2025-26-audit'), registry=read('source-registry');
test('audit accounts for each manufacturer row and keeps original hashes',()=>{
  const result=validateCatalogAudit(catalog,audit,registry);
  assert.equal(result.catalogAudit.checklistRows,1300);
  assert.equal(result.catalogAudit.oddsRows.reduce((n,r)=>n+r.cells.length,0),1787);
  const changed=structuredClone(audit); changed.sourceHashes[catalog.sources[0].id]='0'.repeat(64);
  assert.throws(()=>validateCatalogAudit(catalog,changed,registry),/Stale/);
});
test('format columns distinguish RayWave, Sapphire and a printed invalid denominator',()=>{
  const {catalogAudit:a}=validateCatalogAudit(catalog,audit,registry);
  assert.deepEqual(a.oddsRows.find(r=>r.label==='Base Refractors RayWave')!.cells.map(c=>[c.formatId,c.ratio]),[['mega','1:3'],['fanatics-mega','1:3']]);
  assert.deepEqual(a.sections.find(s=>s.section==='SAPPHIRE SELECTIONS')!.formatIds,['sapphire']);
  assert.equal(a.oddsRows.find(r=>r.label==='Base Refractors Pulsar')!.cells[0].status,'source-anomaly');
  const changed=structuredClone(audit); changed.oddsRows[0].cells[0].formatId='unknown';
  assert.throws(()=>validateCatalogAudit(catalog,changed,registry),/Invalid odds/);
});
test('trial has 100 unique raw queries without fabricated prices or provider matches',()=>{
  const trial=read('cardhedge-trial');
  assert.equal(trial.cases.length,100); assert.equal(new Set(trial.cases.map((c:{id:string})=>c.id)).size,100);
  const ids=new Set(catalog.cards.map(c=>c.id));
  for(const row of trial.cases) { assert.ok(ids.has(row.entryId)); assert.equal(row.grade,'Raw'); assert.equal(row.resultStatus,'not-run'); assert.equal(row.providerCardId,null); assert.equal(row.printRun,null); }
  assert.equal(trial.cases.filter((c:{stratum:string})=>c.stratum==='insert').length,10);
  assert.ok(registry.sources.every((s:{automaticCollection:boolean})=>!s.automaticCollection));
});
