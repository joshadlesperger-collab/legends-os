import { z } from "zod";
import type { CardCatalog } from "./card-knowledge.ts";

const text=z.string().min(1);
const auditSchema=z.object({version:z.literal(1),productId:text,auditedOn:text,method:text,sourceHashes:z.record(z.string(),text),checklistRows:z.number().int(),baseCards:z.number().int(),missingBaseNumbers:z.array(z.number()),sourceOmittedTeams:z.number(),
  formats:z.array(z.object({id:text,label:text,edition:z.enum(["chrome","sapphire"])})),
  oddsRows:z.array(z.object({oddsId:text,label:text,sourcePage:z.number().int(),bbox:z.array(z.number()).length(4),cells:z.array(z.object({formatId:text,ratio:z.string().regex(/^\d+:\d+$/),numerator:z.number().int().positive(),denominator:z.number().int().nonnegative(),status:z.enum(["transcribed","source-anomaly"]),x1:z.number()}))})),
  sections:z.array(z.object({section:text,entries:z.number().int(),formatIds:z.array(text),oddsIds:z.array(text),editionStatus:text})),
  findings:z.array(z.object({code:text,status:text,action:text})),limitations:z.array(text)});
const registrySchema=z.object({version:z.literal(1),checkedOn:text,productId:text,sources:z.array(z.object({id:text,url:z.string().url(),owner:text,role:text,access:text,acquisitionStatus:text,reuseStatus:text,retention:text,refresh:text,parser:text,automaticCollection:z.literal(false),sha256:z.string().regex(/^[a-f0-9]{64}$/).nullable(),permittedEvidence:z.array(text),excludedUses:z.array(text)}))});
export function validateCatalogAudit(cardCatalog: CardCatalog, auditInput: unknown, registryInput: unknown) {
  const catalogAudit=auditSchema.parse(auditInput), sourceRegistry=registrySchema.parse(registryInput);
  if(catalogAudit.productId!==cardCatalog.product.id||sourceRegistry.productId!==cardCatalog.product.id||catalogAudit.checklistRows!==cardCatalog.cards.length) throw Error("Audit/catalog mismatch");
  const formats=new Set(catalogAudit.formats.map(f=>f.id));
  const rows=new Map(cardCatalog.odds.map(r=>[r.id,r]));
  if(new Set(catalogAudit.oddsRows.map(r=>r.oddsId)).size!==rows.size||catalogAudit.oddsRows.length!==rows.size) throw Error("Odds coverage mismatch");
  for(const source of cardCatalog.sources) {
    if(catalogAudit.sourceHashes[source.id]!==source.sha256||sourceRegistry.sources.find(s=>s.id===source.id)?.sha256!==source.sha256) throw Error("Stale audit or registry");
  }
  for(const row of catalogAudit.oddsRows) {
    const source=rows.get(row.oddsId);
    if(!source||source.label!==row.label||source.sourcePage!==row.sourcePage||source.ratios.slice().sort().join()!==row.cells.map(c=>c.ratio).sort().join()) throw Error("Odds transcription mismatch");
    if(new Set(row.cells.map(c=>c.formatId)).size!==row.cells.length) throw Error("Duplicate format cell");
    for(const cell of row.cells) if(!formats.has(cell.formatId)||cell.ratio!==`${cell.numerator}:${cell.denominator}`||(cell.denominator===0)!==(cell.status==="source-anomaly")) throw Error("Invalid odds cell");
  }
  if(catalogAudit.sections.reduce((sum,s)=>sum+s.entries,0)!==cardCatalog.cards.length) throw Error("Section coverage mismatch");
  return {catalogAudit,sourceRegistry};
}
