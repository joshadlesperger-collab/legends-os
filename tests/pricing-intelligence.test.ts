import test from "node:test";
import assert from "node:assert/strict";
import { estimateVariant, type VerifiedSale } from "../lib/pricing-intelligence.ts";
const target = {variantKey:"2025|chrome|1|raywave",playerId:"p1",productId:"chrome",parallelId:"raywave",condition:"raw"};
const make = (id:string, price:number):VerifiedSale => ({id,variantKey:target.variantKey,playerId:"p1",productId:"chrome",parallelId:"raywave",soldAt:"2026-10-01",itemPrice:price,shippingPrice:1,sourceUrl:"https://example.com/"+id,verified:true,condition:"raw"});
test("verified exact comps take precedence",()=>{const result=estimateVariant(target,[make("1",10),make("2",20),make("3",30)],"2026-10-23");assert.equal(result.method,"verified-exact");assert.equal(result.fairValue,21);assert.equal(result.reviewRequired,false)});
test("unverified, future, and excluded sales do not count",()=>{const result=estimateVariant(target,[{...make("1",10),verified:false},{...make("2",20),soldAt:"2027-01-01"},{...make("3",30),excluded:true}],"2026-10-23");assert.equal(result.method,"review");assert.equal(result.fairValue,null)});
test("sparse evidence never invents a premium",()=>{const result=estimateVariant(target,[make("1",10)],"2026-10-23");assert.equal(result.reviewRequired,true);assert.equal(result.method,"review")});
