import { strict as assert } from "node:assert";
import { test } from "node:test";
import { summarizeAiWorkflow, validateAiWorkflowEvent, type AiWorkflowEvent } from "../lib/ai-workflow-telemetry.ts";

const base: AiWorkflowEvent = {
  eventId: "event-1", workflowId: "workflow-1", cardId: "card-1",
  stage: "identify", provider: "openai", attempt: 1,
  outcome: "succeeded", timestamp: "2026-11-07T14:00:00Z",
  costSource: "provider-reported", costUsd: 0.01,
};
test("provider-neutral event accepts valid reported cost", () => {
  assert.doesNotThrow(() => validateAiWorkflowEvent(base));
});
test("unknown cost is never silently converted to zero", () => {
  const result = summarizeAiWorkflow([{ ...base, costSource: "unknown", costUsd: undefined }]);
  assert.equal(result.costCoverageComplete, false);
  assert.equal(result.costPerVerifiedDraftUsd, null);
});
test("draft success requires a receipt", () => {
  assert.throws(() => validateAiWorkflowEvent({ ...base, stage: "draft" }), /receipt/);
});
test("cost per verified draft only with full cost coverage", () => {
  const draft: AiWorkflowEvent = { ...base, eventId: "event-2", stage: "draft", externalReceiptId: "draft-123", costUsd: 0.04 };
  const result = summarizeAiWorkflow([base, draft]);
  assert.equal(result.completedDrafts, 1);
  assert.ok(Math.abs(result.costPerVerifiedDraftUsd! - 0.05) < 1e-9);
});
test("duplicate stage receipts do not double-count draft workflows", () => {
  const draft: AiWorkflowEvent = { ...base, stage: "draft", externalReceiptId: "draft-123" };
  assert.equal(summarizeAiWorkflow([draft, { ...draft, eventId: "event-3" }]).completedDrafts, 1);
});
