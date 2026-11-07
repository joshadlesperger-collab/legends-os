import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { validateCatalog } from "../lib/card-knowledge.ts";
import { reviewCompsApiPilot } from "../lib/compsapi-pilot.ts";

async function main() {
  const args = process.argv.slice(2);
  const size = args.find(arg => arg.startsWith("--size="))?.slice(7) ?? "25";
  if (!["25", "240"].includes(size)) throw Error("Only the authorized pilot sizes are supported");
  const request = { q: "2025 topps chrome basketball", size, page: "1", days: "30", site: "US", best_offer: "1", cards: "1" };
  const root = "artifacts/knowledge-graph";
  const dir = `${root}/${size === "25" ? "compsapi-pilot" : "compsapi-batch-240"}`;
  await mkdir(dir, { recursive: true });
  if (!args.includes("--fetch") && !args.includes("--reanalyze")) {
    await writeFile(`${dir}/request-plan.json`, JSON.stringify({ endpoint: "https://api.compsapi.com/v1/sold", request,
      maxSoldRequests: 1, automaticRetries: 0, requiresFreeAccount: true, databaseWrites: false }, null, 2));
    console.log(JSON.stringify({ status: "prepared-awaiting-free-account", requestedListings: Number(size), maxSoldRequests: 1 }));
    return;
  }
  const entries = await readdir(dir);
  const hasReceipt = entries.includes("fetch-receipt.json");
  if (args.includes("--fetch") && (hasReceipt || entries.includes("report.json"))) throw Error("Batch already fetched; use --reanalyze without another API request");
  let body: string, rawPath: string, digest: string, fetchSeconds: number, fetchedAt: string;
  if (args.includes("--reanalyze")) {
    const receipt = JSON.parse(await readFile(`${dir}/${hasReceipt ? "fetch-receipt.json" : "report.json"}`, "utf8"));
    ({ rawPath, digest, fetchSeconds, fetchedAt } = receipt);
    body = await readFile(rawPath, "utf8");
    if (createHash("sha256").update(body).digest("hex") !== digest) throw Error("Response hash mismatch");
  } else {
  if (!args.includes("--confirmed-free-tier")) throw Error("Free plan must be confirmed in the provider console");
  // Dedicated git-ignored key file contains only the key; never include it in output.
  const key = process.env.COMPSAPI_API_KEY?.trim() || (await readFile(".env.compsapi-key", "utf8")).trim();
  if (!key || /\s/.test(key)) throw Error("Missing or invalid key");
  const get = async (url: URL) => {
    const res = await fetch(url, { headers: { "X-API-Key": key, "User-Agent": "LegendsOS-small-pilot/1.0" },
      signal: AbortSignal.timeout(60000), redirect: "error" });
    if (!res.ok) throw Error(`CompsAPI HTTP ${res.status}`);
    const body = await res.text();
    if (body.includes(key)) throw Error("Unexpected credential in response");
    return body;
  };
  const usage = JSON.parse(await get(new URL("https://api.compsapi.com/v1/usage")));
  if (usage.ok === false) throw Error("Usage check failed");
  const url = new URL("https://api.compsapi.com/v1/sold");
  url.search = new URLSearchParams(request).toString();
  const started = performance.now();
  body = await get(url);
  fetchSeconds = Number(((performance.now() - started) / 1000).toFixed(3));
  digest = createHash("sha256").update(body).digest("hex");
  rawPath = `${dir}/response-${digest}.json`;
  fetchedAt = new Date().toISOString();
  await writeFile(rawPath, body);
  await writeFile(`${dir}/fetch-receipt.json`, JSON.stringify({ rawPath, digest, fetchSeconds, fetchedAt, request }, null, 2));
  }
  const catalog = validateCatalog(JSON.parse(await readFile("data/card-catalog/topps-chrome-basketball-2025-26.json", "utf8")));
  const saved = JSON.parse(await readFile("artifacts/knowledge-graph/saved-pages-index.json", "utf8")) as { rows: { observationKey: string }[] };
  const savedIds = new Set(saved.rows.map(row => row.observationKey.replace(/^ebay:/, "")));
  const priorApiIds = new Set<string>();
  const priorReports: string[] = [];
  for (const name of (await readdir(root)).filter(name => name.startsWith("compsapi-"))) {
    if (`${root}/${name}` === dir) continue;
    let previous: {rows: {item_id: string}[]};
    try { previous = JSON.parse(await readFile(`${root}/${name}/report.json`, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    priorReports.push(`${root}/${name}/report.json`);
    previous.rows.forEach(row => priorApiIds.add(row.item_id));
  }
  const knownIds = new Set(Array.from(savedIds).concat(Array.from(priorApiIds)));
  const report = reviewCompsApiPilot(JSON.parse(body), catalog, savedIds, priorApiIds);
  const result = { ...report, summary: { ...report.summary, existingUniqueListings: knownIds.size,
      combinedUniqueListings: knownIds.size + report.summary.newListings }, priorReports,
    request, rawPath, digest, fetchedAt, fetchSeconds,
    source: "CompsAPI; not an official eBay feed", termsUrl: "https://compsapi.com/terms" };
  await writeFile(`${dir}/report.json`, JSON.stringify(result, null, 2));
  await writeFile(`${dir}/new-listings.json`, JSON.stringify(report.rows.filter(row => !row.overlapsExisting), null, 2));
  await writeFile(`${dir}/existing-listings.json`, JSON.stringify(report.rows.filter(row => row.overlapsExisting), null, 2));
  console.log(JSON.stringify({ ...result.summary, fetchSeconds, reportPath: `${dir}/report.json` }, null, 2));
}
main().catch(() => { console.error("CompsAPI pilot stopped. Check free-account access, API availability, and response format. No credentials logged, no automatic retries, no database writes."); process.exitCode = 1; });
