import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validatedJsonReader } from "../lib/validated-json-cache.ts";

test("content cache notices same-length edits, rejects malformed replacements and survives deletion", async () => {
  const dir = await mkdtemp(join(tmpdir(), "knowledge-cache-"));
  const file = join(dir, "summary.json");
  let validations = 0;
  const read = validatedJsonReader(file, raw => { validations++; return raw as { value: number }; });
  try {
    await writeFile(file, '{"value":1}');
    const first = await read(); assert.throws(() => { first.value = 99; }, TypeError);
    assert.deepEqual(await read(), { value: 1 }); assert.equal(validations, 1);
    await writeFile(file, '{"value":2}');
    assert.deepEqual(await read(), { value: 2 }); assert.equal(validations, 2);
    await writeFile(file, '{bad'); await assert.rejects(read());
    await unlink(file); await assert.rejects(read(), { code: "ENOENT" });
    await writeFile(file, '{"value":3}'); assert.deepEqual(await read(), { value: 3 });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("schema rejection is isolated and never poisons valid cache content", async () => {
  const dir = await mkdtemp(join(tmpdir(), "knowledge-cache-"));
  const file = join(dir, "summary.json");
  const read = validatedJsonReader(file, raw => { if (typeof raw !== "number") throw Error("invalid"); return raw; });
  try {
    await writeFile(file, '1'); assert.equal(await read(), 1);
    await writeFile(file, 'null'); await assert.rejects(read(), /invalid/);
    await writeFile(file, '2'); assert.equal(await read(), 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
