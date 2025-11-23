CREATE SCHEMA IF NOT EXISTS "order-engine";

CREATE TABLE IF NOT EXISTS "order-engine".orders (
  id uuid PRIMARY KEY,
  user_id text,
  type text, -- 'market'
  token_in text,
  token_out text,
  amount_in numeric,
  slippage numeric,
  status text,
  attempts integer DEFAULT 0,
  error text,
  executed_price numeric,
  tx_hash text,
  routing_info jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_orders_status 
    ON "order-engine".orders(status);
