import test from "node:test";
import assert from "node:assert/strict";
import {buildPerformanceReportCard} from "../lib/chief-performance-agent.ts";
import type {SalesVelocityData} from "../lib/sales-velocity.ts";
test("does not confuse missing traffic with zero impressions",()=>{
 const data={generatedAt:"2026-10-24T00:00:00Z",rows:[{listingId:"1",ebayItemId:"123",units30:0,units90:0,traffic:null,valuation:{action:null,confidence:null}}],completeEvidenceCount:0,probes:[]} as unknown as SalesVelocityData;
 const report=buildPerformanceReportCard(data);
 assert.equal(report.hypotheses[0].category,"evidence");assert.equal(report.listingsMissingTraffic,1);assert.equal(report.readOnly,true);
});
test("rejects unbounded investigation batches",()=>{
 const data={generatedAt:"x",rows:[],completeEvidenceCount:0,probes:[]} as unknown as SalesVelocityData;
 assert.throws(()=>buildPerformanceReportCard(data,10000));
});
