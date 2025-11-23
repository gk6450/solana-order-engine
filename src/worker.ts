import dotenv from 'dotenv';
dotenv.config();
import {Redis} from 'ioredis';
import { Worker } from 'bullmq';
import { Connection, Keypair } from '@solana/web3.js';
import BN from 'bn.js';
import { getBestQuote, executeSwap } from './router/dexRouter.js';
import { publishOrderUpdate } from './websocket/wsManager.js';
import { updateOrderStatus, setRoutingInfo } from './config/db.js';

const redisUrl = process.env.REDIS_URL!;
const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });

console.info(`[worker] starting worker (orders)`, { redisUrl: redisUrl ? 'provided' : 'missing' });

const worker = new Worker('orders', async (job) => {
  const data = job.data as any;
  const { orderId, token_in, token_out, amount_in, slippage } = data;

  console.info(`[worker] job received`, {
    jobId: job.id,
    attemptsMade: job.attemptsMade,
    orderId,
    token_in,
    token_out,
    amount_in,
    slippage
  });

  try {
    // publish queued/pending
    console.info(`[worker:${orderId}] publishing pending`);
    await publishOrderUpdate(orderId, { orderId, status: 'pending', timestamp: new Date().toISOString(), meta: { message: 'queued' } });
    await updateOrderStatus(orderId, 'pending');

    const conn = new Connection(process.env.SOLANA_RPC || 'https://api.devnet.solana.com', 'confirmed');
    const raw = JSON.parse(process.env.WALLET_PRIVATE_KEY_JSON!);
    const wallet = Keypair.fromSecretKey(new Uint8Array(raw));

    const amountBn = new BN(amount_in.toString());

    console.info(`[worker:${orderId}] querying DEX quotes`, { amountBn: amountBn.toString(), token_in, token_out });
    await publishOrderUpdate(orderId, { orderId, status: 'routing', timestamp: new Date().toISOString(), meta: { message: 'querying dex quotes' }});

    const quote = await getBestQuote({
      conn,
      amountInBn: amountBn,
      tokenIn: token_in,
      tokenOut: token_out,
      meteoraPoolAddress: process.env.POOL_ADDRESS,
      raydiumPoolId: process.env.POOL_ID
    });

    console.info(`[worker:${orderId}] quote received`, {
      chosenDex: quote.dex,
      estimatedOut: quote.outAmountBn.toString(),
      details: quote.details
    });

    // record routing info & move to building/routing state
    await setRoutingInfo(orderId, { chosen: quote.dex, estimatedOut: quote.outAmountBn.toString(), details: quote.details });
    await publishOrderUpdate(orderId, { orderId, status: 'building', dex: quote.dex, meta: { quote: quote.outAmountBn.toString() }});
    await updateOrderStatus(orderId, 'routing');

    // attempt execution
    try {
      console.info(`[worker:${orderId}] submitting to DEX`, { dex: quote.dex });
      await publishOrderUpdate(orderId, { orderId, status: 'submitted', meta: { dex: quote.dex }});

      const res = await executeSwap({
        conn,
        wallet,
        dex: quote.dex,
        tokenIn: token_in,
        tokenOut: token_out,
        amountInBn: amountBn,
        slippagePercent: Number(slippage ?? 1.0),
        meteoraPoolAddress: process.env.POOL_ADDRESS,
        raydiumPoolId: process.env.POOL_ID
      });

      console.info(`[worker:${orderId}] execution result`, {
        txId: res.txId,
        executedOutBn: res.executedOutBn?.toString?.() ?? null,
        dex: res.dex,
        simulated: !!res.simulated
      });

      await publishOrderUpdate(orderId, { orderId, status: 'confirmed', txHash: res.txId, executedOut: res.executedOutBn?.toString?.() ?? null });
      await updateOrderStatus(orderId, 'confirmed', {
        attemptsDelta: 0,
        txHash: res.txId ?? null,
        executedPrice: res.executedOutBn ? Number(res.executedOutBn.toString()) : null,
        routing: { chosen: quote.dex }
      });

      console.info(`[worker:${orderId}] job complete`, { jobId: job.id });
      return { ok: true };
    } catch (err) {
      // publish failure and let BullMQ decide retry (attempts configured by enqueue)
      console.error(`[worker:${orderId}] execution failed`, { error: String(err), stack: (err as any)?.stack, attemptsMade: job.attemptsMade });
      await publishOrderUpdate(orderId, { orderId, status: 'failed', error: String(err) });
      await updateOrderStatus(orderId, 'failed', { attemptsDelta: 1, error: String(err) });
      throw err;
    }
  } catch (outerErr) {
    // unexpected outer error
    console.error(`[worker] fatal job error`, { jobId: job.id, error: String(outerErr), stack: (outerErr as any)?.stack });
    // ensure the job fails so BullMQ can retry / move to failed
    throw outerErr;
  }
}, { connection, concurrency: 10 });

// Worker event listeners for visibility
worker.on('active', (job) => {
  console.info(`[worker:event] job active`, { jobId: job?.id, name: job?.name, attemptsMade: job?.attemptsMade });
});
worker.on('completed', (job) => {
  console.info(`[worker:event] job completed`, { jobId: job?.id });
});
worker.on('failed', (job, err) => {
  console.error(`[worker:event] job failed`, { jobId: job?.id, error: String(err), stack: (err as any)?.stack });
});
worker.on('error', (err) => {
  console.error(`[worker:event] worker error`, { error: String(err), stack: (err as any)?.stack });
});
worker.on('stalled', (job: any) => {
  console.warn(`[worker:event] job stalled`, { jobId: job?.id });
});

console.log('Worker started (orders)');
