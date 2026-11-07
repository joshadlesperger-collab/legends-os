import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { loadV2PolicyCatalog, bindV2PolicyFromCatalog, validateV2PolicyCatalogBinding, canonicalV2ReturnPolicyName } from "../lib/card-processing-v2-policy-bindings.ts";

function body() { return { at: new Date().toISOString(), source: "fresh seller-owned active item read for established policy/location only", itemId: "128169129237", seller: "imaydit58", location: "Waxahachie, Texas", country: "US", returnPolicy: "ReturnsNotAccepted", policies: {
  SellerShippingProfile: { ShippingProfileID: 248164773010, ShippingProfileName: "PWE - $1.95" }, SellerReturnProfile: { ReturnProfileID: 248164940010, ReturnProfileName: "No Return Accepted (248164940010)" }, SellerPaymentProfile: { PaymentProfileID: 248164941010, PaymentProfileName: "eBay Managed Payments (248164941010)" },
} }; }
async function fixture(run: (root: string, write: (value?: ReturnType<typeof body>) => Promise<{ path: string; sha256: string }>) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "v2-policy-catalog-"));
  try {
    await fs.mkdir(path.join(root, "artifacts"));
    const write = async (value = body()) => { const relative = "artifacts/policy-catalog.json", bytes = JSON.stringify(value); await fs.writeFile(path.join(root, relative), bytes); return { path: relative, sha256: createHash("sha256").update(bytes).digest("hex") }; };
    await run(root, write);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

test("actual-shaped fresh seller catalog binds a unique visible policy name without claiming a DOM ID", () => fixture(async (root, write) => {
  const reference = await write(), catalog = await loadV2PolicyCatalog(root, reference);
  const label = "PWE - $1.95 (875 listings)", options = ["PWE - $1.95 (875 listings)", "Another policy (12 listings)"];
  const binding = bindV2PolicyFromCatalog(catalog, "shipping", label, options);
  assert.equal(binding.policyId, "248164773010"); assert.equal(binding.source, "fresh-seller-catalog-by-unique-visible-name"); assert.deepEqual(binding.evidence, reference);
  assert.equal(validateV2PolicyCatalogBinding(catalog, binding, "shipping", label, options), "248164773010");
  assert.equal(catalog.location, "Waxahachie, Texas"); assert.ok(Object.isFrozen(catalog)); assert.ok(Object.isFrozen(catalog.profiles.shipping));
}));

test("duplicate visible names, wrong selected names and detached expected catalog objects cannot bind IDs", () => fixture(async (root, write) => {
  const catalog = await loadV2PolicyCatalog(root, await write()), label = "PWE - $1.95 (875 listings)";
  assert.throws(() => bindV2PolicyFromCatalog(catalog, "shipping", label, []), /uniquely/);
  assert.throws(() => bindV2PolicyFromCatalog(catalog, "shipping", label, [label, "PWE - $1.95 [12 listings]"]), /uniquely/);
  assert.throws(() => bindV2PolicyFromCatalog(catalog, "shipping", "Another policy (12 listings)", ["Another policy (12 listings)"]), /uniquely/);
  assert.throws(() => bindV2PolicyFromCatalog(structuredClone(catalog), "shipping", label, [label]), /hash-validated/);
}));

test("catalog bindings cannot be replayed with another selected label, source hash or policy type", () => fixture(async (root, write) => {
  const catalog = await loadV2PolicyCatalog(root, await write()), label = "PWE - $1.95 (875 listings)", binding = bindV2PolicyFromCatalog(catalog, "shipping", label, [label]);
  assert.throws(() => validateV2PolicyCatalogBinding(undefined, binding, "shipping", label, [label]), /validated/);
  assert.throws(() => validateV2PolicyCatalogBinding(catalog, { ...binding, evidence: { ...binding.evidence, sha256: "a".repeat(64) } }, "shipping", label, [label]), /does not match/);
  assert.throws(() => validateV2PolicyCatalogBinding(catalog, binding, "shipping", "PWE - $1.95 [876 listings]", ["PWE - $1.95 [876 listings]"]), /does not match/);
  assert.throws(() => validateV2PolicyCatalogBinding(catalog, binding, "payment", label, [label]), /uniquely/);
}));

test("only the exact catalog-backed no-return policy canonicalizes its numeric suffix", () => fixture(async (root, write) => {
  const catalog = await loadV2PolicyCatalog(root, await write());
  assert.equal(canonicalV2ReturnPolicyName(catalog, "No Return Accepted (248164940010)", "248164940010"), "No Return Accepted");
  assert.throws(() => canonicalV2ReturnPolicyName(undefined, "No Return Accepted (248164940010)", "248164940010"), /fresh/);
  assert.throws(() => canonicalV2ReturnPolicyName(catalog, "No Return Accepted (248164940010)", "999"), /exact/);
  assert.throws(() => canonicalV2ReturnPolicyName(catalog, "Another No Return Accepted (248164940010)", "248164940010"), /exact/);
  const contradictory = body(); contradictory.returnPolicy = "ReturnsAccepted";
  const otherCatalog = await loadV2PolicyCatalog(root, await write(contradictory));
  assert.throws(() => canonicalV2ReturnPolicyName(otherCatalog, "No Return Accepted (248164940010)", "248164940010"), /exact/);
}));

test("stale/future/wrong-seller sources, changed hashes and escaped paths cannot become verified policy catalogs", () => fixture(async (root, write) => {
  for (const mutate of [(value: ReturnType<typeof body>) => { value.at = new Date(Date.now() - 3601000).toISOString(); }, (value: ReturnType<typeof body>) => { value.at = new Date(Date.now() + 60000).toISOString(); }, (value: ReturnType<typeof body>) => { value.seller = "another-seller"; }]) {
    const value = body(); mutate(value); await assert.rejects(loadV2PolicyCatalog(root, await write(value)));
  }
  const reference = await write();
  await assert.rejects(loadV2PolicyCatalog(root, { ...reference, sha256: "f".repeat(64) }), /changed/);
  await assert.rejects(loadV2PolicyCatalog(root, { ...reference, path: "../outside.json" }), /under artifacts/);
  await assert.rejects(loadV2PolicyCatalog(root, { ...reference, path: path.join(root, reference.path) }), /under artifacts/);
}));
