import assert from "node:assert/strict";
import test from "node:test";
import { opportunitiesForView,searchOpportunitiesForView } from "../lib/seller-opportunity-view.ts";

type Row={id:string;kind:"single"|"lot";searchText:string};
const rows:Row[]=[
  ...Array.from({length:88},(_,index)=>({id:`single-${index}`,kind:"single" as const,searchText:index===0?"victor wembanyama silver":"individual card"})),
  ...Array.from({length:53},(_,index)=>({id:`lot-${index}`,kind:"lot" as const,searchText:index===0?"victor wembanyama 17 cards lot":"multi card lot"})),
];

test("view populations reconcile and never cross classifications",()=>{
  const singles=opportunitiesForView(rows,"singles");
  const lots=opportunitiesForView(rows,"lots");
  const all=opportunitiesForView(rows,"all");
  assert.equal(singles.length,88);
  assert.equal(singles.filter(row=>row.kind==="lot").length,0);
  assert.equal(lots.length,53);
  assert.equal(lots.filter(row=>row.kind==="single").length,0);
  assert.equal(all.length,141);
});

test("switching Lots to Singles derives a fresh collection",()=>{
  const lots=opportunitiesForView(rows,"lots");
  const singles=opportunitiesForView(rows,"singles");
  assert.equal(lots.length,53);
  assert.equal(singles.length,88);
  assert.notEqual(lots,singles);
});

test("search is scoped to the current tab and clear restores its population",()=>{
  const singleResults=searchOpportunitiesForView(rows,"singles","VICTOR WEMBANYAMA");
  const lotResults=searchOpportunitiesForView(rows,"lots","victor wembanyama");
  assert.equal(singleResults.length,1);
  assert.equal(singleResults.every(row=>row.kind==="single"),true);
  assert.equal(lotResults.length,1);
  assert.equal(lotResults.every(row=>row.kind==="lot"),true);
  assert.equal(searchOpportunitiesForView(rows,"singles","").length,88);
  assert.equal(searchOpportunitiesForView(rows,"lots","   ").length,53);
});
