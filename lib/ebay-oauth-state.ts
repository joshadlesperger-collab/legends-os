import crypto from "crypto";

export type EbayOAuthIntent = "connect" | "reauthorize_orders";

type StatePayload = {
  v: 1;
  storeId: string;
  intent: EbayOAuthIntent;
  nonce: string;
  expiresAt: number;
};

const STATE_TTL_MS = 10 * 60 * 1000;
const STATE_AUDIENCE = "legends-os-ebay-oauth-v1";

function stateKey() {
  const value = process.env.TOKEN_ENCRYPTION_KEY;
  if (!value || !/^[0-9a-f]{64}$/i.test(value)) {
    throw new Error("TOKEN_ENCRYPTION_KEY must be a 64-character hex string (32 bytes)");
  }
  return Buffer.from(value, "hex");
}

function verifier(nonce: string) {
  return crypto.createHash("sha256").update(`${STATE_AUDIENCE}:${nonce}`, "utf8").digest("hex");
}

export function pendingOAuthState(value: string) {
  return `pending:${value}`;
}

export function processingOAuthState(value: string) {
  return `processing:${value}`;
}

export function issueEbayOAuthState(storeId: string, intent: EbayOAuthIntent, now = Date.now()) {
  const payload: StatePayload = {
    v: 1,
    storeId,
    intent,
    nonce: crypto.randomBytes(24).toString("base64url"),
    expiresAt: now + STATE_TTL_MS,
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = crypto.createHmac("sha256", stateKey()).update(encoded, "utf8").digest("base64url");
  const stateVerifier = verifier(payload.nonce);
  return { state: `${encoded}.${signature}`, verifier: stateVerifier, storedState: pendingOAuthState(stateVerifier) };
}

export function verifyEbayOAuthState(state: string, now = Date.now()) {
  const [encoded, suppliedSignature, extra] = state.split(".");
  if (!encoded || !suppliedSignature || extra) return null;
  const expectedSignature = crypto.createHmac("sha256", stateKey()).update(encoded, "utf8").digest();
  let actualSignature: Buffer;
  try { actualSignature = Buffer.from(suppliedSignature, "base64url"); } catch { return null; }
  if (actualSignature.length !== expectedSignature.length || !crypto.timingSafeEqual(actualSignature, expectedSignature)) return null;

  let payload: StatePayload;
  try { payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as StatePayload; } catch { return null; }
  if (payload.v !== 1 || !payload.storeId || !payload.nonce || !["connect", "reauthorize_orders"].includes(payload.intent)) return null;
  if (!Number.isFinite(payload.expiresAt) || payload.expiresAt <= now || payload.expiresAt > now + STATE_TTL_MS) return null;
  return { storeId: payload.storeId, intent: payload.intent, verifier: verifier(payload.nonce) };
}

export function getOAuthReplayOutcome(storedState: string | null, stateVerifier: string, intent: EbayOAuthIntent, connectionStatus: string, orderAccessStatus: string) {
  if (storedState === processingOAuthState(stateVerifier)) return "processing" as const;
  if (storedState === null && intent === "reauthorize_orders" && orderAccessStatus === "ready") return "completed" as const;
  if (storedState === null && intent === "connect" && connectionStatus === "connected") return "completed" as const;
  return "invalid" as const;
}
