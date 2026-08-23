import crypto from "crypto";
import type { CardIdentity } from "./types.ts";

const GRADE_COMPANIES = ["PSA", "BGS", "SGC", "CGC"] as const;

function normalizeText(value: string | null): string | null {
  if (!value) return null;
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9\s#/-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized || null;
}

function extractYear(title: string): number | null {
  const match = title.match(/\b(19\d{2}|20\d{2})\b/);
  return match ? Number(match[1]) : null;
}

function extractGradeCompany(title: string): string | null {
  const upper = title.toUpperCase();
  for (const company of GRADE_COMPANIES) {
    if (upper.includes(company)) return company;
  }
  return null;
}

function extractGradeValue(title: string): number | null {
  const match = title.match(/\b(?:PSA|BGS|SGC|CGC)\s*(\d{1,2}(?:\.5)?)\b/i);
  if (!match) return null;
  const grade = Number(match[1]);
  return Number.isFinite(grade) ? grade : null;
}

function extractCardNumber(title: string): string | null {
  const hashMatch = title.match(/#\s*([a-z0-9-]+)/i);
  if (hashMatch) return hashMatch[1].toLowerCase();
  const noMatch = title.match(/\bno\.?\s*([a-z0-9-]+)\b/i);
  if (noMatch) return noMatch[1].toLowerCase();
  return null;
}

function extractParallel(title: string): string | null {
  const candidates = [
    "protonyx bronze surge",
    "magenta surge",
    "red white blue",
    "cracked ice",
    "rainbow foil",
    "red aqua vapor wave",
    "gold geometric refractor",
    "aqua refractor",
    "crimson surge",
    "gold raywave",
    "blue ice",
    "cosmic prizm",
    "pandora",
    "snakeskin",
    "kaleidoscopic",
    "xfractor",
    "sapphire",
    "sparkle",
    "shimmer",
    "sepia",
    "mojo",
    "wave",
    "gold",
    "silver",
    "red",
    "blue",
    "green",
    "black",
    "purple",
    "orange",
    "refractor",
    "prizm",
    "chrome",
  ];
  const normalized = title.toLowerCase();
  const found = candidates.find((parallel) => normalized.includes(parallel));
  return found ?? null;
}

function extractManufacturer(title: string): string | null {
  const candidates = [
    "topps",
    "panini",
    "upper deck",
    "bowman",
    "donruss",
    "fleer",
    "leaf",
    "score",
  ];
  const normalized = title.toLowerCase();
  const found = candidates.find((name) => normalized.includes(name));
  return found ?? null;
}

const PRODUCTS = ["topps 50/50","topps shoebox treasures","topps chrome gilded collection","topps gilded collection","topps chrome update series","topps resurgence","topps chrome","bowman chrome","donruss optic","panini prizm","topps archives","topps finest","topps heritage","topps update","topps series 1","topps series 2","national treasures","immaculate collection","select","mosaic","chronicles","stadium club","allen ginter"];
function inferSetName(title: string): string | null {const lower=title.toLowerCase();return PRODUCTS.find(product=>lower.includes(product))??null;}
function inferProductVariation(title:string,setName:string|null):string|null{
  if(setName==="topps 50/50"){
    const event=title.match(/\b(hr|home\s*run|sb|stolen\s*base)\s*#?\s*([0-9]+)\b/i);
    if(!event)return "topps-50-50:unknown-event";
    const kind=/^(hr|home)/i.test(event[1])?"hr":"sb";
    return `topps-50-50:${kind}:${Number(event[2])}`;
  }
  const subsets=["image variation","activators","moment in time","conductors","voltaic","select certified","phenomenon","dominators","plasma power","field level","club level","premier level","concourse"];
  const subset=subsets.find(value=>title.toLowerCase().includes(value));
  if(subset)return `subset:${subset}`;
  return null;
}
function inferPlayer(title:string,setName:string|null):string|null{
  let candidate=normalizeText(title)??"";
  candidate=candidate.replace(/\b(19\d{2}|20\d{2})\b/g," ").replace(/#\s*[a-z0-9-]+/gi," ").replace(/\b\d+\s*\/\s*\d+\b/g," ").replace(/\b(?:psa|bgs|sgc|cgc)\s*\d{1,2}(?:\.5)?\b/gi," ");
  for(const phrase of [...PRODUCTS,"topps","panini","upper deck","bowman","donruss","fleer","leaf","score","rookie","rc","auto","autograph","patch","jersey","refractor","prizm","chrome","xfractor","gold","silver","red","blue","green","black","purple","orange","mojo","wave","cracked ice","foil","sp","ssp","card","mint","gem","bookend"])candidate=candidate.replace(new RegExp(`\\b${phrase.replaceAll(" ","\\s+")}\\b`,"gi")," ");
  if(setName)candidate=candidate.replace(new RegExp(setName.replaceAll(" ","\\s+"),"gi")," ");
  const tokens=candidate.split(/\s+/).filter(token=>token.length>1&&!/^\d+$/.test(token));
  if(tokens.length<2)return null;return `${tokens[0]} ${tokens[1]}`;
}

export function parseCardIdentity(title: string): CardIdentity {
  const normalizedTitle = normalizeText(title) ?? "";
  const rookie = /\brookie\b|\brc\b/i.test(title);
  const autograph = /\bauto(graph)?\b/i.test(title);
  const patch = /\bpatch\b|\bjersey\b/i.test(title);
  const serialMatch=title.match(/(?<!#)\b(\d+)\s*\/\s*(\d+)\b/);const printOnlyMatch=serialMatch?null:title.match(/(?:^|\s)\/\s*(\d+)\b/);const serialNumbered=Boolean(serialMatch||printOnlyMatch);const serialNumber=serialMatch?Number(serialMatch[1]):null;const printRun=serialMatch?Number(serialMatch[2]):printOnlyMatch?Number(printOnlyMatch[1]):null;
  const gradeCompany = extractGradeCompany(title);
  const gradeValue = extractGradeValue(title);
  const rawOrGraded = gradeCompany ? "graded" : "raw";
  const year = extractYear(title);
  const manufacturer = extractManufacturer(title);
  const setName = inferSetName(title);
  const cardNumber = extractCardNumber(title);
  const parallel = extractParallel(title);
  const productVariation=inferProductVariation(title,setName);
  const variation = productVariation??(serialNumbered ? "serial-numbered" : /\bssp\b/i.test(title)?"ssp":/\bsp\b/i.test(title)?"sp":/\bcanvas\b/i.test(title)?"canvas":null);
  const player = inferPlayer(title,setName);
  const required={player,year,manufacturer,setName,cardNumber};const missingAttributes=Object.entries(required).filter(([,value])=>value==null).map(([key])=>key);const identityCompleteness=Math.round((Object.keys(required).length-missingAttributes.length)*100/Object.keys(required).length);

  const baseCardKey = [
    player,
    year ? String(year) : null,
    manufacturer,
    setName,
    cardNumber,
  ]
    .filter(Boolean)
    .join("|");

  const identityPayload = [
    baseCardKey,
    parallel,
    variation,
    rookie ? "rookie" : "non-rookie",
    autograph ? "auto" : "non-auto",
    patch ? "patch" : "non-patch",
    serialNumbered ? "serial" : "not-serial",
    rawOrGraded,
    gradeCompany,
    gradeValue != null ? String(gradeValue) : null,
  ]
    .filter((part) => part != null && part !== "")
    .join("|");

  const identityHash = crypto.createHash("sha1").update(identityPayload || normalizedTitle).digest("hex");

  return {
    player,
    year,
    manufacturer,
    setName,
    cardNumber,
    parallel,
    variation,
    rookie,
    autograph,
    patch,
    serialNumbered,
    serialNumber,
    printRun,
    gradeCompany,
    gradeValue,
    rawOrGraded,
    identityHash,
    baseCardKey,
    identityCompleteness,
    missingAttributes,
  };
}
