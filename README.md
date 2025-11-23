# Solana Order Engine

**Devnet proof-of-concept**: an order execution engine that routes SPL-token swaps to the best on-chain venue (Meteora or Raydium), executes the swap on Solana Devnet, persists order history to PostgreSQL, and streams live lifecycle events to clients via WebSocket.

---

## Table of contents
- [Overview](#overview)
- [Architecture & technologies](#architecture--technologies)
- [Design decision - Why market order type](#design-decision---why-market-order-type)
- [Workflow / Process flow](#workflow--process-flow-detailed)
- [Project files and responsibilities](#project-files-and-responsibilities)
- [Database schema (order history)](#database-schema-order-history)
- [Solana explorer links (pools)](#solana-explorer-links-pools)
- [Local setup (development & production build)](#local-setup-development--production-build)
- [Build & runtime notes (TS / ESM / imports)](#build--runtime-notes-ts--esm--imports)
- [Testing / Verification (including wrapped SOL)](#testing--verification-including-wrapped-sol)

---

## Overview
This repository implements an **order execution engine** using Solana Devnet. The system receives a market swap order, queries multiple DEXs (Meteora and Raydium) for quotes, selects the best execution venue (after accounting for fees and slippage), executes the swap on Solana, stores the result in Postgres, and streams live order lifecycle updates to the client by WebSocket.

The project is intentionally scoped as a server-side proof-of-concept and avoids order book complexity by implementing market order behavior for immediate execution.

---

## Architecture & technologies
**Core components**
- Fastify - HTTP server and WebSocket endpoint (`src/server.ts`, `@fastify/websocket`).
- BullMQ + Redis (Upstash recommended) - job queue & worker processing concurrency and retry/backoff logic.
- PostgreSQL - persistent order history and audit log.
- Solana (Devnet) - on-chain execution using:
  - Meteora dynamic AMM SDK (`@meteora-ag/dynamic-amm-sdk`) - Meteora pool interactions and quotes.
  - Raydium SDK v2 (`@raydium-io/raydium-sdk-v2`) - CPMM pool swaps and quotes.
- `@solana/spl-token` & `@solana/web3.js` - token and transaction helpers.
- TypeScript with ESM (`moduleResolution: NodeNext`) for the codebase.

**High-level diagram**
```
Client -> Fastify POST /api/orders/execute -> DB (insert pending) -> enqueue job (BullMQ)
    -> Worker consumes job -> DexRouter queries Meteora & Raydium -> choose best -> execute swap -> update DB -> publish events -> wsManager forwards to client
```

---

## Design decision - Why market order type
**Reasons to choose market orders for the POC**:
1. **Simplicity & scope** - market orders allow focusing on routing logic, swaps, retry/backoff, and real-time UX instead of building an order book or matching engine.
2. **AMM fit** - AMMs (Meteora, Raydium) function naturally with market-style swaps (you provide input and receive the best available output). Limit orders would require additional on-chain/off-chain mechanisms (e.g., keepers, time-in-force) which are beyond the assignment scope.
3. **Deterministic verification** - executed price and tx hash are produced immediately and can be verified on explorer; routing decisions can be benchmarked.
4. **Deliverable alignment** - the assignment expects a single order type and explicit lifecycle events; market order maps clearly to the lifecycle.

---

## Workflow / Process flow (detailed)
1. **Client** sends `POST /api/orders/execute` with `{ token_in, token_out, amount_in, slippage? }`.
2. **Server (Fastify)** validates payload, creates `orderId`, inserts `status = pending` in Postgres, returns `{ orderId, wsToken, wsUrl }` to caller, and enqueues the job to BullMQ.
3. **Worker (BullMQ)** picks the job, publishes `pending -> routing` event via Redis pub/sub.
4. **DexRouter** performs concurrent price discovery:
   - queries Meteora for a quote (uses Meteora SDK `getSwapQuote` / `AmmImpl`).
   - queries Raydium CPMM via Raydium SDK demo methods (load pool info, use CurveCalculator or CPMM logic) for quote.
   - converts quoted outputs to comparable `outAmount` values (after fees) and picks the best.
5. **Worker** builds the transaction for the chosen DEX, applies `minOut` using `slippage`, and submits the transaction.
6. Worker publishes `building -> submitted` with TX hash, then waits for confirmation and publishes `confirmed` or `failed` depending on result. All state transitions are persisted to Postgres.
7. **wsManager** subscribes to Redis pub/sub channels and forwards lifecycle messages to authenticated WebSocket clients.

**Lifecycle states**: `pending → routing → building → submitted → confirmed` (or `failed`).

---

## Project files and responsibilities

```
solana-order-engine/
  .env                # runtime env vars
  package.json
  tsconfig.json
  scripts/             # token & pool creation / test scripts
    database/
      postgres_init.sql
    meteora/
      create-meteora-pool.ts
      meteora-test-swap.ts
    raydium/           # clone raydium-sdk-v2-demo github repo & modify these files
      config.ts
      createCpmmPool.ts
      swap.ts
    create-dev-token.ts
    create-dev-usdc.ts
    
  src/
    config/
      config.ts         # env parsing and shared constants
      db.ts             # Postgres helper functions (insert/update orders)
    router/
      dexRouter.ts      # gather quotes from both DEXs and execute on chosen DEX
    utils/
      solanaHelpers.ts  # WSOL wrap/unwrap & other Solana helpers
    websocket/
      wsManager.ts      # WebSocket clients management and Redis pub/sub bridge
    server.ts           # Fastify HTTP routes + WS auth / order endpoint
    worker.ts           # BullMQ worker for processing orders
```

**Key responsibilities**
- `server.ts` - endpoint: `POST /api/orders/execute`, returns `orderId` and WS info; serves the `/ws` endpoint.
- `worker.ts` - consumes BullMQ jobs; orchestrates routing -> execution -> DB updates -> emits lifecycle events.
- `dexRouter.ts` - contains `getQuotes()` and `executeSwap()` implementations for Meteora and Raydium.
- `db.ts` - wrappers for `insertOrder`, `updateOrderStatus`, `setRoutingInfo`, etc.
- `solanaHelpers.ts` - contains `wrapSOLAndGetCleanup()` to handle native SOL flows and ATA management.
- `wsManager.ts` - tracks connected websocket clients, authenticates them via `wsToken` (HMAC), and forwards pub/sub messages.

---

## Database schema (order history)
Use the provided SQL migration to create the `orders` table. SQL:

```sql
CREATE SCHEMA IF NOT EXISTS "order-engine";

CREATE TABLE IF NOT EXISTS "order-engine".orders (
  id TEXT PRIMARY KEY,
  user_id TEXT NULL,
  type TEXT DEFAULT 'market',
  token_in TEXT NOT NULL,
  token_out TEXT NOT NULL,
  amount_in TEXT NOT NULL,
  slippage NUMERIC DEFAULT 1.0,
  status TEXT DEFAULT 'pending',
  attempts INTEGER DEFAULT 0,
  error TEXT NULL,
  tx_hash TEXT NULL,
  executed_price NUMERIC NULL,
  routing_info JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_orders_status_created_at ON "order-engine".orders(status, created_at);
```

**Notes**
- Store `routing_info` as JSONB to capture which DEX was chosen and the quote details (fees, minOut, expected outAmount).
- `attempts` tracks retry attempts from BullMQ.

---

## Solana explorer links (pools)

- Meteora pool address:
  `https://explorer.solana.com/address/AJeCh7ZKBntrLvnDxniFA1XzqQ16WrTTEd893hdq1THE?cluster=devnet`

- Raydium pool address:
  `https://explorer.solana.com/address/2qN6ZrdHcDHP9cQtVxTS7C98F44KfuDN5Ni8oPTgJuU1?cluster=devnet`

---

## Local setup (development & production build)

### Prerequisites
- Node.js v18+ (recommended)
- npm
- PostgreSQL (or a hosted Postgres like Supabase)
- Redis (Upstash recommended) - provide `REDIS_URL` accordingly
- Solana CLI / keypair to create tokens & pools

### Solana CLI Setup (Devnet)

To run scripts for creating tokens, pools, and signing transactions, you must install the **Solana CLI**, create a **Devnet keypair**, and fund it with SOL.

---

#### 1. Install Solana CLI
Follow the official doc: `https://solana.com/docs/intro/installation`

Verify installation:

```bash
solana --version
```
---

#### 2. Configure CLI to Devnet
```bash
solana config set --url https://api.devnet.solana.com
```
Check config:
```bash
solana config get
```
---

#### 3. Create a Devnet Keypair
Generate a new keypair:
```bash
solana-keygen new --outfile ~/solana-devnet-keypair.json
```
Show public key:
```bash
solana-keygen pubkey ~/solana-devnet-keypair.json
```
Set this wallet as default:
```bash
solana config set --keypair ~/solana-devnet-keypair.json
```
---

#### 4. Airdrop SOL (Devnet)

Your wallet needs SOL to pay for fees when creating tokens, ATAs, pools, or sending swaps.

##### **Method A — CLI airdrop**

```bash
solana airdrop 2
solana balance
```
> Note: Devnet rate-limits sometimes; retry if needed.

##### **Method B — Solana Faucet**

Use the official faucet: `https://faucet.solana.com`

1. Paste your wallet address  
2. Select **Devnet**  
3. Request airdrop  
4. Verify balance:

```bash
solana balance
```
---

#### 5. Troubleshooting

| Issue | Solution |
|-------|----------|
| `Airdrop failed` | Try multiple times or use faucet |
| RPC rate-limit | Wait a few seconds and retry |
| Wrong network | `solana config set --url devnet` |
| Keypair permission denied | `chmod 600 ~/solana-devnet-keypair.json` |

### Environment
Create a `.env` from `.env.example` and populate values:
```
PORT=3000
DATABASE_URL=postgres://user:pass@localhost:5432/dbname
REDIS_URL=redis://localhost:6379
SOLANA_RPC=https://api.devnet.solana.com
WALLET_PRIVATE_KEY_JSON=[]
WS_SECRET=...
USDC_DEV_MINT=...
TEST_DEV_MINT=...
POOL_ADDRESS=... # Meteora pool
POOL_ID=... # Raydium pool
SWAP_SLIPPAGE=1.0
SWAP_IN_HUMAN=0.1
USE_MOCK=false # Flag for real devnet execution / mock implementation
```

### Install dependencies
```bash
npm install
```

### Apply DB migration
```bash
psql "$DATABASE_URL" -f scripts/database/postgres_init.sql
```

### Run in development (fast, no build)
Development uses `ts-node` to run TS directly (recommended while developing). Run server and worker in separate terminals:

```bash
npm run dev:server
npm run dev:worker
```

**Note**: running dev with `ts-node --esm` resolves `.ts` source imports; if you have switched TypeScript source imports to use `.js` extensions, `ts-node` may fail to map them back to `.ts` files. If you encounter import errors in dev mode, switch to building first (see below) or revert imports to extension-less (`./db`, `./dexRouter`) for dev convenience.

### Production / Run from built files (recommended for final submission)
To avoid ESM import mismatch and get deterministic runtime behavior, build first and then run the compiled JS:

```bash
npm run build     # runs `tsc -p .` (requires tsconfig.json)
node dist/src/server.js
node dist/src/worker.js
```

**Important**: the project uses `moduleResolution: NodeNext` and the build step emits imports with `.js` extensions. Running built files via `node` requires that build step - skipping it can produce runtime errors such as `ERR_MODULE_NOT_FOUND` or extension errors.

---

## Build & runtime notes (TS / ESM / imports)
- The project uses `module: NodeNext` and ESM. To satisfy Node's ESM import resolution you should use **`.js` extensions in source imports** _if_ you intend to run compiled output without bundling. However, using `.js` extensions directly in `.ts` source is inconvenient for dev with `ts-node`.

**Recommended pattern**:
- During development with `ts-node`, prefer extension-less imports (e.g. `import x from './db'`). `ts-node` maps these imports to `.ts` files.
- For production / compiled artifacts (`dist/`), TypeScript will emit `import ... from './db.js'` so Node can resolve them at runtime.

If you previously changed imports to `./foo.js` in `.ts` files and experience `ERR_MODULE_NOT_FOUND` when running `ts-node`, revert to `./foo` in source and use the `npm run build` + `node dist/...` flow for production runs.

**Common fixes for errors you may encounter**:
- `TS5057` (missing `tsconfig.json`): create `tsconfig.json` at the root and run `npm run build`.
- `TS5097` (`allowImportingTsExtensions`) is not recommended; instead remove `.ts` extensions in source.
- `ts(2835)` (NodeNext requires explicit extensions): either use `.js` in emitted code via build or use extension-less imports during dev and compile for prod.
- `ioredis` construct error (`TS2351`): import as `import { Redis } from 'ioredis'` and instantiate `new Redis(url)`.

---

## Testing & Verification (including wrapped SOL)
**Manual verification steps you already used and should re-run**:
1. Create / fund dev wallet and mint test tokens using scripts in `/scripts/`.
2. Create Meteora & Raydium pools (scripts provided or adapted from the Raydium SDK demo).
3. Run `npm run dev:server` & `npm run dev:worker` (or build + run) and submit a sample order via `curl` or Postman. Observe WS lifecycle events and confirm tx hash via Solana Explorer.

**Wrapped SOL**: the code includes `solanaHelpers.wrapSOLAndGetCleanup()` to wrap native SOL to WSOL before swaps. You must **test** wrapped SOL flows manually (create order with `token_in: "SOL"`) and observe that temporary WSOL accounts are closed on completion.

**Stress testing**: set `concurrency: 10` in `new Worker(..., { concurrency: 10 })` and try sending concurrent orders to target ~100 orders/min to verify throughput and retry behaviors.

---