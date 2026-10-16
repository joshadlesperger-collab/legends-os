import test from "node:test";
import assert from "node:assert/strict";
import { blankMarginIssue, previewDimensions, withPhotoSourceReview } from "../lib/card-photo-source.ts";
import { projectListing, type DraftCard } from "../lib/card-listing-factory.ts";
import { prepareEbayDraftReview } from "../lib/card-ebay-draft.ts";

test("preview dimensions preserve the source aspect without a padded canvas or upscaling", () => {
  assert.deepEqual(previewDimensions(600,800),{width:600,height:800});
  assert.deepEqual(previewDimensions(3600,4800),{width:900,height:1200});
  assert.deepEqual(previewDimensions(4800,3600),{width:1200,height:900});
  assert.deepEqual(previewDimensions(1200,338),{width:1200,height:338});
  for(const [w,h] of [[0,1],[1,0],[NaN,1],[40000,40000]]) assert.throws(()=>previewDimensions(w,h));
});
function pixels(width:number,height:number,left:number,top:number,right:number,bottom:number) {
  const data=new Uint8ClampedArray(width*height*4).fill(255);
  for(let y=top;y<bottom;y++) for(let x=left;x<right;x++) {const i=(y*width+x)*4;data[i]=30;data[i+1]=70;data[i+2]=100;}
  return data;
}
test("large blank margins and blank images are flagged; normal card framing is accepted without cropping",()=>{
  assert.match(blankMarginIssue(pixels(120,34,0,0,22,30),120,34)!,/blank margins/);
  assert.match(blankMarginIssue(pixels(90,120,30,40,60,80),90,120)!,/blank margins/);
  assert.match(blankMarginIssue(pixels(90,120,0,0,0,0),90,120)!,/blank or too faint/);
  assert.equal(blankMarginIssue(pixels(90,120,2,2,88,118),90,120),undefined);
});
test("assigned source warnings block listing approval and local eBay handoff, but unrelated photos do not",()=>{
  const draft:DraftCard={identity:{sport:"Baseball",player:"Hunter Goodman",year:2026,manufacturer:"Topps",set:"Finest",cardNumber:"155"},quantity:1,verified:true,frontImageId:"front",backImageId:"back"};
  const invalid=withPhotoSourceReview(draft,[{id:"front",framingIssue:"Excessive blank margins"}]);
  assert.ok(projectListing(invalid).reviewReasons.some(x=>x.includes("Front photo")));
  assert.equal(prepareEbayDraftReview(invalid).preparedReview,null);
  assert.deepEqual(withPhotoSourceReview(draft,[{id:"unused",framingIssue:"Excessive blank margins"}]).photoReviewReasons,[]);
});
