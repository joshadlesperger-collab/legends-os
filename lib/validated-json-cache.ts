import { readFile } from "node:fs/promises";

/** One-file cache: compare actual content, never trust timestamps or cache errors.
 * Results are deeply frozen so callers cannot contaminate subsequent requests. */
function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export function validatedJsonReader<T>(file: string, validate: (raw: unknown) => T) {
  let previousText: string | undefined;
  let previousValue: T;
  return async (): Promise<T> => {
    const text = await readFile(file, "utf8");
    if (text !== previousText) {
      const next = validate(JSON.parse(text));
      previousValue = freeze(next);
      previousText = text;
    }
    return previousValue;
  };
}
