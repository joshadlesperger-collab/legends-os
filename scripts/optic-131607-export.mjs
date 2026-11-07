import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { prisma } from "../lib/prisma.ts";
import { getValidAccessToken, setStoredToken } from "../lib/ebay.ts";
import { uploadCardImage } from "../lib/ebay-card-media.ts";

const rows = [
  ["Luka Dončić", "Playmakers", "4", "", 9.99],
  ["Julian Strawther", "Optic", "29", "12/18", 4.99],
  ["Zaccharie Risacher", "The Rookies", "1", "33/99", 4.99],
  ["Reed Sheppard", "The Rookies", "3", "", 3.99],
  ["Reed Sheppard", "Rated Rookie", "4", "", 3.99],
  ["Larry Bird", "Legends", "243", "34/49", 5.99],
  ["Tyler Kolek", "Rated Rookie", "257", "", 2.98],
  ["Taurean Prince", "Optic", "5", "56/99", 2.98],
  ["Taurean Prince", "Optic", "5", "31/49", 2.98],
  ["Marvin Bagley III", "Optic", "43", "23/49", 2.98],
  ["Karl Malone", "Legends", "229", "64/99", 3.99],
  ["Moritz Wagner", "Optic", "66", "53/99", 2.98],
  ["Nikola Topić", "Rated Rookie", "278", "50/175", 4.99],
];
const quote = (v) => `"${String(v).replaceAll('"', '""')}"`;
const store = await prisma.store.findFirst({ where: { ebaySellerUsername: "imaydit58" } });
if (!store) throw new Error("Connected seller store not found");
const tokenBundle = await getValidAccessToken(store, { forceRefresh: true });
await prisma.store.update({ where: { id: store.id }, data: { oauthAccessToken: setStoredToken(tokenBundle.accessToken), oauthRefreshToken: setStoredToken(tokenBundle.refreshToken), tokenExpiresAt: tokenBundle.expiresAt } });
const token = tokenBundle.accessToken;
const hosted = [];
for (let i = 1; i <= 13; i++) {
  for (const side of ["B", "F"]) {
    const file = `C:\\CardScans\\Card${String(i).padStart(4, "0")}${side}131607.jpg`;
    const bytes = await fs.readFile(file);
    const originalHash = createHash("sha256").update(bytes).digest("hex");
    const result = await uploadCardImage(token, bytes, "image/jpeg");
    hosted.push({ originalHash, ...result, uprightReviewed: true });
  }
}
const dir = "artifacts/card-batches";
await fs.mkdir(dir, { recursive: true });
await fs.writeFile(`${dir}/optic-131607-hosted.json`, JSON.stringify(hosted, null, 2));
const headers = ["Action(SiteID=US|Country=US|Currency=USD|Version=1193|CC=UTF-8)", "Custom label (SKU)", "Category ID", "Title", "UPC", "Price", "Quantity", "Item photo URL", "Condition ID", "Description", "Format"];
const lines = ["#INFO,Version=0.0.2,Template= eBay-draft-listings-template_US,,,,,,,,", headers.map(quote).join(",")];
for (let i = 0; i < rows.length; i++) {
  const [player, insert, number, serial, price] = rows[i];
  const sku = `OPTIC-131607-${String(i + 1).padStart(2, "0")}`;
  const title = `2024-25 Panini Donruss Optic ${player} ${insert} #${number}${serial ? ` ${serial}` : ""}`;
  const photos = hosted.slice(i * 2, i * 2 + 2).map((p) => p.url).join("|");
  lines.push(["Draft", sku, "261328", title, "", price.toFixed(2), "1", photos, "4000", "2024-25 Panini Donruss Optic Basketball card. Review photos for the exact parallel, serial numbering, and condition.", "FixedPrice"].map(quote).join(","));
}
await fs.writeFile(`${dir}/optic-131607-ebay-draft.csv`, `${lines.join("\r\n")}\r\n`);
console.log(JSON.stringify({ hosted: hosted.length, csv: `${dir}/optic-131607-ebay-draft.csv` }));
