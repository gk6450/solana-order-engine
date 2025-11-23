import dotenv from 'dotenv';
dotenv.config();
import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // For Supabase pooler, SSL is required; keep rejectUnauthorized false for dev
  ssl: process.env.NODE_ENV === 'production' || (process.env.DATABASE_URL?.includes('supabase') ?? false)
    ? { rejectUnauthorized: false }
    : false
});

// Log pool errors (important)
pool.on('error', (err) => {
  console.error('[pg pool] unexpected error', err);
});

// helper: small retry for transient errors
async function retry<T>(fn: () => Promise<T>, attempts = 3, delayMs = 500): Promise<T> {
  let lastErr: any;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      // if last attempt, rethrow
      if (i === attempts - 1) break;
      await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
    }
  }
  throw lastErr;
}

export async function testConnection() {
  return retry(async () => {
    const res = await pool.query('SELECT 1 as ok');
    return res.rows[0];
  }, 3, 300);
}

export async function insertOrder(o: {
  id: string;
  user_id?: string | null;
  type?: string;
  token_in: string;
  token_out: string;
  amount_in: string;
  slippage?: number;
}) {
  // NOTE: created_at and updated_at removed from column list because they default to now()
  const q = `
    INSERT INTO "order-engine".orders
      (id, user_id, type, token_in, token_out, amount_in, slippage, status)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
  `;
  // wrap call with retry to handle transient connection hiccups
  return retry(async () => {
    return pool.query(q, [
      o.id,
      o.user_id ?? null,
      o.type ?? 'market',
      o.token_in,
      o.token_out,
      o.amount_in,
      o.slippage ?? 1.0,
      'pending'
    ]);
  }, 4, 400);
}

export async function updateOrderStatus(id: string, status: string, opts: {
  attemptsDelta?: number;
  error?: string | null;
  txHash?: string | null;
  executedPrice?: number | null;
  routing?: any | null;
} = {}) {
  const attemptsDelta = opts.attemptsDelta ?? 0;
  const q = `
    UPDATE "order-engine".orders
    SET status = $2,
        attempts = COALESCE(attempts,0) + $3,
        error = $4,
        tx_hash = $5,
        executed_price = $6,
        routing_info = COALESCE(routing_info, '{}'::jsonb) || $7::jsonb,
        updated_at = now()
    WHERE id = $1
  `;
  return retry(async () => {
    return pool.query(q, [id, status, attemptsDelta, opts.error ?? null, opts.txHash ?? null, opts.executedPrice ?? null, JSON.stringify(opts.routing ?? {})]);
  }, 3, 400);
}

export async function setRoutingInfo(id: string, routing: any) {
  const q = `UPDATE "order-engine".orders SET routing_info = $2::jsonb, updated_at = now() WHERE id = $1`;
  return retry(async () => {
    return pool.query(q, [id, JSON.stringify(routing)]);
  }, 3, 300);
}

export default pool;
