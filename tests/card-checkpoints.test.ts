import assert from "node:assert/strict";
import test from "node:test";
import { applyCardEvent, replayCardEvents, type CardEvent } from "../lib/card-checkpoints.ts";
const make=(eventId:string,stage:CardEvent["stage"],status:CardEvent["status"]="complete"):CardEvent=>({cardId:"card-1",eventId,stage,status,at:"2026-10-28T12:00:00Z"});
test("restart replay restores stage and skips duplicate events",()=>{
 const events=[make("scan","scanned"),make("identify","identified"),make("price","priced")];
 const before=replayCardEvents(events)!;
 const restored=replayCardEvents(JSON.parse(JSON.stringify(events)))!;
 assert.deepEqual(restored,before);
 assert.deepEqual(applyCardEvent(restored,events[2]),restored);
 assert.equal(restored.checkpoint.version,3);
});
test("cannot skip or rewind stages",()=>{
 const scan=applyCardEvent(undefined,make("scan","scanned"));
 assert.throws(()=>applyCardEvent(scan,make("upload","bulk-upload")),/skip/);
 const identified=applyCardEvent(scan,make("id","identified"));
 assert.throws(()=>applyCardEvent(identified,make("back","scanned")),/rewind/);
});
test("held cards require reason and verified drafts require receipt",()=>{
 assert.throws(()=>applyCardEvent(undefined,make("hold","scanned","held")),/reason/);
 const events=[make("a","scanned"),make("b","identified"),make("c","priced"),make("d","bulk-upload")];
 const state=replayCardEvents(events)!;
 assert.throws(()=>applyCardEvent(state,make("e","verified-drafts")),/receipt/);
 const receipt={...make("e","verified-drafts"),draftId:"draft-123",verifiedAt:"2026-10-28T12:00:00Z"};
 assert.equal(applyCardEvent(state,receipt).checkpoint.draftId,"draft-123");
});
