import test from "node:test";
import assert from "node:assert/strict";
import { classifyKnowledgeDifference as classify, partitionKnowledgeEnrichment } from "../lib/card-knowledge-reconciliation.ts";

test("missing reviewed evidence preserves retained knowledge, including false and zero values",()=>{
  assert.equal(classify("language","English",null),"retain-existing-unreviewed");
  assert.equal(classify("language",null,"English"),"missing-retained-field");
  assert.equal(classify("autograph",true,false),"populated-conflict");
  assert.equal(classify("printRun",10,0),"populated-conflict");
});

test("shared blank variants isolate conflicting enrichment while independent copies continue",()=>{
  const rows=[{cardId:"a",variantId:"blank",changes:[{field:"player",reviewed:"A"}]},
    {cardId:"b",variantId:"blank",changes:[{field:"player",reviewed:"B"}]},
    {cardId:"c",variantId:"valid",changes:[{field:"serial",reviewed:"1/10"}]},
    {cardId:"d",variantId:"valid",changes:[{field:"serial",reviewed:"2/10"}]}];
  const saved=JSON.stringify(rows),result=partitionKnowledgeEnrichment(rows);
  assert.deepEqual(result.held.map(r=>r.cardId),["a","b"]);
  assert.deepEqual(result.reviewCandidates.map(r=>r.cardId),["c","d"]);
  assert.equal(result.autoApply,false);assert.equal(JSON.stringify(rows),saved);
  assert.throws(()=>partitionKnowledgeEnrichment([rows[0],rows[0]]),/Duplicate/);
});
test("only exact season prefixes and complete numeric serial formatting are aliases",()=>{
  assert.equal(classify("set","2026 Bowman Chrome","Bowman Chrome","2026"),"season-prefix-alias");
  assert.equal(classify("set","2025 Bowman Chrome","Bowman Chrome","2026"),"populated-conflict");
  assert.equal(classify("serial","005/099","5/99"),"numeric-format-alias");
  assert.equal(classify("serial","056/149","054/149"),"populated-conflict");
  assert.equal(classify("serial","5","5/99"),"populated-conflict");
  assert.equal(classify("serial","9007199254740992/9999999999999999","9007199254740993/9999999999999999"),"populated-conflict");
  assert.equal(classify("parallel","Orange","Orange Atomic"),"populated-conflict");
});
