export type BacklogErrorCode = "LOCAL_EVIDENCE_UNAVAILABLE" | "SOURCE_CHANGED" | "EVIDENCE_INVALID" | "BACKLOG_READ_FAILED";
export class BacklogReadError extends Error {
  code: BacklogErrorCode;
  constructor(code: BacklogErrorCode) { super(code); this.code=code; }
}
/** Never send filesystem paths, source contents, or raw exception messages to the browser. */
export function backlogErrorResponse(error: unknown) {
  const code = error instanceof BacklogReadError ? error.code : error instanceof SyntaxError ? "EVIDENCE_INVALID" : "BACKLOG_READ_FAILED";
  const messages: Record<BacklogErrorCode,string> = {
    LOCAL_EVIDENCE_UNAVAILABLE: "Local card evidence is unavailable. Open Legends OS on the computer containing the canonical workspace; the hosted app cannot read your Windows files.",
    SOURCE_CHANGED: "Card evidence changed during refresh. Previous records are preserved; retry when the current update finishes.",
    EVIDENCE_INVALID: "Saved card evidence could not be validated. Previous records are preserved; inspect the local evidence before retrying.",
    BACKLOG_READ_FAILED: "The card backlog could not be loaded. Previous records are preserved; check the local application diagnostics.",
  };
  return {code,error:messages[code],retryable:code==="SOURCE_CHANGED"};
}
