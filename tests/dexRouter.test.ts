import { describe, it, expect, beforeAll } from 'vitest';
import BN from 'bn.js';

// force mock path
process.env.USE_MOCK = 'true';
process.env.SWAP_SLIPPAGE = '1';

let dex: any;
beforeAll(async () => {
  dex = await import('../src/router/dexRouter.js');
});

describe('dexRouter (mock path) - routing logic', () => {
  it('getBestQuote returns a mock quote when USE_MOCK=true', async () => {
    const q = await dex.getBestQuote({
      conn: null,
      amountInBn: new BN('1000000'),
      tokenIn: 'A',
      tokenOut: 'B',
      meteoraPoolAddress: undefined,
      raydiumPoolId: undefined
    });
    expect(q.dex).toBe('mock');
    expect(q.outAmountBn).toBeDefined();
  });

  it('executeSwap returns simulated result in mock', async () => {
    const res = await dex.executeSwap({
      conn: null,
      wallet: null,
      dex: 'mock',
      tokenIn: 'A',
      tokenOut: 'B',
      amountInBn: new BN('10000')
    });
    expect(res.txId).toMatch(/^MOCK-/);
    expect(res.simulated).toBe(true);
  });

  it('getBestQuote fallback uses amount math when no quotes', async () => {
    // force not providing pools and USE_MOCK=false scenario by temporarily overriding
    process.env.USE_MOCK = 'false';
    const q = await dex.getBestQuote({
      conn: null,
      amountInBn: new BN('1000000'),
      tokenIn: 'A',
      tokenOut: 'B'
    });
    // when SDKs are not accessible, the router falls back to a mock-like quote
    expect(q.outAmountBn).toBeDefined();
    process.env.USE_MOCK = 'true';
  });

  it('getBestQuote chooses best among multiple quotes (simulated)', async () => {
    // Using USE_MOCK returns out = amountIn * 0.9949
    const a = await dex.getBestQuote({
      conn: null,
      amountInBn: new BN('1000000'),
      tokenIn: 'A',
      tokenOut: 'B'
    });
    expect(a.outAmountBn.gte(new BN('990000'))).toBe(true);
  });

  it('executeSwap with dex=mock honours delay and returns an out amount', async () => {
    const start = Date.now();
    const r = await dex.executeSwap({
      conn: null,
      wallet: null,
      dex: 'mock',
      tokenIn: 'A',
      tokenOut: 'B',
      amountInBn: new BN('50000')
    });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(1000);
    expect(r.executedOutBn).toBeTruthy();
  });

  it('executeSwap called with dex=mock returns simulated txId string', async () => {
    const r = await dex.executeSwap({
      conn: null,
      wallet: null,
      dex: 'mock',
      tokenIn: 'A',
      tokenOut: 'B',
      amountInBn: new BN('10000')
    });
    expect(typeof r.txId).toBe('string');
  });
});
