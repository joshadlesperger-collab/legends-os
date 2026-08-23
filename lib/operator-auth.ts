export const OPERATOR_SESSION_COOKIE = "legends_operator";
export const OPERATOR_SESSION_SECONDS = 60 * 60 * 12;

const encoder = new TextEncoder();

function hex(bytes: ArrayBuffer) {
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}

function equal(a: string, b: string) {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index++) difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return difference === 0;
}

async function signature(value: string, secret: string) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

export function operatorAuthConfigured() {
  return Boolean(process.env.OPERATOR_PASSWORD && process.env.OPERATOR_SESSION_SECRET);
}

export async function verifyOperatorPassword(candidate: string) {
  const expected = process.env.OPERATOR_PASSWORD;
  if (!expected) return false;
  return equal(await signature(candidate, expected), await signature(expected, expected));
}

export async function createOperatorSession(now = new Date()) {
  const secret = process.env.OPERATOR_SESSION_SECRET;
  if (!secret) throw new Error("Operator authentication is not configured");
  const operatorId = process.env.OPERATOR_ID || "owner";
  const expires = Math.floor(now.getTime() / 1000) + OPERATOR_SESSION_SECONDS;
  const value = `${encodeURIComponent(operatorId)}.${expires}`;
  return `${value}.${await signature(value, secret)}`;
}

export async function readOperatorSession(token: string | undefined, now = new Date()) {
  const secret = process.env.OPERATOR_SESSION_SECRET;
  if (!secret || !token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [encodedId, expiration, supplied] = parts;
  const expires = Number(expiration);
  if (!Number.isSafeInteger(expires) || expires <= Math.floor(now.getTime() / 1000)) return null;
  const value = `${encodedId}.${expiration}`;
  if (!equal(supplied, await signature(value, secret))) return null;
  try { return { operatorId: decodeURIComponent(encodedId), expiresAt: new Date(expires * 1000) }; } catch { return null; }
}
