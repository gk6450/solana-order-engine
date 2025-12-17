# Test README — Solana Order Engine

**Purpose:** document the test setup, configuration, and how to run the unit & integration tests locally for the Solana Order Engine project.

---

## Quick overview

- Tests are written using **Vitest** (TypeScript-friendly).  
- We use **ioredis-mock** to replace Redis in many tests, and a small **in-memory `bullmq` mock** inside `tests/ws_and_queue.integration.test.ts` to avoid Lua/cmsgpack issues.  
- Worker processing logic is exercised end-to-end in-process via the mock; DEX logic uses a `USE_MOCK` path so no real Solana transactions are sent during tests.  
- Tests included in this repo:
  - `tests/setup.test.ts` — basic sanity checks.  
  - `tests/dexRouter.test.ts` — routing and executeSwap mock-path unit tests.  
  - `tests/ws_and_queue.integration.test.ts` — queue + websocket lifecycle integration using an in-memory `bullmq` mock.

---

## Install dependencies

From the project root:

```bash
npm install
```

(If you need the dev deps explicitly:)

```bash
npm install --save-dev vitest ioredis-mock ts-node typescript @types/node bn.js
```

---

## Environment variables for tests

By design tests set required env vars at runtime. If you run tests manually, ensure:

```bash
export USE_MOCK=true
# Optional: point to local/remote Redis if you choose to run a real Redis
export REDIS_URL=redis://127.0.0.1:6379
```

The test files generate a valid, unfunded Solana Keypair for `WALLET_PRIVATE_KEY_JSON` automatically, so **do not** put your real wallet secret in test envs or files.

---

## Running tests (recommended - mock mode)

Run the full test suite:

```bash
USE_MOCK=true npm run test
```

Run a single test file:

```bash
npx vitest run tests/dexRouter.test.ts
```

List discovered tests:

```bash
npx vitest --list
```

---

## What the tests mock and why

- **`ioredis-mock`** — provides an in-memory Redis-compatible client for pub/sub and simple commands. Note: `ioredis-mock` does **not** include native Redis modules like `cmsgpack` used by BullMQ Lua scripts; calling those will error.
- **In-memory `bullmq` mock (test-local)** — to avoid `cmsgpack` / Lua errors when running BullMQ Worker logic inside a mocked Redis, the integration test provides a small `vi.mock('bullmq', ...)` which implements minimal `Queue` and `Worker` behavior in-process (see `tests/ws_and_queue.integration.test.ts`). This lets the worker processor run synchronously/asynchronously in tests without relying on a real Redis server.
- **DB functions** — Postgres DB functions are mocked using `vi.mock('../src/config/db.js', ...)` to prevent needing a real database for the test-suite.

---

## Common issues & debugging

- **`provided secretKey is invalid`** — occurs if `WALLET_PRIVATE_KEY_JSON` is missing or invalid. Tests set a generated, cryptographically-valid keypair for mock mode automatically. Do not set invalid arrays in your environment.
- **`attempt to index a nil value (global 'cmsgpack')`** — occurs when BullMQ attempts to execute Lua scripts under an `ioredis-mock` VM; solution: either use the in-memory `bullmq` mock used in the integration test, or run a real Redis (see above).
- **`bigint: Failed to load bindings`** — optional native-binding warning; the package falls back to JS implementation. It can be ignored for test runs.
- If tests say `No test files found`, ensure `vitest.config.ts` exists and includes the `tests/**/*.test.ts` pattern, and run from the project root.

---

## Test structure and flow (high level)

1. **Bootstrap**: test file sets `process.env.USE_MOCK = 'true'`, generates a test-only Solana Keypair and injects `WALLET_PRIVATE_KEY_JSON`.
2. **Mocks load**: before app modules import, tests `vi.mock('bullmq', ...)` and `vi.mock('ioredis', ...)` ensure the mocked implementations are used.
3. **Worker import**: tests import `src/worker.js`. The mocked `Worker` constructor registers the processor function with the in-memory queue.
4. **Add job**: tests call `queue.add(...)` which pushes a job and triggers the in-memory worker processor asynchronously.
5. **Assertions**: tests subscribe to WebSocket messages using `wsManager` helpers, assert lifecycle messages (`pending`, `routing`, `submitted`, `confirmed` or `failed`) are received, and validate router behaviors from `dexRouter.test.ts`.

---

## Extending tests

- To assert strict outcomes (e.g., always `confirmed`), mock `../src/router/dexRouter.js` to make `executeSwap` always succeed.
- To test Postgres interactions, replace DB mocks with a test database and remove the DB `vi.mock` lines.
- For CI, prefer running a real Redis service (Docker) and set `REDIS_URL` in the CI environment.

---
