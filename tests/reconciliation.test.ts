import assert from "node:assert/strict";
import test from "node:test";
import { rankReconciliationCandidates, scoreReconciliationCandidate, type ReconciliationLine, type ReconciliationListing } from "../lib/reconciliation.ts";
import { parseCsv, parseOptionalMoney, validateCostRow } from "../lib/cost-basis-import.ts";

const line: ReconciliationLine = { id: "line", storeId: "store", ebayItemId: "item-1", sku: "SKU-1", title: "2020 Topps Chrome #12 Player Gold PSA 10", lineItemCost: 50, soldAt: new Date("2026-01-10") };
const listing: ReconciliationListing = { id: "listing", storeId: "store", ebayItemId: "item-1", sku: "SKU-1", title: line.title, currentPrice: 50, startTime: new Date("2025-12-01"), endTime: new Date("2026-01-11") };

test("exact provider item identity is deterministic", () => { const result = scoreReconciliationCandidate(line, listing); assert.equal(result?.confidence, 100); assert.equal(result?.tier, "deterministic"); });
test("exact SKU is deterministic when item identity is absent", () => { const result = scoreReconciliationCandidate({ ...line, ebayItemId: "old" }, listing); assert.equal(result?.confidence, 100); assert.match(result?.reasons.join(" ") ?? "", /SKU/); });
test("attribute-only match is deliberately below auto-link threshold", () => { const result = scoreReconciliationCandidate({ ...line, ebayItemId: "old", sku: null }, { ...listing, ebayItemId: "new", sku: null }); assert.ok(result); assert.ok(result!.confidence < 100); });
test("cross-store candidates are rejected", () => assert.equal(scoreReconciliationCandidate(line, { ...listing, storeId: "other" }), null));
test("candidate ranking is stable and bounded", () => { const rows = rankReconciliationCandidates({ ...line, ebayItemId: "none", sku: null }, [{ ...listing, id: "b", ebayItemId: "b", sku: null }, { ...listing, id: "a", ebayItemId: "a", sku: null }], 1); assert.equal(rows.length, 1); assert.equal(rows[0].listingId, "a"); });
test("CSV parser supports quoted notes and preview validation", () => { const rows = parseCsv('ebay_item_id,acquisition_cost,notes\n123,10.25,"box, show"'); assert.equal(rows[0].notes, "box, show"); assert.deepEqual(validateCostRow(rows[0]), []); assert.equal(parseOptionalMoney(rows[0].acquisition_cost), 10.25); });
test("CSV validation rejects missing identity and negative money", () => { const errors = validateCostRow({ rowNumber: 2, acquisition_cost: "-1" }); assert.equal(errors.length, 2); });
