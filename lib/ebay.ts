import crypto from "crypto";
import { XMLParser } from "fast-xml-parser";

const ALGORITHM = "aes-256-cbc";
const MAX_TRADING_API_ATTEMPTS = 3;
const MAX_TRADING_API_PAGES = 500;
const EBAY_REQUEST_TIMEOUT_MS = 15_000;

const EBAY_OAUTH_SCOPES = [
  "https://api.ebay.com/oauth/api_scope",
  "https://api.ebay.com/oauth/api_scope/sell.inventory",
  "https://api.ebay.com/oauth/api_scope/sell.account",
  "https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly",
  "https://api.ebay.com/oauth/api_scope/sell.analytics.readonly",
  "https://api.ebay.com/oauth/api_scope/sell.marketing",
] as const;
export function getEbayOAuthScopes(){return [...EBAY_OAUTH_SCOPES]}

function getKey(): Buffer {
  const keyHex = process.env.TOKEN_ENCRYPTION_KEY;
  if (!keyHex || keyHex.length !== 64) {
    throw new Error("TOKEN_ENCRYPTION_KEY must be a 64-character hex string (32 bytes)");
  }
  return Buffer.from(keyHex, "hex");
}

export function encryptToken(text: string): { iv: string; encrypted: string } {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  return { iv: iv.toString("hex"), encrypted };
}

export function decryptToken(iv: string, encrypted: string): string {
  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), Buffer.from(iv, "hex"));
  let decrypted = decipher.update(encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

export function getEbayOAuthUrl(state: string): string {
  const base = "https://auth.ebay.com/oauth2/authorize";
  const params = new URLSearchParams({
    client_id: process.env.EBAY_CLIENT_ID ?? "",
    response_type: "code",
    redirect_uri: process.env.EBAY_REDIRECT_URI_NAME ?? "",
    scope: EBAY_OAUTH_SCOPES.join(" "),
    state,
  });
  return `${base}?${params.toString()}`;
}

export async function exchangeCodeForTokens(code: string) {
  const url = "https://api.ebay.com/identity/v1/oauth2/token";
  const auth = Buffer.from(`${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`).toString("base64");

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: process.env.EBAY_REDIRECT_URI_NAME ?? "",
  });

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${auth}`,
    },
    body: body.toString(),
  });

  if (!res.ok) {
    throw new Error(`eBay token exchange failed with HTTP ${res.status}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    refresh_token_expires_in: number;
    token_type: string;
  };

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: new Date(Date.now() + data.expires_in * 1000),
    refreshExpiresAt: new Date(Date.now() + data.refresh_token_expires_in * 1000),
  };
}

export async function refreshAccessToken(refreshToken: string) {
  const url = "https://api.ebay.com/identity/v1/oauth2/token";
  const auth = Buffer.from(`${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`).toString("base64");

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${auth}`,
    },
    body: body.toString(),
  });

  if (!res.ok) {
    throw new Error(`eBay token refresh failed with HTTP ${res.status}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    token_type: string;
  };

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? refreshToken,
    expiresAt: new Date(Date.now() + data.expires_in * 1000),
  };
}

export function getStoredToken(encrypted: string | null | undefined): string | null {
  if (!encrypted) return null;
  const [iv, cipherText] = encrypted.split(":");
  if (!iv || !cipherText) return null;
  return decryptToken(iv, cipherText);
}

export function setStoredToken(token: string): string {
  const { iv, encrypted } = encryptToken(token);
  return `${iv}:${encrypted}`;
}

type StoreWithTokens = {
  id: string;
  oauthAccessToken: string | null;
  oauthRefreshToken: string | null;
  tokenExpiresAt: Date | null;
};

export async function getValidAccessToken(store: StoreWithTokens,options:{forceRefresh?:boolean}={}) {
  const access = store.oauthAccessToken ? getStoredToken(store.oauthAccessToken) : null;
  const refresh = store.oauthRefreshToken ? getStoredToken(store.oauthRefreshToken) : null;

  if (!access) {
    throw new Error("Store has no access token");
  }

  const now = Date.now();
  const expired = Boolean(options.forceRefresh)||!store.tokenExpiresAt || store.tokenExpiresAt.getTime() < now + 60_000;

  if (!expired) {
    return {
      accessToken: access,
      refreshToken: refresh ?? "",
      expiresAt: store.tokenExpiresAt ?? new Date(Date.now() + 60 * 60 * 1000),
    };
  }

  if (!refresh) {
    throw new Error("Access token expired and no refresh token available");
  }

  const next = await refreshAccessToken(refresh);
  return {
    accessToken: next.accessToken,
    refreshToken: next.refreshToken,
    expiresAt: next.expiresAt,
  };
}

export class EbayApiError extends Error {
  callName: string;
  code?: string;

  constructor(callName: string, message: string, code?: string) {
    super(message);
    this.callName = callName;
    this.code = code;
    this.name = "EbayApiError";
  }
}

const HARD_AUTH_ERROR_CODES = new Set(["21917053", "932"]);

export function isHardEbayAuthenticationError(error: unknown) {
  if (error instanceof EbayApiError && error.code && HARD_AUTH_ERROR_CODES.has(error.code)) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /\b(?:21917053|932)\b/.test(message) || /IAF token supplied is expired/i.test(message) || /Auth token is hard expired/i.test(message);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isTransientEbayStatus(status: number) {
  return status === 429 || status === 408 || status >= 500;
}

export function isEbayQuotaError(error: unknown): boolean {
  return (
    (error instanceof EbayApiError && error.code === "429") ||
    (error instanceof Error && /HTTP 429|request limit has been reached/i.test(error.message))
  );
}

function retryDelayMs(response: Response | null, attempt: number) {
  const retryAfter = response?.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.min(10_000, Math.max(0, seconds * 1000));
  }
  const exponential = 250 * 2 ** (attempt - 1);
  return exponential + Math.floor(Math.random() * 150);
}

export function parseTotalPages(value: unknown, callName: string, currentPage: number) {
  const totalPages = Number(value ?? 1);
  if (!Number.isInteger(totalPages) || totalPages < 1) {
    throw new EbayApiError(callName, `${callName} returned malformed pagination`, "MALFORMED_PAGINATION");
  }
  if (totalPages > MAX_TRADING_API_PAGES) {
    throw new EbayApiError(callName, `${callName} exceeded the ${MAX_TRADING_API_PAGES}-page safety limit`, "PAGINATION_LIMIT");
  }
  if (currentPage > totalPages) {
    throw new EbayApiError(callName, `${callName} pagination moved backwards`, "MALFORMED_PAGINATION");
  }
  return totalPages;
}

type TradingResponse = Record<string, unknown>;

function getResponseRoot(parsed: TradingResponse): Record<string, unknown> | undefined {
  // fast-xml-parser may include the XML declaration as the first object (the "?xml" key).
  // Select the actual eBay response element instead of relying on object insertion order.
  const responseEntry = Object.entries(parsed).find(([key, value]) => {
    const localName = key.includes(":") ? key.split(":").pop() ?? key : key;
    return (
      localName.endsWith("Response") &&
      typeof value === "object" &&
      value !== null
    );
  });

  if (responseEntry) {
    return responseEntry[1] as Record<string, unknown>;
  }

  // Defensive fallback for an already-unwrapped response object.
  if ("Ack" in parsed || "Errors" in parsed) {
    return parsed;
  }

  return undefined;
}

function getAck(parsed: TradingResponse) {
  const response = getResponseRoot(parsed);
  const ack = response?.Ack as string | undefined;
  const rawErrors = response?.Errors;
  const errors = Array.isArray(rawErrors) ? rawErrors : rawErrors ? [rawErrors] : [];
  return { ack, errors, response };
}

function assertCompleteEnumeration(parsed: TradingResponse, callName: string) {
  const { ack, errors } = getAck(parsed);
  if (ack !== "PartialSuccess") return;
  const { message, code } = formatEbayErrors(errors);
  throw new EbayApiError(callName, `${callName} returned a partial result; checkpoint and reconciliation were not advanced: ${message}`, code ?? "PARTIAL_RESULT");
}

function valueAsString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const text = record["#text"];
    if (typeof text === "string" || typeof text === "number") return String(text);
  }
  return undefined;
}

function formatEbayErrors(errors: unknown[]): { message: string; code?: string } {
  const parts = errors.map((entry) => {
    const err = (entry ?? {}) as Record<string, unknown>;
    const code = valueAsString(err.ErrorCode) ?? valueAsString(err["@_code"]);
    const message =
      valueAsString(err.LongMessage) ??
      valueAsString(err.ShortMessage) ??
      valueAsString(err.SeverityCode) ??
      "eBay API error";
    return `${code ? `[${code}] ` : ""}${message}`;
  });

  const first = (errors[0] ?? {}) as Record<string, unknown>;
  return {
    message: parts.length ? parts.join("; ") : "eBay returned a failure response without error details",
    code: valueAsString(first.ErrorCode) ?? valueAsString(first["@_code"]),
  };
}

function sanitizeEbayResponse(text: string): string {
  return text
    .replace(/<eBayAuthToken>[\s\S]*?<\/eBayAuthToken>/gi, "<eBayAuthToken>[REDACTED]</eBayAuthToken>")
    .replace(/(<[^>]*(?:token|credential)[^>]*>)[\s\S]*?(<\/[^>]+>)/gi, "$1[REDACTED]$2")
    .slice(0, 2000)
    .replace(/[\r\n]+/g, " ");
}

export async function callTradingApi(options: {
  callName: string;
  siteId: number;
  accessToken: string;
  xmlBody: string;
  retryMode?: "safe-read" | "single-attempt";
}) {
  const { callName, siteId, accessToken, xmlBody, retryMode = "safe-read" } = options;
  const endpoint = "https://api.ebay.com/ws/api.dll";
  const body = `<?xml version="1.0" encoding="utf-8"?>\n${xmlBody.trim()}`;

  let res: Response | null = null;
  let lastNetworkError: unknown;
  const maxAttempts = retryMode === "single-attempt" ? 1 : MAX_TRADING_API_ATTEMPTS;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "text/xml; charset=utf-8",
          "X-EBAY-API-CALL-NAME": callName,
          "X-EBAY-API-COMPATIBILITY-LEVEL": "1227",
          "X-EBAY-API-SITEID": siteId.toString(),
          "X-EBAY-API-IAF-TOKEN": accessToken,
        },
        body,
        cache: "no-store",
        signal: AbortSignal.timeout(EBAY_REQUEST_TIMEOUT_MS),
      });
      if (!isTransientEbayStatus(res.status) || attempt === maxAttempts) break;
      await res.body?.cancel().catch(() => undefined);
      await sleep(retryDelayMs(res, attempt));
    } catch (error) {
      lastNetworkError = error;
      if (attempt === maxAttempts) break;
      await sleep(retryDelayMs(null, attempt));
    }
  }

  if (!res) {
    const message = lastNetworkError instanceof Error ? lastNetworkError.message : String(lastNetworkError ?? "unknown network error");
    throw new EbayApiError(callName, `${callName} network request failed after ${maxAttempts} attempt${maxAttempts === 1 ? "" : "s"}: ${message}`);
  }

  const text = await res.text();
  if (!res.ok) console.error(`[eBay Trading API] ${callName} HTTP ${res.status} response: ${sanitizeEbayResponse(text)}`);

  if (!text.trim()) {
    throw new EbayApiError(
      callName,
      `eBay Trading API ${callName} returned HTTP ${res.status} with an empty response`,
      res.status.toString()
    );
  }

  let parsed: TradingResponse;
  try {
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
      parseTagValue: true,
      trimValues: true,
    });
    parsed = parser.parse(text) as TradingResponse;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new EbayApiError(
      callName,
      `Unable to parse eBay ${callName} XML response: ${message}. Response: ${sanitizeEbayResponse(text)}`,
      res.status.toString()
    );
  }

  if (!res.ok) {
    throw new EbayApiError(
      callName,
      `eBay Trading API ${callName} HTTP ${res.status}: ${sanitizeEbayResponse(text)}`,
      res.status.toString()
    );
  }

  const { ack, errors } = getAck(parsed);
  if (ack !== "Success" && ack !== "PartialSuccess" && ack !== "Warning") {
    const { message, code } = formatEbayErrors(errors);
    throw new EbayApiError(
      callName,
      `${callName} failed${ack ? ` (${ack})` : ""}: ${message}`,
      code
    );
  }

  return parsed;
}

export async function getEbayUser(accessToken: string, siteId = 0) {
  const xml = `<GetUserRequest xmlns="urn:ebay:apis:eBLBaseComponents"></GetUserRequest>`;
  const res = await callTradingApi({ callName: "GetUser", siteId, accessToken, xmlBody: xml });
  const response = getResponseRoot(res);
  const user = response?.User as Record<string, unknown> | undefined;
  const userId = valueAsString(user?.UserID);

  if (!userId) {
    throw new Error("Unable to retrieve eBay user ID");
  }

  return { userId };
}

export type EbayListingItem = {
  [key: string]: unknown;
  ItemID: string;
  SKU?: string;
  Title: string;
  Description?: string;
  SellingStatus?: {
    CurrentPrice?: number | string | { "#text"?: number; "@_currencyID"?: string };
    BidCount?: number | string;
    QuantitySold?: number;
    ListingStatus?: string;
  };
  Quantity: number;
  QuantityAvailable: number;
  WatchCount?: number | string | { "#text"?: number | string };
  HitCount?: number | string | { "#text"?: number | string };
  ListingDetails?: { StartTime?: string; EndTime?: string; ViewItemURL?: string };
  ListingType?: string;
  ConditionDisplayName?: string;
  PrimaryCategory?: { CategoryID?: string; CategoryName?: string };
  PictureDetails?: { PictureURL?: string | string[] };
  ItemSpecifics?: { NameValueList?: Array<{ Name?: string; Value?: string | string[] }> | { Name?: string; Value?: string | string[] } };
  RelistedItemID?: string | number;
};

export type EbayTradingMutationResult = {
  itemId: string;
  ack: string;
  warnings: Array<{ code: string | null; severity: string | null; message: string }>;
};

function tradingMutationResult(result: TradingResponse, itemId: string): EbayTradingMutationResult {
  const root = getResponseRoot(result);
  const raw = root?.Errors == null ? [] : Array.isArray(root.Errors) ? root.Errors : [root.Errors];
  return {
    itemId,
    ack: valueAsString(root?.Ack) ?? "Unknown",
    warnings: raw.map(entry => {
      const error = (entry ?? {}) as Record<string, unknown>;
      return {
        code: valueAsString(error.ErrorCode) ?? null,
        severity: valueAsString(error.SeverityCode) ?? null,
        message: valueAsString(error.LongMessage) ?? valueAsString(error.ShortMessage) ?? "eBay warning",
      };
    }),
  };
}

export type SellerListWindow = {
  startFrom?: Date;
  startTo?: Date;
  endFrom?: Date;
  endTo?: Date;
};

export async function getItem(accessToken: string, itemId: string, siteId = 0): Promise<EbayListingItem> {
  const normalizedItemId = itemId.trim();
  if (!/^\d+$/.test(normalizedItemId)) {
    throw new EbayApiError("GetItem", "GetItem requires a numeric eBay ItemID", "INVALID_ITEM_ID");
  }
  const xml = `<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ItemID>${normalizedItemId}</ItemID>
  <DetailLevel>ReturnAll</DetailLevel>
  <IncludeItemSpecifics>true</IncludeItemSpecifics>
</GetItemRequest>`;
  const result = await callTradingApi({ callName: "GetItem", siteId, accessToken, xmlBody: xml });
  const response = getResponseRoot(result);
  const item = response?.Item as EbayListingItem | undefined;
  if (!item?.ItemID || String(item.ItemID) !== normalizedItemId) {
    throw new EbayApiError("GetItem", "GetItem returned no matching item identity", "MISSING_ITEM");
  }
  return { ...item, ItemID: String(item.ItemID) };
}

function xmlEscape(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function responseValue(result: TradingResponse, field: string) {
  return valueAsString(getResponseRoot(result)?.[field]);
}

export type EbayAddFixedPriceItemResult = Omit<EbayTradingMutationResult, "itemId"> & {
  itemId: string | null;
};

export function parseAddFixedPriceItemResponse(result: TradingResponse): EbayAddFixedPriceItemResult {
  const root = getResponseRoot(result);
  const parsedItemId = valueAsString(root?.ItemID)?.trim() ?? null;
  return {
    ...tradingMutationResult(result, parsedItemId ?? ""),
    itemId: parsedItemId && /^\d+$/.test(parsedItemId) ? parsedItemId : null,
  };
}

export async function addFixedPriceItemXml(accessToken: string, itemXml: string, siteId = 0) {
  if (!itemXml.trim().startsWith("<Item") || !itemXml.includes("<SKU>")) {
    throw new EbayApiError("AddFixedPriceItem", "A governed migration create requires an Item payload with a unique SKU", "INVALID_INPUT");
  }
  const xml = `<AddFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">${itemXml}</AddFixedPriceItemRequest>`;
  // Creating a listing is not safely retryable at the HTTP layer. Any ambiguous
  // outcome must be reconciled by destination SKU before an operator can retry.
  const result = await callTradingApi({ callName: "AddFixedPriceItem", siteId, accessToken, xmlBody: xml, retryMode: "single-attempt" });
  return parseAddFixedPriceItemResponse(result);
}

export async function reviseFixedPrice(accessToken: string, itemId: string, proposedPrice: number, messageId: string, siteId = 0) {
  if (!/^\d+$/.test(itemId) || !Number.isFinite(proposedPrice) || proposedPrice <= 0) throw new EbayApiError("ReviseInventoryStatus", "Invalid governed price change input", "INVALID_INPUT");
  const xml = `<ReviseInventoryStatusRequest xmlns="urn:ebay:apis:eBLBaseComponents"><MessageID>${xmlEscape(messageId)}</MessageID><InventoryStatus><ItemID>${itemId}</ItemID><StartPrice>${proposedPrice.toFixed(2)}</StartPrice></InventoryStatus></ReviseInventoryStatusRequest>`;
  await callTradingApi({ callName: "ReviseInventoryStatus", siteId, accessToken, xmlBody: xml });
  return { itemId };
}

export async function reviseFixedPriceTitle(accessToken: string, itemId: string, proposedTitle: string, messageId: string, siteId = 0) {
  if (!/^\d+$/.test(itemId) || !proposedTitle.trim() || proposedTitle.length > 80) throw new EbayApiError("ReviseFixedPriceItem", "Invalid governed title change input", "INVALID_INPUT");
  const xml = `<ReviseFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents"><MessageID>${xmlEscape(messageId)}</MessageID><Item><ItemID>${itemId}</ItemID><Title>${xmlEscape(proposedTitle)}</Title></Item></ReviseFixedPriceItemRequest>`;
  const result = await callTradingApi({ callName: "ReviseFixedPriceItem", siteId, accessToken, xmlBody: xml });
  const root = getResponseRoot(result);
  const errors = root?.Errors == null ? [] : Array.isArray(root.Errors) ? root.Errors : [root.Errors];
  return { itemId, ack: valueAsString(root?.Ack) ?? "Unknown", warningCodes: errors.flatMap((error: unknown) => error && typeof error === "object" ? [valueAsString((error as Record<string, unknown>).ErrorCode)].filter((value): value is string => Boolean(value)) : []) };
}

export type EbayItemSpecific = { Name: string; Value: string[] };

export async function reviseFixedPriceItemSpecifics(accessToken: string, itemId: string, itemSpecifics: EbayItemSpecific[], messageId: string, siteId = 0) {
  if (!/^\d+$/.test(itemId) || !itemSpecifics.length || itemSpecifics.length > 45) throw new EbayApiError("ReviseFixedPriceItem", "Invalid governed item-specific revision input", "INVALID_INPUT");
  const seen = new Set<string>();
  for (const specific of itemSpecifics) {
    const key = specific.Name.trim().toLocaleLowerCase();
    if (!key || seen.has(key) || !specific.Value.length || specific.Value.some(value => !value.trim())) throw new EbayApiError("ReviseFixedPriceItem", "Invalid or duplicate governed item-specific revision input", "INVALID_INPUT");
    seen.add(key);
  }
  const specificsXml = itemSpecifics.map(specific => `<NameValueList><Name>${xmlEscape(specific.Name)}</Name>${specific.Value.map(value => `<Value>${xmlEscape(value)}</Value>`).join("")}</NameValueList>`).join("");
  const xml = `<ReviseFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents"><MessageID>${xmlEscape(messageId)}</MessageID><Item><ItemID>${itemId}</ItemID><ItemSpecifics>${specificsXml}</ItemSpecifics></Item></ReviseFixedPriceItemRequest>`;
  const result = await callTradingApi({ callName: "ReviseFixedPriceItem", siteId, accessToken, xmlBody: xml });
  const root = getResponseRoot(result);
  const errors = root?.Errors == null ? [] : Array.isArray(root.Errors) ? root.Errors : [root.Errors];
  return { itemId, ack: valueAsString(root?.Ack) ?? "Unknown", warningCodes: errors.flatMap((error: unknown) => error && typeof error === "object" ? [valueAsString((error as Record<string, unknown>).ErrorCode)].filter((value): value is string => Boolean(value)) : []) };
}

export async function endFixedPriceListing(accessToken: string, itemId: string, messageId: string, siteId = 0) {
  if (!/^\d+$/.test(itemId)) throw new EbayApiError("EndFixedPriceItem", "Invalid governed listing identity", "INVALID_INPUT");
  const xml = `<EndFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents"><MessageID>${xmlEscape(messageId)}</MessageID><ItemID>${itemId}</ItemID><EndingReason>NotAvailable</EndingReason></EndFixedPriceItemRequest>`;
  await callTradingApi({ callName: "EndFixedPriceItem", siteId, accessToken, xmlBody: xml });
  return { itemId };
}

export async function verifyRelistFixedPriceListing(accessToken: string, itemId: string, quantity: number, messageId: string, siteId = 0) {
  if (!/^\d+$/.test(itemId) || !Number.isInteger(quantity) || quantity <= 0) throw new EbayApiError("VerifyRelistItem", "Invalid governed relist input", "INVALID_INPUT");
  const xml = `<VerifyRelistItemRequest xmlns="urn:ebay:apis:eBLBaseComponents"><MessageID>${xmlEscape(messageId)}</MessageID><Item><ItemID>${itemId}</ItemID><Quantity>${quantity}</Quantity></Item></VerifyRelistItemRequest>`;
  const result = await callTradingApi({ callName: "VerifyRelistItem", siteId, accessToken, xmlBody: xml });
  return tradingMutationResult(result, itemId);
}

export async function relistFixedPriceListing(accessToken: string, itemId: string, quantity: number, messageId: string, siteId = 0) {
  if (!/^\d+$/.test(itemId) || !Number.isInteger(quantity) || quantity <= 0) throw new EbayApiError("RelistFixedPriceItem", "Invalid governed relist input", "INVALID_INPUT");
  const xml = `<RelistFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents"><MessageID>${xmlEscape(messageId)}</MessageID><Item><ItemID>${itemId}</ItemID><Quantity>${quantity}</Quantity></Item></RelistFixedPriceItemRequest>`;
  const result = await callTradingApi({ callName: "RelistFixedPriceItem", siteId, accessToken, xmlBody: xml });
  const newItemId = responseValue(result, "ItemID");
  if (!newItemId || !/^\d+$/.test(newItemId) || newItemId === itemId) throw new EbayApiError("RelistFixedPriceItem", "Relist returned no distinct provider ItemID", "MISSING_ITEM");
  return { oldItemId: itemId, newItemId, ...tradingMutationResult(result, itemId) };
}

export async function* getSellerList(
  accessToken: string,
  siteId = 0,
  window: SellerListWindow = {},
  sellerUserId?: string
): AsyncGenerator<EbayListingItem[]> {
  let page = 1;
  const perPage = 200;
  let hasMore = true;

  while (hasMore) {
    const filters: string[] = [];
    if (window.startFrom) filters.push(`<StartTimeFrom>${window.startFrom.toISOString()}</StartTimeFrom>`);
    if (window.startTo) filters.push(`<StartTimeTo>${window.startTo.toISOString()}</StartTimeTo>`);
    if (window.endFrom) filters.push(`<EndTimeFrom>${window.endFrom.toISOString()}</EndTimeFrom>`);
    if (window.endTo) filters.push(`<EndTimeTo>${window.endTo.toISOString()}</EndTimeTo>`);

    const xml = `<GetSellerListRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <GranularityLevel>Fine</GranularityLevel>
  ${sellerUserId ? `<UserID>${xmlEscape(sellerUserId)}</UserID>` : ""}
  ${filters.join("\n  ")}
  <Pagination>
    <EntriesPerPage>${perPage}</EntriesPerPage>
    <PageNumber>${page}</PageNumber>
  </Pagination>
</GetSellerListRequest>`;

    const res = await callTradingApi({ callName: "GetSellerList", siteId, accessToken, xmlBody: xml });
    assertCompleteEnumeration(res, "GetSellerList");
    const response = getResponseRoot(res);
    const itemArray = response?.ItemArray as { Item?: EbayListingItem | EbayListingItem[] } | undefined;
    const pagination = response?.PaginationResult as { TotalNumberOfPages?: number | string } | undefined;

    const items = itemArray?.Item;
    const totalPages = parseTotalPages(pagination?.TotalNumberOfPages, "GetSellerList", page);

    if (items) {
      const list = Array.isArray(items) ? items : [items];
      yield list;
    } else {
      yield [];
    }

    hasMore = page < totalPages;
    page += 1;
  }
}

export async function* getActiveListings(
  accessToken: string,
  siteId = 0
): AsyncGenerator<EbayListingItem[]> {
  let page = 1;
  const perPage = 200;
  let hasMore = true;

  while (hasMore) {
    const xml = `
<GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ActiveList>
    <Sort>TimeLeft</Sort>
    <Pagination>
      <EntriesPerPage>${perPage}</EntriesPerPage>
      <PageNumber>${page}</PageNumber>
    </Pagination>
  </ActiveList>
</GetMyeBaySellingRequest>`;

    const res = await callTradingApi({ callName: "GetMyeBaySelling", siteId, accessToken, xmlBody: xml });
    assertCompleteEnumeration(res, "GetMyeBaySelling");
    const response = getResponseRoot(res);
    const activeList = response?.ActiveList as
      | {
          ItemArray?: { Item?: EbayListingItem | EbayListingItem[] };
          PaginationResult?: { TotalNumberOfPages?: number | string };
        }
      | undefined;

    const items = activeList?.ItemArray?.Item;
    const totalPages = parseTotalPages(activeList?.PaginationResult?.TotalNumberOfPages, "GetMyeBaySelling", page);

    if (items) {
      const list = Array.isArray(items) ? items : [items];
      yield list;
    } else {
      yield [];
    }

    hasMore = page < totalPages;
    page += 1;
  }
}
