import {isV2Heic} from '@/lib/card-processing-v2-image-decode';
import {v2OrientedImage} from '@/lib/card-processing-v2-photo-rotation';
import fs from "node:fs/promises";
import {assertV2PreviewBoundary} from "@/lib/card-processing-v2-photo-boundary";
import path from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { NextRequest, NextResponse } from "next/server";
import { OPERATOR_SESSION_COOKIE, readOperatorSession } from "@/lib/operator-auth";
import { readV2Config, readV2State } from "@/lib/card-processing-v2-store";
import { resolveV2ArchivedPhoto } from "@/lib/card-processing-v2-draft-archive";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
const equivalent = (a: string, b: string) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;

/** Only server-owned card/side bindings are accepted. Paths never come from the request.
 * A preview is derived after exact original hashing; neither original nor queue is written. */
export async function GET(req: NextRequest) {
  if (!await readOperatorSession(req.cookies.get(OPERATOR_SESSION_COOKIE)?.value)) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401, headers });
  }
  const params = req.nextUrl.searchParams;
  const cardId = params.get("card") ?? "", side = params.get("side");
  if (!/^V2-[a-f0-9]{24}$/.test(cardId) || !["front", "back"].includes(side ?? "")
    || params.size !== 2 || Array.from(params.keys()).some(key => !["card", "side"].includes(key))) {
    return NextResponse.json({ error: "Choose a card photo from the processing queue." }, { status: 400, headers });
  }
  try {
    const [state, config] = await Promise.all([readV2State(), readV2Config()]);
    const photo = state.cards[cardId]?.photos.find(item => item.side === side);
    if (!photo) throw Error("Missing frozen original");
    const card=state.cards[cardId], folder = path.resolve(config.folder), filename = path.resolve(await resolveV2ArchivedPhoto(process.cwd(),card,photo));
    // V2 intake accepts loose top-level originals only. Reject changed roots, links and subfolders.
    assertV2PreviewBoundary(folder,filename,card,photo);
    const [folderReal, fileReal, stat] = await Promise.all([fs.realpath(folder), fs.realpath(filename), fs.lstat(filename)]);
    if (!equivalent(folderReal, folder) || !equivalent(fileReal, filename) || stat.isSymbolicLink() || !stat.isFile() || stat.size > 35_000_000) throw Error("Original unavailable");
    const handle = await fs.open(filename, "r");
    let bytes: Buffer;
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size > 35_000_000 || opened.size !== stat.size) throw Error("Original changed");
      bytes = await handle.readFile();
    } finally { await handle.close(); }
    const [after, afterReal] = await Promise.all([fs.lstat(filename), fs.realpath(filename)]);
    if (!after.isFile() || after.isSymbolicLink() || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || !equivalent(afterReal, filename)) throw Error("Original changed while reading");
    if (createHash("sha256").update(bytes).digest("hex") !== photo.hash) throw Error("Original hash changed");
    const supported = (bytes[0] === 255 && bytes[1] === 216)
      || bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      || (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP");
    if (!supported && !isV2Heic(bytes)) throw Error("Preview requires a JPEG, PNG or WebP original");
    const preview = await sharp(await v2OrientedImage(bytes), { limitInputPixels: 80_000_000 }).rotate()
      .resize({ width: 400, height: 500, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
    return new NextResponse(new Uint8Array(preview), { headers: { ...headers, "Content-Type": "image/jpeg", "Content-Security-Policy": "default-src 'none'; sandbox" } });
  } catch {
    return NextResponse.json({ error: "This original is unavailable or changed. Its processing checkpoint is preserved." }, { status: 404, headers });
  }
}

