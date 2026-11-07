/**
 * Provider-neutral AI workflow telemetry contract.
 * No provider SDK, database migration, network call, or paid service required.
 * Instrumentation adapters can persist these events to the existing PostgreSQL
 * database and optionally forward them to Langfuse after approval.
 */
export type AiProvider = "openai" | "grok" | "muse" | "other";
export type AiStage = "identify" | "validate" | "draft" | "price" | "review";
export type AiOutcome = "started" | "succeeded" | "failed" | "held";
export type CostSource = "provider-reported" | "calculated" | "unknown";

export interface AiWorkflowEvent {
  eventId: string;
  workflowId: string; // stable card workflow ID, not a filename
  cardId: string;
  stage: AiStage;
  provider: AiProvider;
  model?: string;
  attempt: number;
  outcome: AiOutcome;
  timestamp: string; // UTC ISO-8601
  elapsedMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  costSource: CostSource;
  errorCode?: string; // sanitized code only, never raw prompt or credentials
  externalReceiptId?: string; // eBay verified draft reference when applicable
}

export function validateAiWorkflowEvent(event: AiWorkflowEvent): void {
  if (!event.eventId || !event.workflowId || !event.cardId) throw new Error("Missing workflow identity");
  if (!Number.isInteger(event.attempt) || event.attempt < 1) throw new Error("Invalid attempt");
  if (!Number.isFinite(Date.parse(event.timestamp))) throw new Error("Invalid timestamp");
  for (const value of [event.elapsedMs, event.inputTokens, event.outputTokens]) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) throw new Error("Invalid usage");
  }
  if (event.costSource === "unknown" && event.costUsd !== undefined) throw new Error("Unknown cost cannot have a dollar value");
  if (event.costSource !== "unknown" && (event.costUsd === undefined || !Number.isFinite(event.costUsd) || event.costUsd < 0)) {
    throw new Error("Known cost requires nonnegative USD amount");
  }
  if (event.outcome === "succeeded" && event.stage === "draft" && !event.externalReceiptId) {
    throw new Error("Draft success requires external receipt");
  }
}

export function summarizeAiWorkflow(events: AiWorkflowEvent[]) {
  events.forEach(validateAiWorkflowEvent);
  const completedDrafts = new Set(events.filter(e => e.stage === "draft" && e.outcome === "succeeded" && e.externalReceiptId).map(e => e.workflowId)).size;
  const knownCostUsd = events.reduce((sum, e) => sum + (e.costUsd ?? 0), 0);
  const unknownCostEvents = events.filter(e => e.costSource === "unknown").length;
  return {
    events: events.length,
    completedDrafts,
    knownCostUsd,
    unknownCostEvents,
    costPerVerifiedDraftUsd: completedDrafts > 0 && unknownCostEvents === 0 ? knownCostUsd / completedDrafts : null,
    costCoverageComplete: unknownCostEvents === 0,
  };
}
