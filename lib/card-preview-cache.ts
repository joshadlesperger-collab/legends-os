import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";

export const renderCardPreview = (bytes: Buffer) => sharp(bytes).rotate()
  .resize({ width: 1024, height: 1024, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 88 }).toBuffer();
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const recipe = JSON.stringify({ versions: sharp.versions, rotate: "exif", width: 1024, height: 1024, fit: "inside", withoutEnlargement: true, jpegQuality: 88 });

/** Derived data only. Callers must independently verify originals before using this. */
export function cardPreviewCache(directory: string) {
  const stats = { hits: 0, misses: 0, unavailable: 0 };
  return { stats, render: async (bytes: Buffer) => {
    const key = hash(hash(bytes) + recipe), file = join(directory, `${key}.json`);
    try {
      const record = JSON.parse(await readFile(file, "utf8"));
      const preview = Buffer.from(record.base64, "base64");
      if (record.key === key && record.sha256 === hash(preview) && preview.length > 0) { stats.hits++; return preview; }
    } catch { /* Missing or damaged cache cannot block independent preparation. */ }
    stats.misses++;
    const preview = await renderCardPreview(bytes);
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(file, JSON.stringify({ key, sha256: hash(preview), base64: preview.toString("base64") }));
    } catch { stats.unavailable++; /* Use freshly rendered output if cache storage fails. */ }
    return preview;
  } };
}
