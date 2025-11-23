import {Redis} from 'ioredis';
import WebSocket from 'ws';

const redisUrl = process.env.REDIS_URL!;
export const pub = new Redis(redisUrl);
export const sub = new Redis(redisUrl);

console.info('[wsManager] Redis pub/sub clients created', { redisUrl: redisUrl ? 'provided' : 'missing' });

// in-memory map orderId -> Set<ws>
const subscribers = new Map<string, Set<WebSocket>>();

// Subscribe to Redis channel and log subscribe/unsubscribe events
sub.on('subscribe', (channel, count) => {
  console.info('[wsManager:redis] subscribed to channel', { channel, subscribersCount: count });
});
sub.on('unsubscribe', (channel, count) => {
  console.info('[wsManager:redis] unsubscribed from channel', { channel, subscribersCount: count });
});
sub.on('error', (err) => {
  console.error('[wsManager:redis] subscriber error', { error: String(err), stack: (err as any)?.stack });
});
pub.on('error', (err) => {
  console.error('[wsManager:redis] publisher error', { error: String(err), stack: (err as any)?.stack });
});

export function subscribeSocket(orderId: string, ws: WebSocket) {
  let set = subscribers.get(orderId);
  if (!set) {
    set = new Set();
    subscribers.set(orderId, set);
    sub.subscribe(`order:${orderId}`)
      .then(() => console.info('[wsManager] subscribed Redis channel for order', { orderId }))
      .catch((e) => console.error('[wsManager] Redis subscribe failed', { orderId, error: String(e) }));
  }
  set.add(ws);
  console.info('[wsManager] socket subscribed', { orderId, currentSubscribers: set.size });
}

export function unsubscribeSocket(orderId: string, ws: WebSocket) {
  const set = subscribers.get(orderId);
  if (!set) {
    console.warn('[wsManager] unsubscribe called for unknown orderId', { orderId });
    return;
  }
  set.delete(ws);
  console.info('[wsManager] socket unsubscribed', { orderId, remainingSubscribers: set.size });
  if (set.size === 0) {
    subscribers.delete(orderId);
    sub.unsubscribe(`order:${orderId}`)
      .then(() => console.info('[wsManager] Redis unsubscribed channel for order', { orderId }))
      .catch((e) => console.error('[wsManager] Redis unsubscribe failed', { orderId, error: String(e) }));
  }
}

export async function publishOrderUpdate(orderId: string, payload: any) {
  const channel = `order:${orderId}`;
  try {
    const message = JSON.stringify(payload);
    // keep a small debug log and publish
    console.debug('[wsManager] publishing update', { orderId, payloadSummary: { status: payload.status, txHash: payload.txHash } });
    const subscribersCount = await pub.publish(channel, message);
    console.info('[wsManager] publish result', { channel, publishedToSubscribers: subscribersCount, payloadStatus: payload.status });
  } catch (e) {
    console.error('[wsManager] publishOrderUpdate failed', { orderId, error: String(e), stack: (e as any)?.stack });
    throw e;
  }
}

// Relay messages from Redis to websocket subscribers
sub.on('message', (channel, message) => {
  try {
    if (!channel.startsWith('order:')) return;
    const id = channel.split(':')[1];
    const set = subscribers.get(id);
    if (!set) {
      console.debug('[wsManager] message for order with no subscribers', { orderId: id, message });
      return;
    }
    console.info('[wsManager] relaying message to local subscribers', { orderId: id, subscribers: set.size });
    for (const ws of Array.from(set)) {
      try {
        if (ws.readyState === ws.OPEN) ws.send(message);
      } catch (e) {
        console.warn('[wsManager] ws send failed', { orderId: id, error: String(e) });
      }
    }
  } catch (e) {
    console.error('[wsManager] error in message handler', { error: String(e), stack: (e as any)?.stack });
  }
});

console.info('[wsManager] manager initialized');
