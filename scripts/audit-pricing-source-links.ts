import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

// Audit a saved pricing-context response; never admit comps or alter pricing.
const input = process.argv[2];
if (!input) throw Error("Pass a saved pricing-context JSON response or command log");
const raw = readFileSync(input, "utf8");
const context = JSON.parse(raw.slice(raw.indexOf("{"))) as {
  cardId: string;
  savedCandidates: { source_item_id?: string; evidence_file?: string; source_title?: string }[];
};
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const sources = new Map<string, { text: string; sha256: string }>();
const rows = context.savedCandidates.map(candidate => {
  const path = candidate.evidence_file;
  if (!path) return { itemId: candidate.source_item_id, status: "missing-source-path" };
  try {
    let source = sources.get(path);
    if (!source) {
      const text = readFileSync(path, "utf8");
      source = { text, sha256: hash(text) };
      sources.set(path, source);
    }
    const id = candidate.source_item_id;
    const itemUrlPresent = Boolean(id && /^\d+$/.test(id) && new RegExp(`/itm/${id}(?:[?\\s\"/]|$)`).test(source.text));
    return { itemId: id, source: path, itemUrlPresent,
      titlePresentInSource: Boolean(candidate.source_title && source.text.includes(candidate.source_title)),
      status: itemUrlPresent ? "source-link-found" : "source-link-missing" };
  } catch (error) {
    return { itemId: candidate.source_item_id, source: path, status: "source-unreadable",
      errorCode: (error as NodeJS.ErrnoException).code ?? "unknown" };
  }
});
for (const [path, source] of Array.from(sources)) {
  if (hash(readFileSync(path, "utf8")) !== source.sha256) throw Error("Source changed during audit");
}
if (readFileSync(input, "utf8") !== raw) throw Error("Context changed during audit");
const summary = rows.reduce<Record<string, number>>((counts, row) => {
  counts[row.status] = (counts[row.status] ?? 0) + 1;
  return counts;
}, {});
const output = `artifacts/engineering-mission/pricing-source-links-${Date.now()}.json`;
writeFileSync(output, JSON.stringify({ asOf: new Date().toISOString(), input, inputSha256: hash(raw),
  cardId: context.cardId, summary,
  limitation: "URL/title presence only; no verification of condition, physical-copy independence, sale validity, current freshness or pricing eligibility. Title presence is document-wide, not a join to the item URL.",
  sources: Array.from(sources, ([path, source]) => ({ path, sha256: source.sha256 })), rows }, null, 2), { flag: "wx" });
console.log(JSON.stringify({ output, cardId: context.cardId, summary }));
