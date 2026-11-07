/** Preparation is concurrent; draft ownership and external writes remain single-writer. */
export const V2_PREPARATION_LIMITS = Object.freeze({ identification: 3, groups: 3, photoUploads: 3, photoStartIntervalMs: 110 });

export async function mapV2Bounded<T>(items: readonly T[], limit: number, action: (item: T, index: number) => Promise<void>) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 3) throw Error('Invalid preparation concurrency');
  let next = 0, failure: unknown, failed = false;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!failed) {
      const index = next++;
      if (index >= items.length) return;
      try { await action(items[index], index); }
      catch (error) { if (!failed) failure = error; failed = true; }
    }
  }));
  // All started work has settled before the caller can release its durable worker lease.
  if (failed) throw failure;
}

export function v2Limiter(limit: number) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 3) throw Error('Invalid preparation concurrency');
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(action: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>(resolve => waiting.push(resolve));
    else active++;
    try { return await action(); }
    finally { const next = waiting.shift(); if (next) next(); else active--; }
  };
}

/** Space request starts as well as bounding in-flight work. This worker stays below 50 POSTs/5s. */
export function v2PhotoPacer() {
  let next = 0;
  return async () => {
    const ticket = Math.max(Date.now(), next); next = ticket + V2_PREPARATION_LIMITS.photoStartIntervalMs;
    const wait = ticket - Date.now();
    if (wait > 0) await new Promise<void>(resolve => setTimeout(resolve, wait));
  };
}
