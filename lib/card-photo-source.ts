import type { DraftCard } from "./card-listing-factory.ts";

export function previewDimensions(width: number, height: number) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height > 32_000_000) throw new Error("Invalid photo dimensions");
  const scale = Math.min(1, 1200 / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** Detection only: never crop white edges or manufacture missing card detail. */
export function blankMarginIssue(pixels: Uint8ClampedArray, width: number, height: number): string | undefined {
  if (pixels.length !== width * height * 4 || width < 1 || height < 1) throw new Error("Invalid photo pixel buffer");
  const columns = new Uint32Array(width), rows = new Uint32Array(height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    if (pixels[i + 3] > 32 && Math.min(pixels[i], pixels[i + 1], pixels[i + 2]) < 235) { columns[x]++; rows[y]++; }
  }
  const xs = Array.from(columns).flatMap((count, index) => count >= Math.max(2, height * 0.005) ? [index] : []);
  const ys = Array.from(rows).flatMap((count, index) => count >= Math.max(2, width * 0.005) ? [index] : []);
  if (!xs.length || !ys.length) return "Photo appears blank or too faint. Choose a clear original photo.";
  if ((xs[xs.length - 1] - xs[0] + 1) / width < 0.7 || (ys[ys.length - 1] - ys[0] + 1) / height < 0.7) return "Excessive blank margins detected. Crop the source photo while preserving every card edge, then upload it again.";
}

export function withPhotoSourceReview(draft: DraftCard, photos: { id: string; framingIssue?: string }[]): DraftCard {
  const reasons = (["front", "back"] as const).flatMap(side => {
    const id = side === "front" ? draft.frontImageId : draft.backImageId;
    const issue = photos.find(photo => photo.id === id)?.framingIssue;
    return issue ? [`${side === "front" ? "Front" : "Back"} photo: ${issue}`] : [];
  });
  return { ...draft, photoReviewReasons: reasons };
}
