// An attestation gate, not an eBay client. Retained captures must still be reviewed.
export const requiredImportFields = ['photos','identity','price','quantity','description','condition','shippingPolicy','paymentPolicy','returnPolicy','location'];
export function assessBulkImportTrial(trial, evidenceExists = (_path) => false) {
  const failures = [];
  if (!trial || trial.kind !== 'live-bulk-import') return {passed:false,failures:['Live import evidence required']};
  if (trial.browserFieldRepairs !== 0) failures.push('Browser repairs invalidate import-only proof');
  if (trial.published !== false || trial.inventoryDuplicated !== false) failures.push('Publication/duplicate-inventory boundary not verified');
  if (!trial.jobId || !trial.responseEvidence || !evidenceExists(trial.responseEvidence)) failures.push('Retained import response required');
  const rows = Array.isArray(trial.rows) ? trial.rows : [];
  if (rows.length < 2 || new Set(rows.map(r=>r.draftId)).size !== rows.length || rows.some(r=>!r.draftId)) failures.push('At least two distinct saved draft IDs required');
  for (const row of rows) {
    if (!row.evidence || !evidenceExists(row.evidence)) failures.push(`${row.draftId}: saved-state evidence missing`);
    for (const field of requiredImportFields) if (row.fields?.[field] !== true) failures.push(`${row.draftId}: ${field} not verified`);
  }
  const start=Date.parse(trial.startedAt),end=Date.parse(trial.verifiedAt);
  const secondsPerCard=(end-start)/1000/rows.length;
  if (!Number.isFinite(secondsPerCard) || end<=start || trial.timingScope!=='source-manifest-through-saved-verification') failures.push('Full source-to-saved-verification clock required');
  else if (secondsPerCard>90) failures.push('Exceeds 90 seconds/card ceiling');
  return {passed:failures.length===0,failures,secondsPerCard:Number.isFinite(secondsPerCard)?secondsPerCard:null,under60:failures.length===0&&secondsPerCard<60};
}
