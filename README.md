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
5. Generate and run migrations:
   ```bash
   npx prisma generate
   npx prisma migrate dev
   ```
6. Seed sample data:
   ```bash
   npm run db:seed
   ```
7. Run the dev server:
   ```bash
   npm run dev
   ```

## eBay Production Keyset Compliance

Marketplace Account Deletion Notification endpoint: `GET|POST /api/ebay/account-deletion`.
- `GET ?challenge_code=...` returns `SHA-256(challengeCode + verificationToken + endpointUrl)` as JSON `{ challengeResponse: "..." }`.
- `POST` logs the notification and returns HTTP 200.
- Configure `EBAY_MADN_ENDPOINT_URL` and `EBAY_MADN_VERIFICATION_TOKEN` in `.env`, then enter the same URL and token in the eBay Developer Portal.

## Notable Decisions

- Token encryption uses Node.js `crypto` with a `TOKEN_ENCRYPTION_KEY` hex secret.
- eBay OAuth callback is a stub; production should exchange `code` for real tokens with eBay's token endpoint.
- Phase 1 is read-only: all `apply` actions are logged locally and must be performed manually on eBay.
