import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

// These are reviewed upper bounds, not the advisory price table. Include image,
// reasoning, long-context and cache charges in the bounds; no tools are enabled.
const boundSchema = z.object({
  provider: z.enum(["openai", "anthropic", "xai", "google", "meta"]), model: z.string().min(1),
  inputTokens: z.number().int().positive(), outputTokens: z.number().int().positive(),
  maxRequestBytes: z.number().int().positive(),
  inputUsdPerMillion: z.number().positive(), outputUsdPerMillion: z.number().positive(),
  source: z.string().url(), justification: z.string().min(40),
  expiresAt: z.string().datetime(), allBillableTokensBounded: z.literal(true),
});
export type BenchmarkBound = z.infer<typeof boundSchema>;
export function validateBenchmarkBound(raw: unknown, provider: string, model: string, outputLimit: number) {
  const bound = boundSchema.parse(raw);
  if (bound.provider !== provider || bound.model !== model || Date.parse(bound.expiresAt) <= Date.now() || bound.outputTokens < outputLimit)
    throw Error("Missing, expired or mismatched verified cost bound.");
  return bound;
}
const entrySchema = z.object({
  phase: z.enum(["initial", "retest"]).optional(),
  id: z.number().int().positive(), provider: z.string(), model: z.string(),
  reservedMicros: z.number().int().positive(), bound: boundSchema,
  settled: z.boolean(), actualMicros: z.number().int().nonnegative().nullable(),
});
const ledgerSchema = z.object({ version: z.literal(1), capMicros: z.literal(5_000_000),
  priorMicros: z.number().int().nonnegative(), stopped: z.boolean(), entries: z.array(entrySchema) });
type Ledger = z.infer<typeof ledgerSchema>;

export function singleRequestFetch(implementation: typeof fetch = fetch, maxRequestBytes = Number.MAX_SAFE_INTEGER): typeof fetch {
  let sent = false;
  return (input, init) => {
    if (sent) throw Error("Additional provider HTTP request blocked; no automatic retries or continuations.");
    if (typeof init?.body !== "string" || Buffer.byteLength(init.body, "utf8") > maxRequestBytes)
      throw Error("Request is outside the reviewed billing bound; no call sent.");
    sent = true;
    return implementation(input, { ...init, redirect: "error" });
  };
}

/** Single-host append-only journal. Reservations are never refunded, including on
 * failure. Missing usage/crash/uncertain billing stops the whole session. */
export class BenchmarkBudget {
  private ledger: Ledger;
  private fd: number;
  private lock: string;
  private phase: "initial" | "retest";
  constructor(file: string, priorUsd?: number, phase: "initial" | "retest" = "initial") {
    if (phase !== "initial" && phase !== "retest") throw Error("Unknown benchmark spending phase.");
    this.phase = phase;
    mkdirSync(dirname(file), { recursive: true });
    this.lock = `${file}.lock`;
    closeSync(openSync(this.lock, "wx"));
    try {
      if (existsSync(file)) {
        const lines = readFileSync(file, "utf8").trim().split("\n");
        // Validate every record; a partial write is a hard stop, never a reset.
        const records = lines.map(line => ledgerSchema.parse(JSON.parse(line)));
        for (let i = 0; i < records.length; i++) {
          const row = records[i], previous = records[i - 1];
          if (row.entries.some((entry, index) => entry.id !== index + 1)
            || row.priorMicros + row.entries.reduce((sum, entry) => sum + entry.reservedMicros, 0) > 5_000_000
            || (previous && (row.priorMicros !== previous.priorMicros || row.entries.length < previous.entries.length
              || (previous.stopped && !row.stopped)
              || previous.entries.some((entry, index) => row.entries[index]?.reservedMicros !== entry.reservedMicros
                || row.entries[index]?.phase !== entry.phase))))
            throw Error("Budget journal integrity failed; stop for reconciliation.");
        }
        this.ledger = records[records.length - 1];
      } else {
        if (priorUsd === undefined || !Number.isFinite(priorUsd) || priorUsd < 0 || priorUsd > 5)
          throw Error("New budget requires reconciled prior spending between $0 and $5.");
        this.ledger = { version: 1, capMicros: 5_000_000, priorMicros: Math.ceil(priorUsd * 1e6), stopped: false, entries: [] };
      }
      this.fd = openSync(file, "a");
      this.persist();
    } catch (error) { unlinkSync(this.lock); throw error; }
  }
  private persist() { writeSync(this.fd, `${JSON.stringify(this.ledger)}\n`); fsyncSync(this.fd); }
  snapshot() {
    const reservedMicros = this.ledger.entries.reduce((sum, e) => sum + e.reservedMicros, this.ledger.priorMicros);
    // Unattributed historical spend is charged conservatively to either phase.
    // These fixed limits cannot be reset with output paths, restarts or phase flags.
    const phaseMicros = this.ledger.entries.filter(e => !e.phase || e.phase === this.phase)
      .reduce((sum, e) => sum + e.reservedMicros, this.ledger.priorMicros);
    return { capUsd: 5, authorizedCapUsd: 2, protectedReserveUsd: 3, phase: this.phase, phaseCapUsd: 1,
      phaseReservedUsd: phaseMicros / 1e6, reservedUsd: reservedMicros / 1e6,
      remainingUsd: Math.max(0, Math.min(5_000_000 - reservedMicros, 2_000_000 - reservedMicros, 1_000_000 - phaseMicros)) / 1e6,
      measuredUsd: this.ledger.entries.reduce((sum, e) => sum + (e.actualMicros ?? 0), 0) / 1e6,
      stopped: this.ledger.stopped || this.ledger.entries.some(e => !e.settled), billingGuarantee: false };
  }
  assertPlanAffordable(calls: Array<{ bound: BenchmarkBound; provider: string; model: string; outputLimit: number }>) {
    if (this.snapshot().stopped) throw Error("Budget stopped: unresolved call or billing uncertainty.");
    let totalMicros = 0;
    for (const call of calls) {
      const bound = validateBenchmarkBound(call.bound, call.provider, call.model, call.outputLimit);
      const micros = Math.ceil(bound.inputTokens * bound.inputUsdPerMillion + bound.outputTokens * bound.outputUsdPerMillion);
      if (!Number.isSafeInteger(micros) || micros <= 0) throw Error("Invalid planned reservation.");
      totalMicros += micros;
      if (!Number.isSafeInteger(totalMicros)) throw Error("Invalid planned total.");
    }
    if (totalMicros > Math.floor(this.snapshot().remainingUsd * 1e6))
      throw Error("Entire benchmark plan exceeds the authorized phase budget; no calls sent. Select a smaller balanced comparison.");
    return { calls: calls.length, maximumUsd: totalMicros / 1e6 };
  }
  reserve(raw: BenchmarkBound, provider: string, model: string, outputLimit: number) {
    if (this.snapshot().stopped) throw Error("Budget stopped: unresolved call or billing uncertainty.");
    const bound = validateBenchmarkBound(raw, provider, model, outputLimit);
    const reservedMicros = Math.ceil(bound.inputTokens * bound.inputUsdPerMillion + bound.outputTokens * bound.outputUsdPerMillion);
    if (!Number.isSafeInteger(reservedMicros) || reservedMicros <= 0 || reservedMicros > Math.floor(this.snapshot().remainingUsd * 1e6))
      throw Error("Authorized budget ($1 per phase, $2 combined; $3 protected reserve) cannot cover the next reservation.");
    const id = this.ledger.entries.length + 1;
    this.ledger.entries.push({ id, provider, model, phase: this.phase, reservedMicros, bound, settled: false, actualMicros: null });
    this.persist(); // durable BEFORE invoking the provider
    return id;
  }
  settle(id: number, usage: { inputTokens?: number | null; outputTokens?: number | null; totalTokens?: number | null } | null) {
    const entry = this.ledger.entries.find(e => e.id === id);
    if (!entry || entry.settled) throw Error("Invalid reservation settlement.");
    const input = usage?.inputTokens, output = usage?.outputTokens;
    if (!Number.isSafeInteger(input) || !Number.isSafeInteger(output) || input! < 0 || output! < 0 || input! > entry.bound.inputTokens || output! > entry.bound.outputTokens
      || (usage?.totalTokens != null && usage.totalTokens !== input! + output!)) {
      this.ledger.stopped = true; this.persist(); throw Error("Budget stopped: missing, invalid or out-of-bound usage.");
    }
    entry.actualMicros = Math.ceil(input! * entry.bound.inputUsdPerMillion + output! * entry.bound.outputUsdPerMillion);
    entry.settled = true; this.persist();
    return entry.actualMicros / 1e6;
  }
  stop() { this.ledger.stopped = true; this.persist(); }
  close() { closeSync(this.fd); unlinkSync(this.lock); }
}
