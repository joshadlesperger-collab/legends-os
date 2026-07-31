import crypto from "crypto";
import { XMLParser } from "fast-xml-parser";

const ALGORITHM = "aes-256-cbc";

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
    scope: [
      "https://api.ebay.com/oauth/api_scope/sell.inventory",
      "https://api.ebay.com/oauth/api_scope/sell.account",
      "https://api.ebay.com/oauth/api_scope/sell.account:readonly",
    ].join(" "),
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
    scope: [
      "https://api.ebay.com/oauth/api_scope/sell.inventory",
      "https://api.ebay.com/oauth/api_scope/sell.account",
      "https://api.ebay.com/oauth/api_scope/sell.account:readonly",
    ].join(" "),
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

function xmlEnvelope(body: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ebl="urn:ebay:apis:eBLBaseComponents">
  <soapenv:Header>
    <ebl:RequesterCredentials>
      <ebl:eBayAuthToken></ebl:eBayAuthToken>
    </ebl:RequesterCredentials>
  </soapenv:Header>
  <soapenv:Body>
    ${body}
  </soapenv:Body>
</soapenv:Envelope>`;
}

export async function callTradingApi(options: {
  callName: string;
  siteId: number;
  accessToken: string;
  xmlBody: string;
}) {
  const { callName, siteId, accessToken, xmlBody } = options;
  const endpoint = "https://api.ebay.com/ws/api.dll";

  const body = xmlEnvelope(xmlBody);

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "text/xml",
      "X-EBAY-API-CALL-NAME": callName,
      "X-EBAY-API-COMPATIBILITY-LEVEL": "1227",
      "X-EBAY-API-SITEID": siteId.toString(),
      "X-EBAY-API-APP-NAME": process.env.EBAY_APP_ID ?? "",
      "X-EBAY-API-DEV-NAME": process.env.EBAY_DEV_ID ?? "",
      "X-EBAY-API-CERT-NAME": process.env.EBAY_CERT_ID ?? "",
      "X-EBAY-API-IAF-TOKEN": accessToken,
    },
    body,
  });

  const text = await res.text();
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
  const parsed = parser.parse(text) as Record<string, unknown>;

  if (!res.ok) {
    throw new Error(`eBay Trading API ${callName} failed: ${res.status} ${text.slice(0, 500)}`);
  }

  return parsed;
}

export async function getEbayUser(accessToken: string, siteId = 0) {
  const xml = `<GetUserRequest xmlns="urn:ebay:apis:eBLBaseComponents"></GetUserRequest>`;
  const res = (await callTradingApi({ callName: "GetUser", siteId, accessToken, xmlBody: xml })) as {
    "soapenv:Envelope"?: { "soapenv:Body"?: { GetUserResponse?: { User?: { UserID: string } } } };
  };

  const userId =
    res["soapenv:Envelope"]?.["soapenv:Body"]?.GetUserResponse?.User?.UserID;

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

    const res = (await callTradingApi({ callName: "GetMyeBaySelling", siteId, accessToken, xmlBody: xml })) as {
      "soapenv:Envelope"?: {
        "soapenv:Body"?: {
          GetMyeBaySellingResponse?: {
            ActiveList?: {
              ItemArray?: { Item?: EbayListingItem | EbayListingItem[] };
              PaginationResult?: { TotalNumberOfPages?: number };
            };
          };
        };
      };
    };

    const activeList =
      res["soapenv:Envelope"]?.["soapenv:Body"]?.GetMyeBaySellingResponse?.ActiveList;

    const items = activeList?.ItemArray?.Item;
    const totalPages = activeList?.PaginationResult?.TotalNumberOfPages ?? 1;

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
