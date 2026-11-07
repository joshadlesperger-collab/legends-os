import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { BacklogCard } from "./card-backlog.ts";

/** Resolve only known capture paths inside the inbox and verify the original bytes before serving. */
export async function readCardPhoto(card: BacklogCard, side: "front" | "back", inbox: string) {
  const expected = side === "front" ? card.frontHash : card.backHashes.length === 1 ? card.backHashes[0] : null;
  if (!expected) return null;
  const root = await fs.realpath(inbox);
  for (const candidate of Array.from(new Set([...card.inboxPaths,...card.originalPaths]))) {
    try {
      const resolved = await fs.realpath(candidate), relative = path.relative(root,resolved);
      if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) continue;
      const extension = path.extname(resolved).toLowerCase();
      const mime = ({".jpg":"image/jpeg",".jpeg":"image/jpeg",".png":"image/png",".webp":"image/webp",".bmp":"image/bmp"} as Record<string,string>)[extension];
      if (!mime || (await fs.stat(resolved)).size > 100*1024*1024) continue;
      const bytes = await fs.readFile(resolved);
      if (createHash("sha256").update(bytes).digest("hex") !== expected) continue;
      return {bytes,mime};
    } catch { /* An archived/missing path may have another retained location. */ }
  }
  return null;
}
