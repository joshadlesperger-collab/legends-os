import test from "node:test";
import assert from "node:assert/strict";
import { recognitionSchema, recognizedIdentity, validateRecognitionImages } from "../lib/card-recognition.ts";
import { filterFactorySoldRows } from "../lib/card-sold-research.ts";
const identity = { sport:"Baseball" as const, player:"Hunter Goodman",year:2026,manufacturer:"Topps",set:"Finest",cardNumber:"155",parallel:"Gold Geometric Refractor",numberedTo:50,serialNumber:"30/50" };
const row = {id:"123", title:"2026 Topps Finest Hunter Goodman #155 Gold Geometric Refractor 12/50",card_number:"155",print_run:50,price_confirmed:true,currency:"USD",sale_price:10,shipping_price:1.49,sale_date:"2026-10-01",listing_url:"https://www.ebay.com/itm/123"};
test("recognition accepts explicit uncertainty without filling invented identity",()=>{
 const result=recognitionSchema.parse({pairMatches:true,frontImageIndex:"1",identity:{sport:"Baseball",player:"Hunter Goodman",year:null,manufacturer:"Topps",set:"Finest",cardNumber:null,team:null,parallel:null,serialNumber:null,numberedTo:null,rookie:null,autograph:null,graded:null,grade:null},warnings:["Year unreadable"]});
 const card=recognizedIdentity(result); assert.equal(card.year,0); assert.equal(card.cardNumber,""); assert.equal(card.parallel,undefined); assert.equal(result.frontImageIndex,"1");
 assert.throws(()=>recognitionSchema.parse({...result,frontImageIndex:"2"}));
});
test("image input rejects URLs, malformed bodies, spoofed formats and oversized bytes",()=>{
 const jpeg="data:image/jpeg;base64,"+Buffer.from([255,216,255,217]).toString("base64");
 assert.equal(validateRecognitionImages([jpeg,jpeg]).length,2);
 for(const input of [[],[jpeg],["https://example.com/private.jpg",jpeg],["data:image/png;base64,ZmFrZQ==",jpeg], ["x".repeat(2_000_001),jpeg]]) assert.throws(()=>validateRecognitionImages(input));
});
test("automated research accepts only confirmed exact fresh evidence",()=>{
 const result=filterFactorySoldRows(identity,[row],"2026-10-16"); assert.equal(result.comps.length,1); assert.equal(result.comps[0].verified,true); assert.equal(result.comps[0].itemPrice,10); assert.equal(result.comps[0].shipping,1.49);
 for(const patch of [{price_confirmed:undefined},{price_confirmed:false},{currency:"EUR"},{shipping_price:null},{title:"2026 Topps Finest Hunter Goodman #155 Refractor /50"},{print_run:99},{title:row.title+" PSA 9"},{title:row.title+" Auto"},{title:row.title+" lot"},{sale_date:"2020-01-01"},{listing_url:"javascript:alert(1)"},{sale_price:NaN}]) {
  const rejected=filterFactorySoldRows(identity,[{...row,...patch}],"2026-10-16");assert.equal(rejected.comps.length,0,JSON.stringify(patch));assert.equal(rejected.excluded.length,1);
 }
});
test("tracking URLs do not multiply one sale; distinct serials of same print run can compare",()=>{
 const result=filterFactorySoldRows(identity,[row,{...row,id:"other",listing_url:row.listing_url+"?tracking=1"}],"2026-10-16"); assert.equal(result.comps.length,1); assert.equal(result.excluded.length,1);
});

test("structured identity conflicts cannot hide behind a matching title",()=>{
 for(const patch of [{card_number:"999"},{year:2025},{player:"Other Player"},{print_run:50,title:row.title.replace("12/50","12/99")}]) assert.equal(filterFactorySoldRows(identity,[{...row,...patch}],"2026-10-16").comps.length,0);
});
