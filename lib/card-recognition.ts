import { z } from "zod";
import type { CardIdentity } from "./card-listing-factory.ts";

const text = z.string().max(200).nullable();
export const recognitionSchema = z.object({
  pairMatches: z.boolean(), frontImageIndex: z.enum(["0", "1", "unknown"]),
  identity: z.object({ sport: z.enum(["Baseball", "Football", "Basketball", "Hockey", "Soccer", "Other"]).nullable(),
    player: text, year: z.number().int().min(1880).max(2100).nullable(), manufacturer: text, set: text, cardNumber: text,
    team: text, parallel: text, serialNumber: text, numberedTo: z.number().int().positive().nullable(),
    rookie: z.boolean().nullable(), autograph: z.boolean().nullable(), graded: z.boolean().nullable(), grade: text }),
  warnings: z.array(z.string().max(300)).max(20),
});
export type Recognition = z.infer<typeof recognitionSchema>;
export function recognizedIdentity(result: Recognition): CardIdentity {
  const c = result.identity;
  return { sport: c.sport ?? "Other", player: c.player ?? "", year: c.year ?? 0, manufacturer: c.manufacturer ?? "", set: c.set ?? "", cardNumber: c.cardNumber ?? "",
    team: c.team ?? undefined, parallel: c.parallel ?? undefined, serialNumber: c.serialNumber ?? undefined, numberedTo: c.numberedTo ?? undefined,
    rookie: c.rookie ?? undefined, autograph: c.autograph ?? undefined, graded: c.graded ?? undefined, grade: c.grade ?? undefined };
}
export function validateRecognitionImages(images: unknown): string[] {
  if (!Array.isArray(images) || images.length !== 2) throw new Error("Two card image previews are required.");
  return images.map(image => {
    if (typeof image !== "string" || image.length > 2_000_000) throw new Error("Image preview too large.");
    const match = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(image);
    if (!match) throw new Error("Only embedded JPEG, PNG or WebP previews are accepted.");
    const bytes = Buffer.from(match[2], "base64");
    const valid = match[1] === "jpeg" ? bytes[0] === 255 && bytes[1] === 216 : match[1] === "png" ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
    if (!valid) throw new Error("Image preview does not match its declared format.");
    return image;
  });
}
