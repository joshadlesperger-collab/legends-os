import type { DraftCard } from "./card-listing-factory.ts";

export type PhotoSide = "front" | "back";
export type PairedCard = { id: string; draft: DraftCard };
export type PairOrder = "alternating" | "fronts-first";

export function pairPhotoIds(ids: string[], order: PairOrder): [string, string | undefined][] {
  const count = Math.ceil(ids.length / 2);
  return Array.from({ length: count }, (_, i) => order === "fronts-first"
    ? [ids[i], ids[i + count]] : [ids[i * 2], ids[i * 2 + 1]]);
}

/** Swap occupied slots, preserving displaced photos and invalidating both approvals. */
export function assignPhoto(cards: PairedCard[], targetId: string, side: PhotoSide, photoId?: string): PairedCard[] {
  const key = side === "front" ? "frontImageId" : "backImageId";
  const target = cards.find(c => c.id === targetId);
  if (!target || target.draft[key] === photoId) return cards;
  const displaced = target.draft[key];
  return cards.map(c => {
    const draft = { ...c.draft };
    let changed = false;
    for (const slot of ["frontImageId", "backImageId"] as const) {
      if (photoId && draft[slot] === photoId) { draft[slot] = displaced; changed = true; }
    }
    if (c.id === targetId) { draft[key] = photoId; changed = true; }
    return changed ? { ...c, draft: { ...draft, verified: false } } : c;
  });
}
