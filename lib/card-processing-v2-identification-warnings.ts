import type { V2Identification } from "./card-processing-v2.ts";

// Each clause must be a known optical/holder caveat. Unknown clauses never
// become advisory merely because the same warning also mentions a holder.
const holder = "(?:the |a |this )?(?:(?:protective|plastic|clear|scratched) )*(?:holder|sleeve|case|toploader|top-loader)";
const caveats = [
  new RegExp(`^(?:surface )?(?:scratches|scuffs|marks|glare|reflections?)(?: and (?:marks|scratches|dust))? (?:are |is )?(?:visible )?(?:only )?(?:on|from) ${holder}(?: only)?$`),
  new RegExp(`^${holder} (?:has|shows) (?:visible |surface )?(?:scratches|scuffs|glare|reflections?)(?: and (?:scratches|scuffs))?$`),
  new RegExp(`^${holder} is (?:scratched|scuffed)$`),
  new RegExp(`^the card is (?:inside|in) ${holder}$`),
  new RegExp(`^(?:card[- ]surface |card surface |surface )?condition (?:cannot be fully assessed|is not fully assessable)(?: through (?:it|${holder}))?$`),
  /^card-surface condition beneath it cannot be fully assessed$/,
  /^no (?:definite |definitive |visible )?card damage is (?:visible|established(?: from these photos)?)$/,
];
// These actual provider clauses explicitly deny definite damage. Without that
// qualifier, attribution ambiguity remains blocking; visible edge wear never qualifies.
const noDamageOpticalClauses=[
  /^protective holder reflections limit fine surface inspection$/,
  /^(?:the )?card(?:s)? (?:is|are) photographed (?:inside|in|through) (?:a )?(?:sleeve and rigid holder|protective holder|protective holders|protective plastic)$/,
  /^surface marks on the (?:holder|protection) cannot reliably be distinguished from marks on the card$/,
  /^sleeve and rigid-holder reflections and surface marks limit condition assessment$/,
  /^(?:surface )?scratches and reflections on the protective holder limit assessment of the card's surface$/,
  /^holder scratches and reflections limit assessment of the card surfaces$/,
  /^protective-holder scratches and glare limit surface-condition assessment$/,
  /^protective-holder scratches and reflections limit (?:surface-condition assessment|inspection of the card surface|surface inspection|assessment of the card surface)$/,
  /^scratches and reflections on the protective holder limit inspection of the card surface$/,
  /^sleeve and rigid-holder reflections and surface marks limit inspection of the card's condition$/,
  /^visible holder scratches and reflections limit assessment of the card's surface$/,
  /^the protective holder has visible scratches and scuffs$/,
  /^these limit assessment of the card surface$/,
];

/** Preserve every warning; only explicit holder-only caveats are informational.
 * Genuine damage, uncertainty and unrecognized language remain blocking. */
export function classifyV2IdentificationWarnings(finding: V2Identification) {
  const advisory: string[] = [], blocking: string[] = [];
  const canUseDefault = finding.identity && !finding.identity.damage && !finding.identity.graded && finding.pairMatches && finding.upright && finding.frontImageIndex === "0";
  for (const warning of finding.warnings) {
    const text = warning.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
    const clauses = text.split(/[.;!?]+/).map(c => c.trim()).filter(Boolean);
    const holderCaveat = /\b(holder|holders|sleeve|case|toploader|top-loader)\b/.test(text) && /scratch|scuff|marks|glare|reflection/.test(text);
    const explicitNoDamage=clauses.some(c=>/^no (?:definite|definitive) card damage is (?:visible|established(?: from these photos)?)$/.test(c));
    const knownOnly = clauses.length > 0 && clauses.every(c => caveats.some(pattern => pattern.test(c))||(explicitNoDamage&&noDamageOpticalClauses.some(pattern=>pattern.test(c))));
    (canUseDefault && holderCaveat && knownOnly ? advisory : blocking).push(warning);
  }
  return { advisory, blocking };
}
