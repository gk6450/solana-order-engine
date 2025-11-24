import fastify from 'fastify';
import websocketPlugin from '@fastify/websocket';
import dotenv from 'dotenv';
dotenv.config();

import { v4 as uuidv4 } from 'uuid';
import { Queue } from 'bullmq';
import {Redis} from 'ioredis';
import * as crypto from 'crypto';
import { insertOrder } from './config/db.js';

// create server instance (no top-level await)
const server = fastify({ logger: true });

/**
 * Create a WS auth token (HMAC) for a given orderId
 */
function createWsToken(orderId: string) {
  const secret = process.env.WS_SECRET || 'hello_world';
  return `${orderId}:${crypto.createHmac('sha256', secret).update(orderId).digest('hex')}`;
}

/**
 * Verify a WS token and return the orderId if valid, otherwise null
 */
function verifyWsToken(token: string | null | undefined) {
  if (!token) return null;
  const parts = token.split(':');
  if (parts.length !== 2) return null;
  const [orderId, sig] = parts;
  const expected = crypto.createHmac('sha256', process.env.WS_SECRET || 'hello_world').update(orderId).digest('hex');
  return expected === sig ? orderId : null;
}

/**
 * Helper: safely build a URL from req.url + host header.
 * This avoids `string | null` type issues for the URL constructor.
 */
function buildRequestUrl(req: any) {
  // req.url can be string | null | undefined depending on types
  const rawUrl = String(req.url ?? ''); // ensures string
  // headers.host can be string | string[] | undefined
  const hostHeader = req.headers?.host;
  const host = Array.isArray(hostHeader) ? hostHeader[0] : (hostHeader ?? 'localhost');
  return new URL(rawUrl, `http://${host}`);
}

/**
 * Main bootstrap to register plugins and routes.
 */
async function main() {
  // Register websocket plugin (awaited inside main)
  await server.register(websocketPlugin);

  // Setup Redis and BullMQ queue
  const redisUrl = process.env.REDIS_URL!;
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const queue = new Queue('orders', { connection: redis });

  // POST /api/orders/execute
  server.post('/api/orders/execute', async (req, reply) => {
    try {
      const body = req.body as any;
      if (!body?.token_in || !body?.token_out || !body?.amount_in) {
        return reply.status(400).send({ error: 'token_in, token_out, amount_in required' });
      }

      const id = uuidv4();
      await insertOrder({
        id,
        user_id: body.user_id ?? null,
        type: body.type ?? 'market',
        token_in: body.token_in,
        token_out: body.token_out,
        amount_in: body.amount_in.toString(),
        slippage: body.slippage ?? 1.0
      });

      // create WS token
      const wsToken = createWsToken(id);

      // enqueue with BullMQ
      await queue.add('execute', {
        orderId: id,
        token_in: body.token_in,
        token_out: body.token_out,
        amount_in: body.amount_in.toString(),
        slippage: body.slippage ?? 1.0
      }, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: true,
      });

      return reply.send({ orderId: id, wsToken, wsUrl: `/ws?token=${encodeURIComponent(wsToken)}` });
    } catch (err: any) {
      server.log.error({err}, 'execute route error');
      return reply.status(500).send({ error: 'internal_error' });
    }
  });

  // Websocket endpoint - clients connect with ws://host/ws?token=<token>
  // Note: handler receives either a SocketStream-like object with `.socket` OR the raw WebSocket.
  server.get('/ws', { websocket: true }, (connection: any, req: any) => {
    // Support both shapes:
    // - connection.socket (SocketStream from @fastify/websocket)
    // - connection itself is the WebSocket (raw ws.WebSocket)
    const ws = connection?.socket ?? connection;

    // Defensive: if shape unexpected, log and return early
    if (!ws || typeof ws.on !== 'function') {
      server.log.error({ connectionShape: Object.keys(connection ?? {}) }, 'Invalid websocket connection object - missing .on');
      return;
    }

    // Build the URL safely (fixes TS2345)
    const url = buildRequestUrl(req);
    const token = url.searchParams.get('token') ?? null;

    // Client can also send JSON { action: 'auth', token: '...' }
    let authedOrderId: string | null = null;

    // async message handler to support dynamic import()
    ws.on('message', async (msg: any) => {
      try {
        // msg could be Buffer or string or ArrayBuffer; coerce safely
        const text = (typeof msg === 'string') ? msg : (msg?.toString?.() ?? '');
        let data: any;
        try {
          data = JSON.parse(text);
        } catch {
          // not JSON — ignore or handle raw pings
          return;
        }

        if (data?.action === 'auth' && data?.token) {
          const id = verifyWsToken(data.token);
          if (!id) {
            try { ws.send(JSON.stringify({ error: 'invalid_token' })); } catch {}
            try { ws.close?.(); } catch {}
            return;
          }
          authedOrderId = id;
          // dynamic import to avoid circular dependency at module load
          const mod = await import('./websocket/wsManager.js');
          mod.subscribeSocket(authedOrderId, ws);
          try { ws.send(JSON.stringify({ status: 'subscribed', orderId: authedOrderId })); } catch {}
          server.log.info({ orderId: authedOrderId }, 'ws client subscribed via auth');
          return;
        }

        if (data?.action === 'subscribe' && data?.orderId && data?.token) {
          const id = verifyWsToken(data.token);
          if (!id || id !== data.orderId) {
            try { ws.send(JSON.stringify({ error: 'invalid_token_for_order' })); } catch {}
            return;
          }
          authedOrderId = data.orderId;
          const mod = await import('./websocket/wsManager.js');
          mod.subscribeSocket(authedOrderId!, ws);
          try { ws.send(JSON.stringify({ status: 'subscribed', orderId: authedOrderId })); } catch {}
          server.log.info({ orderId: authedOrderId }, 'ws client subscribed via subscribe message');
          return;
        }

        if (data?.action === 'ping') {
          try { ws.send(JSON.stringify({ action: 'pong' })); } catch {}
          return;
        }
      } catch (e) {
        try { ws.send(JSON.stringify({ error: 'invalid_message' })); } catch {}
      }
    });

    // try immediate token auth from query param (non-blocking)
    (async () => {
      if (token) {
        const id = verifyWsToken(token);
        if (id) {
          authedOrderId = id;
          const mod = await import('./websocket/wsManager.js');
          mod.subscribeSocket(authedOrderId, ws);
          try { ws.send(JSON.stringify({ status: 'subscribed', orderId: authedOrderId })); } catch {}
          server.log.info({ orderId: authedOrderId }, 'ws client subscribed via query token');
        }
      }
    })().catch((e) => server.log.warn({e}, 'ws immediate auth error'));

    ws.on('close', async () => {
      if (authedOrderId) {
        try {
          const mod = await import('./websocket/wsManager.js');
          mod.unsubscribeSocket(authedOrderId, ws);
        } catch (e: any) {
          server.log.warn({e}, 'ws unsubscribe failed');
        }
      }
    });
  });

  // health
  server.get('/health', async () => ({ ok: true }));

  // start listening
  const port = Number(process.env.PORT ?? 3000);
  try {
    await server.listen({ port, host: '0.0.0.0' });
    server.log.info(`server listening on ${port}`);
  } catch (err: any) {
    server.log.error({ err }, 'server failed to start');
    process.exit(1);
  }
}

// bootstrap
main().catch((err) => {
  console.error('fatal server bootstrap error', err);
  process.exit(1);
});
