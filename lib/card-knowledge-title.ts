/** Catalog-level suggestions only; physical-copy attributes require listing review. */
export const KNOWLEDGE_TITLE_POLICY = "catalog-ebay-title-v1";
type TitleProduct = { season: string; printedYear: number; name: string };
type TitleCard = { player: string; cardNumber: string; section: string; category: string; rookie: boolean };
const clean = (value: string) => value.normalize("NFC").trim().replace(/\s+/g, " ");
const titleCase = (value: string) => value.toLowerCase().replace(/\b\w/g, c => c.toUpperCase()).replace(/\bIi\b/g, "II");

export function recommendedEbayTitle(product: TitleProduct, card: TitleCard): string {
  const setName = clean(product.name.replace(product.season, "").replace(/\bBasketball\b/i, ""));
  let section = card.section === "BASE CARDS" ? "" : titleCase(card.section)
    .replace(/^Topps Chrome\s*/i, "")
    .replace(/\bAutographs?\b/gi, "Auto")
    .replace(/\bRelics\b/gi, "Relic")
    .replace(/\bRookies?\b/gi, "")
    .replace(/\bBase Card Variations\b/i, "Base Variation")
    .replace(/\bRedemption Card\b/i, "Redemption");
  section = clean(section);
  // The category distinguishes otherwise identical Gold Logoman checklist headings.
  if (card.category.includes("AUTOGRAPH") && !/\b(?:Auto|Signatures)\b/.test(section)) section += " Auto";
  if (card.category.includes("RELIC") && !/\bRelic\b/.test(section)) section += " Relic";
  const compose = (label: string) => clean([product.season, setName, card.player, `#${card.cardNumber}`, label, card.rookie ? "RC" : ""].filter(Boolean).join(" "));
  const title = compose(section);
  if (title.length <= 80) return title;
  // Meaning-preserving abbreviations; never slice player names or card numbers.
  const compact = compose(section.replace(/\bSignatures\b/g, "Sigs").replace(/\bAutograph\b/g, "Auto"));
  if (compact.length <= 80) return compact;
  const printedYearTitle = compact.replace(product.season, String(product.printedYear));
  if (printedYearTitle.length <= 80) return printedYearTitle;
  if (/\bAuto\b/.test(section) && /\bRedemption\b/.test(section)) {
    const redemptionTitle = printedYearTitle.replace(" Relic ", " ").replace(`#${card.cardNumber}`, card.cardNumber);
    if (redemptionTitle.length <= 80) return redemptionTitle;
  }
  throw Error(`Checklist title exceeds 80 characters for entry ${card.cardNumber}; review required`);
}
