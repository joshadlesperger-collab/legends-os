import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, writeFile, rm, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { cardPreviewCache, renderCardPreview } from "../lib/card-preview-cache.ts";
import { prepareBenchmarkPacket } from "../lib/benchmark-preparation.ts";

test("preview cache survives restarts and corruption, invalidates changed bytes, and tolerates unavailable storage", async () => {
  const dir = await mkdtemp(join(tmpdir(), "preview-cache-"));
  try {
    const original = await sharp({ create: { width: 30, height: 30, channels: 3, background: "red" } }).png().toBuffer();
    const expected = await renderCardPreview(original);
    const cache = cardPreviewCache(dir);
    assert.deepEqual(await cache.render(original), expected);
    const restarted = cardPreviewCache(dir);
    assert.deepEqual(await restarted.render(original), expected); assert.equal(restarted.stats.hits, 1);
    await writeFile(join(dir, (await readdir(dir))[0]), '{"broken":true}');
    assert.deepEqual(await restarted.render(original), expected); assert.equal(restarted.stats.misses, 1);
    const changed = await sharp(original).negate().png().toBuffer();
    assert.deepEqual(await restarted.render(changed), await renderCardPreview(changed)); assert.equal(restarted.stats.misses, 2);
    const blocked = join(dir, "file"); await writeFile(blocked, "not a directory");
    const fallback = cardPreviewCache(blocked);
    assert.deepEqual(await fallback.render(original), expected); assert.equal(fallback.stats.unavailable, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("one changed original is isolated while an independent card completes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "preparation-isolation-"));
  try {
    const original = await sharp({create:{width:30,height:30,channels:3,background:"blue"}}).png().toBuffer();
    const {createHash}=await import("node:crypto");
    const photo=join(dir,"original.png");await writeFile(photo,original);
    const digest=createHash("sha256").update(original).digest("hex");
    const selected={cards:["bad","good"].map(id=>({id,photos:[{resolvedPath:photo,sha256:digest},{resolvedPath:photo,sha256:digest}],
      identity:{player:"Fixture",manufacturer:"Fixture",set:"Fixture",cardNumber:"1",parallel:"Base",serial:"",printRun:null,autograph:false},
      source:{jobs:{pricing:{state:"held",reason:"Synthetic missing evidence"}}}}))};
    selected.cards[0].photos[0].sha256 = "invalid";
    const input = join(dir, "selected.json"); await writeFile(input, JSON.stringify(selected));
    const out = join(dir, "out"); await mkdir(out);
    const handoff=join(dir,"handoff.json");
    await writeFile(handoff,JSON.stringify({policyVersion:"fixture",cards:selected.cards.map(c=>({id:c.id,pricing:{},nextOwner:"pricing",blockers:["Missing evidence"]}))}));
    const result = await prepareBenchmarkPacket(out, renderCardPreview, { selected: input, handoff });
    assert.equal(result.cards, 1); assert.equal(result.cases, 2);
    assert.equal(result.exceptions.length, 1); assert.match(result.exceptions[0].reason, /hash mismatch/);
    const packet = JSON.parse(await readFile(join(out, "five-card-cases.json"), "utf8"));
    assert.ok(packet.cases.every((c: { id: string }) => c.id.startsWith(selected.cards[1].id)));
    assert.equal(await readFile(join(out,"handoff-input.json"),"utf8"),await readFile(handoff,"utf8"));
    const provenance=JSON.parse(await readFile(join(out,"input-provenance.json"),"utf8"));
    assert.equal(provenance.selected.sha256,createHash("sha256").update(await readFile(input)).digest("hex"));
    await assert.rejects(prepareBenchmarkPacket(out,renderCardPreview,{selected:input,handoff}),/already exists/);
    assert.deepEqual(JSON.parse(await readFile(join(out,"five-card-cases.json"),"utf8")),packet);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
