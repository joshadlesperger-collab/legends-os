import test from "node:test";
import assert from "node:assert/strict";
import {applyIdentityCorrection,canMergeQuantities,priceFromSoldComp,projectListing,storageLocation,suggestedShipping,type CardIdentity} from "../lib/card-listing-factory.ts";

const card:CardIdentity={sport:"Baseball",player:"Hunter Goodman",year:2026,manufacturer:"Topps",set:"Finest",cardNumber:"155",team:"Colorado Rockies",parallel:"Gold Geometric Refractor",serialNumber:"30",numberedTo:50};
test("identity drives title, specifics, description, storage and quantity",()=>{
 const result=projectListing({identity:card,quantity:1,verified:true,frontImageId:"front",backImageId:"back"});
 assert.equal(result.requiresReview,false);
 assert.match(result.title,/Goodman/);
 assert.match(result.description,/30\/50/);
 assert.equal(result.specifics["Parallel/Variety"],"Gold Geometric Refractor");
 assert.equal(result.storageLocation,"Baseball / G");
 assert.equal(result.quantity,1);
});
test("a correction refreshes dependent fields and re-requires approval",()=>{
 const original={identity:{...card,parallel:"Refractor"},quantity:1,verified:true,frontImageId:"a",backImageId:"b",manualTitle:"Bad title"};
 const updated=applyIdentityCorrection(original,{parallel:"Gold Geometric Refractor"});
 const result=projectListing(updated);
 assert.match(result.title,/Gold Geometric/);
 assert.match(result.description,/Gold Geometric/);
 assert.equal(result.specifics["Parallel/Variety"],"Gold Geometric Refractor");
 assert.equal(result.requiresReview,true);
 assert.ok(result.reviewReasons.some(x=>x.includes("approval")));
});
test("identical base copies merge, numbered cards never auto-merge",()=>{
 const base={...card,parallel:undefined,serialNumber:undefined,numberedTo:undefined};
 assert.equal(canMergeQuantities(base,{...base}),true);
 assert.equal(canMergeQuantities(card,{...card}),false);
});
test("invalid photos, quantities and serials fail closed",()=>{
 const output=projectListing({identity:{...card,serialNumber:"51"},quantity:0,verified:true});
 assert.equal(output.requiresReview,true);
 assert.ok(output.reviewReasons.length>=3);
});
test("seller economics match policy",()=>{
 assert.equal(priceFromSoldComp(10),10.9);
 assert.equal(priceFromSoldComp(10,8),10.8);
 assert.equal(priceFromSoldComp(10,10),11);
 assert.equal(priceFromSoldComp(5.5,9),6);
 for(const premium of [7.99,10.01,NaN,Infinity]) assert.throws(()=>priceFromSoldComp(10,premium));
 for(const comp of [0,-1,NaN,Infinity]) assert.throws(()=>priceFromSoldComp(comp));
 assert.equal(suggestedShipping(9.99,false),1.49);
 assert.equal(suggestedShipping(10,false),1.95);
 assert.equal(suggestedShipping(20,false),6.29);
 assert.equal(suggestedShipping(5,true),6.29);
});
test("sport and last-name initial represent existing storage arrangement",()=>{
 assert.equal(storageLocation({ ...card,sport:"Football",player:"Patrick Mahomes"}),"Football / M");
});

test("serial denominator must match and cannot be duplicated in description",()=>{
 const draft={identity:{...card,serialNumber:"30/50"},quantity:1,verified:true,frontImageId:"a",backImageId:"b"};
 assert.equal(projectListing(draft).requiresReview,false);
 assert.doesNotMatch(projectListing(draft).description,/30\/50\/50/);
 assert.equal(projectListing({...draft,identity:{...card,serialNumber:"30/99"}}).requiresReview,true);
 for(const numberedTo of [0,-1,NaN,Infinity,1.5]) assert.equal(projectListing({...draft,identity:{...card,numberedTo}}).requiresReview,true);
});
test("duplicate photos and quantities other than one cannot be approved",()=>{
 const draft={identity:card,quantity:1,verified:true,frontImageId:"a",backImageId:"b"};
 for(const quantity of [0,2,1.5,NaN,Infinity]) assert.equal(projectListing({...draft,quantity}).requiresReview,true);
 assert.equal(projectListing({...draft,backImageId:"a"}).requiresReview,true);
});
test("rookie, autograph, condition and grade stay synchronized and distinct",()=>{
 const base={...card,serialNumber:undefined,numberedTo:undefined};
 assert.equal(canMergeQuantities(base,{...base,autograph:true}),false);
 assert.equal(canMergeQuantities(base,{...base,rookie:true}),false);
 const result=projectListing({identity:{...base,rookie:true,autograph:true,graded:true,grade:"PSA 9",condition:"Surface scratch"},quantity:1,verified:true,frontImageId:"a",backImageId:"b"});
 assert.match(result.description,/Rookie.*Autographed.*PSA 9.*Surface scratch/);
 assert.equal(result.specifics.Autographed,"Yes");
 assert.equal(result.specifics.Grade,"PSA 9");
 assert.match(result.title,/PSA 9/);
});
test("invalid identities never form a quantity group",()=>{
 const incomplete={...card,player:"",serialNumber:undefined,numberedTo:undefined};
 assert.equal(canMergeQuantities(incomplete,incomplete),false);
});
