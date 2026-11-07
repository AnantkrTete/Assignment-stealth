# Shared Bill Splitter

A small full-stack bill-splitting application for shared homes.

The backend uses Hono on Cloudflare Workers with Cloudflare D1. The frontend uses React, Vite, and TanStack Router. All money is stored as integer cents.

## Features

- Create homes and add members.
- Create bills split between all members.
- Give remainder cents to members in insertion order.
- Pay shares safely with an `Idempotency-Key`.
- Prevent duplicate or competing payments.
- View outstanding balances.
- React loading, empty, error, and payment states.

## Project structure

```text
api/
  migrations/0001_init.sql   D1 database schema
  src/index.ts               Hono Worker and API routes
  test/                      Visible API tests
web/
  src/main.tsx               React and TanStack Router entry point
  src/routes/index.tsx       Bill list and payment page
```

## Requirements

- Node.js
- pnpm

Cloudflare credentials are not required for local development or tests.

## Run locally

Install dependencies:

```bash
pnpm install
```

Start the API and web app:

```bash
pnpm dev
```

The applications run at:

- Web: http://localhost:5173
- API: http://localhost:8787
- Health check: http://localhost:8787/api/health

The API dev command applies the D1 migrations to a local database before starting Wrangler.

## API

### Create a home

```http
POST /api/homes
Content-Type: application/json

{ "name": "Flat 4B" }
```

Returns `201` with `{ id, name }`.

### Add a member

```http
POST /api/homes/:homeId/members
Content-Type: application/json

{ "name": "Asha" }
```

Returns `201` with `{ id, homeId, name }`. An unknown home returns `404`.

### Create a bill

```http
POST /api/homes/:homeId/bills
Content-Type: application/json

{ "title": "Electricity", "totalCents": 1000 }
```

The amount must be a positive integer. If three members split `1000` cents, the shares are `334`, `333`, and `333`.

The bill and all shares are inserted using one D1 batch.

### List bills

```http
GET /api/homes/:homeId/bills
```

Returns `{ bills: [...] }` for the web page.

### Pay a share

```http
POST /api/bills/:billId/shares/:shareId/pay
Idempotency-Key: a-unique-request-key
```

- Missing key: `400`
- Successful payment: `200`
- Same key repeated: `200` with the original payment result
- Different key after payment: `409`
- Unknown bill or share: `404`

Payment uses one conditional SQL update with `paid_at IS NULL`. The database decides which request wins when payments happen concurrently.

### Get balances

```http
GET /api/homes/:homeId/balances
```

Returns each member’s unpaid total in insertion order.

All errors use this JSON shape:

```json
{ "error": "message" }
```

## Database design

The migration creates four tables:

- `homes` — shared homes.
- `members` — people in a home, including `insertion_order`.
- `bills` — bill title and total in cents.
- `shares` — one amount per member per bill, including payment state.

Named constraints protect the data:

- `fk_members_home`, `fk_bills_home`, and the share foreign keys prevent invalid relationships.
- `chk_bills_total_positive` and `chk_shares_amount_positive` prevent non-positive amounts.
- `uq_members_home_order` preserves unique member ordering within a home.
- `uq_shares_bill_member` prevents duplicate shares for one member and bill.

## Testing and quality checks

Run the visible API tests:

```bash
pnpm test
```

Run formatting and linting:

```bash
pnpm check
```

Run TypeScript checks:

```bash
pnpm typecheck
```

Build the frontend:

```bash
pnpm build
```

The full verification command is:

```bash
pnpm install && pnpm check && pnpm typecheck && pnpm test
```

## Cloudflare deployment

Local development does not need a Cloudflare account. Deployment does.

1. Authenticate Wrangler:

   ```bash
   pnpm --filter bill-splitter-api exec wrangler login
   ```

2. Create a D1 database and update `api/wrangler.jsonc` with the real database ID:

   ```bash
   pnpm --filter bill-splitter-api exec wrangler d1 create bill-splitter
   ```

3. Apply migrations remotely:

   ```bash
   pnpm --filter bill-splitter-api exec wrangler d1 migrations apply DB --remote
   ```

4. Deploy the Worker:

   ```bash
   pnpm --filter bill-splitter-api deploy
   ```

The web application can be built with `pnpm build` and hosted separately. Its API proxy is configured for local development.

## Design decisions

1. Money is stored as integer cents to avoid floating-point rounding errors.
2. Member insertion order is stored explicitly so remainder allocation and balances are deterministic.
3. Payment uses one conditional database update so idempotency and concurrent requests are decided by D1 rather than by JavaScript timing.
