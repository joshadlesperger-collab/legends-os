# Legends OS — Phase 1 + Phase 2: Inventory Intelligence with eBay Production API

A Next.js 14 + TypeScript + Prisma/PostgreSQL foundation for the Legends OS multi-tenant eBay decision engine.

## Milestone 1 Implementation

- **Store Connection** (`/api/stores`, `/api/stores/callback`) with AES-256 token encryption for eBay OAuth.
- **Listing Ingestion** schema (`Listing`, `ListingSnapshot`, `PriceChange`, `SaleEvent`) and read endpoints.
- **Scoring Engine** schema (`ListingScore`, `ScoreConfig`) with sample health/opportunity scores in seed.
- **Daily Action Queue** (`/api/queue`) ranked by `expectedProfitImpact` and `confidence`.
- **Dismiss / Apply** workflow endpoints (`/api/queue/[id]/dismiss`, `/api/queue/[id]/apply`).

## Phase 2 — eBay Production API

- **Production OAuth** (`/api/stores`, `/api/stores/callback`) using real eBay production credentials.
- **Secure token storage** in PostgreSQL with AES-256 encryption and automatic refresh.
- **Stores page** (`/stores`) with eBay User ID, marketplace, last sync, connection status, and sync buttons.
- **Listing import** (`POST /api/stores/[id]/sync`) using the eBay Trading `GetMyeBaySelling` API.
- **Import progress** tracked by `SyncRun` rows; errors logged to `ApiErrorLog`.
- **Dashboard** populated with real eBay listings and connected store summaries.
- **Marketplace Account Deletion** (`/api/ebay/account-deletion`) compliant endpoint with challenge validation.

## Setup

1. Install Node.js and npm.
2. Start PostgreSQL locally:
   ```bash
   docker-compose up -d
   ```
3. Install dependencies:
   ```bash
   npm install
   ```
4. Copy `.env.example` to `.env` and fill in your eBay credentials.
5. Generate the Prisma client and apply development migrations:
   ```bash
   npm run db:generate
   npm run db:migrate
   ```
6. Seed sample data:
   ```bash
   npm run db:seed
   ```
7. Run the dev server:
   ```bash
   npm run dev
   ```

## Database migrations and deployment

Prisma migration files under `prisma/migrations` are committed and reviewed with the schema changes that create them. Application builds only generate Prisma Client and compile Next.js; builds must not run `prisma db push` or otherwise mutate a database.

For development schema changes:

1. Update `prisma/schema.prisma`.
2. Run `npm run db:migrate -- --name <descriptive-name>` against a development database.
3. Review the generated SQL under `prisma/migrations`.
4. Commit the schema and migration together after approval.
5. Run the normal validation, including `npm run build`.

For production releases, run `npm run db:migrate:status` and review the pending migration SQL before deployment. After explicit production approval, run `npm run db:migrate:deploy` as a separate release step using the production database connection, then deploy the already-validated application build. Do not run `prisma migrate dev` or `prisma db push` against production.

### Existing database baseline

This repository previously used `prisma db push`, so an existing production database may have the schema without corresponding rows in Prisma's `_prisma_migrations` table. Before the first production `prisma migrate deploy`, inspect the production schema and migration status without changing them. If the schema is confirmed to match an existing migration, mark that migration as applied with `prisma migrate resolve --applied <migration-name>` only through an explicitly approved baseline procedure. Do not guess, reapply the initial migrations to a populated database, or resolve migrations whose effects have not been verified.

## eBay Production Keyset Compliance

Legends OS uses `EBAY_CLIENT_ID` and `EBAY_CLIENT_SECRET` as the canonical Production App ID and Cert ID for OAuth token exchange and refresh. The current Trading API listing calls authenticate with the OAuth user access token through `X-EBAY-API-IAF-TOKEN`; they do not use the legacy App ID, Cert ID, or Developer ID headers. Consequently, `EBAY_APP_ID`, `EBAY_CERT_ID`, and `EBAY_DEV_ID` are not application configuration variables.

Marketplace Account Deletion Notification endpoint: `GET|POST /api/ebay/account-deletion`.
- `GET ?challenge_code=...` returns `SHA-256(challengeCode + verificationToken + endpointUrl)` as JSON `{ challengeResponse: "..." }`.
- `POST` logs the notification and returns HTTP 200.
- Configure `EBAY_MADN_ENDPOINT_URL` and `EBAY_MADN_VERIFICATION_TOKEN` in `.env`, then enter the same URL and token in the eBay Developer Portal.

## eBay synchronization integrity

- Full synchronization treats `GetMyeBaySelling` as the authoritative active-list enumeration. Previously active listings are marked ended only after every page completes successfully; partial or failed enumeration does not reconcile unseen listings.
- Incremental synchronization overlaps the last successful store checkpoint by five minutes and processes started and ended windows with explicit statuses. Listing item IDs provide idempotent deduplication across overlapping observations.
- `SyncRun` rows provide a per-store database lock. Recent running syncs return a conflict, stale locks are failed before a new run starts, and completed/failed runs release the lock through terminal status.
- Initial observations, meaningful changes, status transitions, and full-reconciliation endings create `ListingSnapshot` history. Clear price changes also create `PriceChange` rows.
- `Store.lastSyncAt` remains a timestamp checkpoint rather than a provider-issued durable cursor. The overlap reduces boundary risk but cannot provide stronger guarantees than the current eBay Trading API flow.
- `SaleEvent` is never inferred from listing `quantitySold`; authoritative events come from eBay Fulfillment order lines.

## Trusted commerce synchronization

- New eBay OAuth authorizations request the read-only Fulfillment API scope. Stores connected before this scope was added retain listing synchronization but are marked as requiring reauthorization before order synchronization can run.
- `POST /api/stores/[id]/sync` and `POST /api/stores/[id]/orders/sync` enqueue durable work instead of performing provider calls in the request. Job state is available at `GET /api/jobs/[id]`.
- Vercel Cron invokes `GET /api/internal/jobs/process` every five minutes. The endpoint requires `Authorization: Bearer <CRON_SECRET>` and fails closed when `CRON_SECRET` is missing. Configure a strong `CRON_SECRET` directly in each Vercel environment; never commit its value.
- Order synchronization uses eBay's Fulfillment `getOrders` endpoint with an overlapping last-modified window. Orders, line items, refunds, and sale events are upserted by provider identifiers, so replaying a window is idempotent.
- Each worker invocation processes one bounded provider page under an execution lease, persists its fixed window and next offset, then releases itself for the next cron tick. An expired lease can be reclaimed, and replay before cursor advancement remains idempotent.
- The order checkpoint advances only after every page is fetched and persisted successfully. Existing listing records are linked when the provider item ID is known; order lines remain valid without a local listing match.

## Sales and profitability

- `/sales` is the operator view for authoritative gross sales, provider-reported proceeds and fees, refunds, recent sales, best sellers, sales velocity, inventory linkage, and order-job health. It intentionally excludes buyer PII.
- Gross sales, proceeds, fees, refunds, and known costs remain separate concepts. Legends OS does not label proceeds or known-cost margin as profit.
- Optional per-listing cost basis records capture per-unit acquisition, grading, supplies, outbound postage, and other known costs. They support a transparent known-cost margin while full accounting profit remains unavailable until every relevant cost is captured and provider order amounts can be allocated appropriately.

Before enabling the cron in production, apply the reviewed Prisma migration as a separately approved release step, configure `CRON_SECRET`, redeploy, and reauthorize each existing store through the normal eBay OAuth flow. Do not manually edit tokens or store authorization state.

## Notable Decisions

- Token encryption uses Node.js `crypto` with a `TOKEN_ENCRYPTION_KEY` hex secret.
- eBay OAuth callback exchanges the authorization code for encrypted production access and refresh tokens.
- Phase 1 is read-only: all `apply` actions are logged locally and must be performed manually on eBay.
# Comp Confidence V1

Comp Confidence is a 0–100 evidence-quality score. It is not a probability that a card will sell at the recommended price.

- Identity match: 30 points
- Qualifying comp quantity: 20 points, capped so three comps cannot exceed Moderate and four cannot exceed High
- Recency: 20 points
- Robust price consistency: 15 points
- Confirmed source quality: 15 points

Bands are Very High (90–100), High (75–89), Moderate (60–74), Low (40–59), and Insufficient (below 40). An actionable price requires at least three qualifying confirmed sold transactions, Moderate confidence, a legitimate live provider marker, and a positive supported market value. Evidence starts with a 90-day window, expands to 180 days if needed, then permits up to 365 days with an explicit confidence penalty. Active asking prices and fixture evidence never qualify as sold evidence.

The primary estimate is anchored to the median and adjusted modestly by a recency/identity-weighted median. External market evidence and Legends authoritative historical sales are displayed separately.
