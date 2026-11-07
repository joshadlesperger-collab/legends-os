const normalized = (value: unknown) => String(value ?? "").normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();

/** Review classification only. Never authorizes applying or deleting retained knowledge. */
export function classifyKnowledgeDifference(field: string, retained: unknown, reviewed: unknown, season?: string) {
  const oldValue = normalized(retained), newValue = normalized(reviewed);
  if (oldValue === newValue) return "equivalent";
  if (!newValue) return "retain-existing-unreviewed";
  if (!oldValue) return "missing-retained-field";
  if (field === "set" && normalized(season) && oldValue === `${normalized(season)} ${newValue}`) return "season-prefix-alias";
  if (field === "serial" && /^\d+\/\d+$/.test(oldValue) && /^\d+\/\d+$/.test(newValue)
    && oldValue.replace(/\d+/g,n=>n.replace(/^0+(?=\d)/,"")) === newValue.replace(/\d+/g,n=>n.replace(/^0+(?=\d)/,""))) return "numeric-format-alias";
  return "populated-conflict";
}

export type KnowledgeEnrichment = {cardId:string;variantId:string;changes:{field:string;reviewed:unknown}[]};
/** Variant fields are shared; serials remain copy-specific. Conflicts isolate only their variant. */
export function partitionKnowledgeEnrichment(rows: KnowledgeEnrichment[]) {
  const values=new Map<string,Set<string>>(),conflicts=new Set<string>();
  if(new Set(rows.map(r=>r.cardId)).size!==rows.length)throw Error("Duplicate enrichment card");
  for(const row of rows) {
    if(!row.cardId.trim()||!row.variantId.trim())throw Error("Missing enrichment binding");
    for(const change of row.changes) {
      if(change.field==="serial")continue;
      const key=JSON.stringify([row.variantId,change.field]);
      const set=values.get(key)??new Set<string>();set.add(JSON.stringify(change.reviewed));values.set(key,set);
      if(set.size>1)conflicts.add(row.variantId);
    }
  }
  return {reviewCandidates:rows.filter(r=>!conflicts.has(r.variantId)),
    held:rows.filter(r=>conflicts.has(r.variantId)),conflictingVariantIds:Array.from(conflicts),autoApply:false};
}
