import crypto from "crypto";
import type { CardIdentity } from "@/lib/comp-validation/types";

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
    "refractor",
    "prizm",
    "chrome",
    "xfractor",
    "gold",
    "silver",
    "red",
    "blue",
    "green",
    "black",
    "purple",
    "orange",
    "mojo",
    "wave",
    "cracked ice",
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

function inferSetName(title: string): string | null {
  const normalized = normalizeText(title);
  if (!normalized) return null;
  const tokens = normalized.split(" ");
  if (tokens.length < 4) return normalized;
  return tokens.slice(0, 6).join(" ");
}

function inferPlayer(title: string): string | null {
  const normalized = normalizeText(title);
  if (!normalized) return null;
  const tokens = normalized.split(" ");
  if (tokens.length < 2) return normalized;
  return `${tokens[0]} ${tokens[1]}`;
}

export function parseCardIdentity(title: string): CardIdentity {
  const normalizedTitle = normalizeText(title) ?? "";
  const rookie = /\brookie\b|\brc\b/i.test(title);
  const autograph = /\bauto(graph)?\b/i.test(title);
  const patch = /\bpatch\b|\bjersey\b/i.test(title);
  const serialNumbered = /\b\d+\s*\/\s*\d+\b/.test(title);
  const gradeCompany = extractGradeCompany(title);
  const gradeValue = extractGradeValue(title);
  const rawOrGraded = gradeCompany ? "graded" : "raw";
  const year = extractYear(title);
  const manufacturer = extractManufacturer(title);
  const setName = inferSetName(title);
  const cardNumber = extractCardNumber(title);
  const parallel = extractParallel(title);
  const variation = serialNumbered ? "serial-numbered" : null;
  const player = inferPlayer(title);

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
    gradeCompany,
    gradeValue,
    rawOrGraded,
    identityHash,
    baseCardKey,
  };
}
