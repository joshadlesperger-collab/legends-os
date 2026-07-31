import crypto from "crypto";
import { XMLParser } from "fast-xml-parser";

const ALGORITHM = "aes-256-cbc";

const EBAY_OAUTH_SCOPES = [
  "https://api.ebay.com/oauth/api_scope",
  "https://api.ebay.com/oauth/api_scope/sell.inventory",
  "https://api.ebay.com/oauth/api_scope/sell.account",
] as const;

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
    const text = await res.text();
    throw new Error(`eBay token exchange failed: ${res.status} ${text}`);
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
    scope: EBAY_OAUTH_SCOPES.join(" "),
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
    const text = await res.text();
    throw new Error(`eBay token refresh failed: ${res.status} ${text}`);
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

export async function getValidAccessToken(store: StoreWithTokens) {
  const access = store.oauthAccessToken ? getStoredToken(store.oauthAccessToken) : null;
  const refresh = store.oauthRefreshToken ? getStoredToken(store.oauthRefreshToken) : null;

  if (!access) {
    throw new Error("Store has no access token");
  }

  const now = Date.now();
  const expired = !store.tokenExpiresAt || store.tokenExpiresAt.getTime() < now + 60_000;

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
}) {
  const { callName, siteId, accessToken, xmlBody } = options;
  const endpoint = "https://api.ebay.com/ws/api.dll";
  const body = `<?xml version="1.0" encoding="utf-8"?>\n${xmlBody.trim()}`;

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "text/xml; charset=utf-8",
        "X-EBAY-API-CALL-NAME": callName,
        "X-EBAY-API-COMPATIBILITY-LEVEL": "1227",
        "X-EBAY-API-SITEID": siteId.toString(),
        "X-EBAY-API-APP-NAME": process.env.EBAY_APP_ID ?? "",
        "X-EBAY-API-DEV-NAME": process.env.EBAY_DEV_ID ?? "",
        "X-EBAY-API-CERT-NAME": process.env.EBAY_CERT_ID ?? "",
        "X-EBAY-API-IAF-TOKEN": accessToken,
      },
      body,
      cache: "no-store",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new EbayApiError(callName, `${callName} network request failed: ${message}`);
  }

  const text = await res.text();
  console.error(
    `[eBay Trading API] ${callName} HTTP ${res.status} response: ${sanitizeEbayResponse(text)}`
  );

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
  ItemID: string;
  Title: string;
  Description?: string;
  SellingStatus?: {
    CurrentPrice?: { "#text"?: number; "@_currencyID"?: string };
    QuantitySold?: number;
  };
  Quantity: number;
  QuantityAvailable: number;
  WatchCount?: number;
  HitCount?: number;
  ListingDetails?: { StartTime?: string; EndTime?: string; ViewItemURL?: string };
  ListingType?: string;
  ConditionDisplayName?: string;
  PrimaryCategory?: { CategoryID?: string; CategoryName?: string };
  PictureDetails?: { PictureURL?: string | string[] };
};

export type SellerListWindow = {
  startFrom?: Date;
  startTo?: Date;
  endFrom?: Date;
  endTo?: Date;
};

export async function* getSellerList(
  accessToken: string,
  siteId = 0,
  window: SellerListWindow = {}
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
  ${filters.join("\n  ")}
  <Pagination>
    <EntriesPerPage>${perPage}</EntriesPerPage>
    <PageNumber>${page}</PageNumber>
  </Pagination>
</GetSellerListRequest>`;

    const res = await callTradingApi({ callName: "GetSellerList", siteId, accessToken, xmlBody: xml });
    const response = getResponseRoot(res);
    const itemArray = response?.ItemArray as { Item?: EbayListingItem | EbayListingItem[] } | undefined;
    const pagination = response?.PaginationResult as { TotalNumberOfPages?: number | string } | undefined;

    const items = itemArray?.Item;
    const totalPages = Number(pagination?.TotalNumberOfPages ?? 1);

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
    const response = getResponseRoot(res);
    const activeList = response?.ActiveList as
      | {
          ItemArray?: { Item?: EbayListingItem | EbayListingItem[] };
          PaginationResult?: { TotalNumberOfPages?: number | string };
        }
      | undefined;

    const items = activeList?.ItemArray?.Item;
    const totalPages = Number(activeList?.PaginationResult?.TotalNumberOfPages ?? 1);

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
