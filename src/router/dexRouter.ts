import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import BN from 'bn.js';
import { WSOL_MINT, wrapSOLAndGetCleanup } from '../utils/solanaHelpers.js';
import * as MeteoraPkg from '@meteora-ag/dynamic-amm-sdk';
import { initSdk } from '../config/config.js';
import { createWrappedNativeAccount } from '@solana/spl-token';

type Quote = { dex: 'meteora'|'raydium'|'mock', outAmountBn: BN, details: any };

const AmmImpl: any = (MeteoraPkg as any).AmmImpl ?? (MeteoraPkg as any).default?.AmmImpl ?? (MeteoraPkg as any).default;

function envUseMock() {
  return (process.env.USE_MOCK ?? 'false').toLowerCase() === 'true';
}

/** Query Meteora (real) for a quote */
export async function getMeteoraQuote(conn: Connection, poolAddress: string, inputMint: string, amountInBn: BN): Promise<Quote> {
  console.debug('[dexRouter] getMeteoraQuote start', { poolAddress, inputMint, amountInBn: amountInBn.toString() });
  if (!AmmImpl) throw new Error('Meteora SDK (AmmImpl) not available');
  const poolPub = new PublicKey(poolAddress);
  const amm = await AmmImpl.create(conn, poolPub);
  const inputMintPub = new PublicKey(inputMint);
  // Note: getSwapQuote may throw if pool token shape unexpected; wrap for logging
  let quote: any;
  try {
    quote = amm.getSwapQuote(inputMintPub, amountInBn, Number(process.env.SWAP_SLIPPAGE ?? 0.5));
  } catch (e) {
    console.warn('[dexRouter] meteora getSwapQuote failed', String(e));
    throw e;
  }
  const outBn = new BN(quote.swapOutAmount.toString());
  console.info('[dexRouter] meteora quote', { poolAddress, inputMint, amountInBn: amountInBn.toString(), outBn: outBn.toString(), fee: quote.fee?.toString?.(), minOut: quote.minSwapOutAmount?.toString?.() });
  return {
    dex: 'meteora',
    outAmountBn: outBn,
    details: { fee: quote.fee?.toString?.(), minOut: quote.minSwapOutAmount?.toString?.(), raw: quote }
  };
}

/** Query Raydium (real) for a quote */
export async function getRaydiumQuote(conn: Connection, poolId: string, inputMint: string, amountInBn: BN): Promise<Quote> {
  console.debug('[dexRouter] getRaydiumQuote start', { poolId, inputMint, amountInBn: amountInBn.toString() });

  // use initSdk from your raydium demo config
  const raydium = await initSdk({ loadToken: true });
  // devnet path: cpmm.getPoolInfoFromRpc
  const data = await (raydium as any).cpmm.getPoolInfoFromRpc(poolId);
  const poolInfo = data.poolInfo;
  const rpcData = data.rpcData;
  console.debug('[dexRouter] raydium rpcData snapshot', {
    poolId,
    baseReserve: rpcData?.baseReserve?.toString?.() ?? rpcData?.baseReserve,
    quoteReserve: rpcData?.quoteReserve?.toString?.() ?? rpcData?.quoteReserve,
    configInfo: rpcData?.configInfo
  });

  // Decide which side is base/quote for input mint
  const baseMint = poolInfo.mintA.address;
  const quoteMint = poolInfo.mintB.address;
  const baseIn = (inputMint === baseMint);
  // Calculate swap result using CurveCalculator.swapBaseInput
  const CurveCalculator = (raydium as any).cpmm?.CurveCalculator ?? (raydium as any).CurveCalculator ?? (raydium as any).cpmm?.curveCalculator ?? (raydium as any).curveCalculator;
  if (!CurveCalculator || typeof CurveCalculator.swapBaseInput !== 'function') {
    console.warn('[dexRouter] CurveCalculator.swapBaseInput not available; using fallback for quote', { poolId });
    // fallback naive 1:1-ish estimate: amountIn * reserveOut / (reserveIn + amountIn) minus fee approximation
    try {
      const reserveInRaw = baseIn ? rpcData.baseReserve : rpcData.quoteReserve;
      const reserveOutRaw = baseIn ? rpcData.quoteReserve : rpcData.baseReserve;
      const reserveIn = new BN(reserveInRaw.toString());
      const reserveOut = new BN(reserveOutRaw.toString());
      const numerator = amountInBn.mul(reserveOut);
      const denom = reserveIn.add(amountInBn);
      const rawOut = numerator.div(denom);
      const feeRate = Number(rpcData?.configInfo?.tradeFeeRate ?? 0) / 1e4;
      const afterFee = rawOut.mul(new BN(Math.round((1 - feeRate) * 100000))).div(new BN(100000));
      console.info('[dexRouter] raydium fallback quote', { poolId, out: afterFee.toString() });
      return { dex: 'raydium', outAmountBn: afterFee, details: { fallback: true, rpcDataSnapshot: { reserveInRaw, reserveOutRaw, feeRate } } };
    } catch (ee) {
      console.warn('[dexRouter] raydium fallback failed', String(ee));
      return { dex: 'raydium', outAmountBn: amountInBn, details: { fallback: true, error: String(ee) } };
    }
  }

  // Use CurveCalculator if available
  let swapResult: any;
  try {
    swapResult = CurveCalculator.swapBaseInput(
      amountInBn,
      baseIn ? rpcData.baseReserve : rpcData.quoteReserve,
      baseIn ? rpcData.quoteReserve : rpcData.baseReserve,
      rpcData.configInfo!.tradeFeeRate,
      rpcData.configInfo!.creatorFeeRate,
      rpcData.configInfo!.protocolFeeRate,
      rpcData.configInfo!.fundFeeRate,
      rpcData.feeOn === ((raydium as any).FeeOn ?? {})?.BothToken || rpcData.feeOn === ((raydium as any).FeeOn ?? {})?.OnlyTokenB
    );
  } catch (e) {
    console.warn('[dexRouter] CurveCalculator.swapBaseInput threw', String(e), { poolId });
    // fall back to simple estimate as above
    const reserveInRaw = baseIn ? rpcData.baseReserve : rpcData.quoteReserve;
    const reserveOutRaw = baseIn ? rpcData.quoteReserve : rpcData.baseReserve;
    const reserveIn = new BN(reserveInRaw.toString());
    const reserveOut = new BN(reserveOutRaw.toString());
    const numerator = amountInBn.mul(reserveOut);
    const denom = reserveIn.add(amountInBn);
    const rawOut = numerator.div(denom);
    const feeRate = Number(rpcData?.configInfo?.tradeFeeRate ?? 0) / 1e4;
    const afterFee = rawOut.mul(new BN(Math.round((1 - feeRate) * 100000))).div(new BN(100000));
    console.info('[dexRouter] raydium fallback after calculator throw', { poolId, out: afterFee.toString() });
    return { dex: 'raydium', outAmountBn: afterFee, details: { fallbackAfterThrow: true, rpcDataSnapshot: { reserveInRaw, reserveOutRaw, feeRate } } };
  }

  console.info('[dexRouter] raydium quote', { poolId, inputMint, amountInBn: amountInBn.toString(), outAmountBn: swapResult.outputAmount.toString() });
  return { dex: 'raydium', outAmountBn: swapResult.outputAmount, details: { swapResult } };
}

/** Top-level: query both DEXes and return the best quote */
export async function getBestQuote(params: {
  conn: Connection;
  amountInBn: BN;
  tokenIn: string;
  tokenOut: string;
  meteoraPoolAddress?: string;
  raydiumPoolId?: string;
}) : Promise<Quote> {
  console.debug('[dexRouter] getBestQuote start', { tokenIn: params.tokenIn, tokenOut: params.tokenOut, amountInBn: params.amountInBn.toString() });
  if (envUseMock()) {
    const out = params.amountInBn.mul(new BN(9949)).div(new BN(10000));
    console.info('[dexRouter] USING MOCK QUOTE', { out: out.toString() });
    return { dex: 'mock', outAmountBn: out, details: { simulated: true } };
  }

  const quotes: Quote[] = [];
  const { conn, meteoraPoolAddress, raydiumPoolId, amountInBn, tokenIn } = params;

  // Query Meteora
  if (meteoraPoolAddress) {
    try {
      const q = await getMeteoraQuote(conn, meteoraPoolAddress, tokenIn, amountInBn);
      console.debug('[dexRouter] got meteora quote', { quoteOut: q.outAmountBn.toString() });
      quotes.push(q);
    } catch (e) {
      console.warn('[dexRouter] meteora quote error', String(e));
    }
  }
  // Query Raydium
  if (raydiumPoolId) {
    try {
      const q = await getRaydiumQuote(conn, raydiumPoolId, tokenIn, amountInBn);
      console.debug('[dexRouter] got raydium quote', { quoteOut: q.outAmountBn.toString() });
      quotes.push(q);
    } catch (e) {
      console.warn('[dexRouter] raydium quote error', String(e));
    }
  }

  // If no quotes found, fallback to mock
  if (quotes.length === 0) {
    const out = amountInBn.mul(new BN(9949)).div(new BN(10000));
    console.warn('[dexRouter] no quotes available, falling back to mock', { amountInBn: amountInBn.toString(), fallbackOut: out.toString() });
    return { dex: 'mock', outAmountBn: out, details: { simulated: true } };
  }

  // log all quotes for transparency
  console.info('[dexRouter] collected quotes', quotes.map(q => ({ dex: q.dex, out: q.outAmountBn.toString(), details: q.details })));

  // choose highest outAmountBn
  quotes.sort((a,b) => {
    const A = BigInt(a.outAmountBn.toString());
    const B = BigInt(b.outAmountBn.toString());
    return A === B ? 0 : (A > B ? -1 : 1);
  });

  const chosen = quotes[0];
  console.info('[dexRouter] selected best quote', { dex: chosen.dex, outAmountBn: chosen.outAmountBn.toString(), details: chosen.details });
  return chosen;
}

/** Execute the swap on the chosen DEX (real path).
 * Returns { txId, executedOutBn, dex }
 */
export async function executeSwap(params: {
  conn: Connection;
  wallet: Keypair;
  dex: 'meteora'|'raydium'|'mock';
  tokenIn: string;
  tokenOut: string;
  amountInBn: BN;
  slippagePercent?: number;
  meteoraPoolAddress?: string;
  raydiumPoolId?: string;
}) : Promise<{txId: string|null, executedOutBn: BN|null, dex: string, simulated?: boolean}> {
  console.debug('[dexRouter] executeSwap start', { dex: params.dex, tokenIn: params.tokenIn, tokenOut: params.tokenOut, amountInBn: params.amountInBn.toString() });

  if (envUseMock() || params.dex === 'mock') {
    await new Promise(r => setTimeout(r, 1200 + Math.random()*800));
    const out = params.amountInBn.mul(new BN(9949)).div(new BN(10000));
    console.info('[dexRouter] mock executeSwap returning', { txId: `MOCK-${Date.now()}`, out: out.toString() });
    return { txId: `MOCK-${Date.now()}`, executedOutBn: out, dex: 'mock', simulated: true };
  }

  // handle WSOL wrap if tokenIn === native SOL
  let cleanupWrapped: (()=>Promise<void>)|null = null;
  let realTokenIn = params.tokenIn;
  try {
    if (params.tokenIn === WSOL_MINT) {
      console.debug('[dexRouter] tokenIn is WSOL mint; no wrap needed');
    } else if (params.tokenIn === 'SOL' || params.tokenIn === undefined) {
      console.info('[dexRouter] wrapping native SOL into WSOL temporarily', { amountLamports: params.amountInBn.toString() });
      const lamports = Number(params.amountInBn.toString()); // user must pass base units as lamports
      const wrapped = await wrapSOLAndGetCleanup(params.conn, params.wallet, params.wallet.publicKey, lamports);
      cleanupWrapped = wrapped.cleanup;
      realTokenIn = wrapped.tokenAccount.toBase58();
      console.info('[dexRouter] wrapped SOL -> temporary token account', { tokenAccount: realTokenIn });
    }

    if (params.dex === 'meteora') {
      if (!params.meteoraPoolAddress) throw new Error('meteoraPoolAddress is required for meteora execution');
      const poolPub = new PublicKey(params.meteoraPoolAddress);
      const amm = await AmmImpl.create(params.conn, poolPub);
      const tokenA = new PublicKey(realTokenIn); // use realTokenIn
      const quote = amm.getSwapQuote(tokenA, params.amountInBn, Number(params.slippagePercent ?? process.env.SWAP_SLIPPAGE ?? 0.5));
      console.info('[dexRouter] Meteora executing swap', { pool: params.meteoraPoolAddress, tokenA: tokenA.toBase58(), quoteSwapInAmount: quote.swapInAmount?.toString?.(), quoteMinSwapOut: quote.minSwapOutAmount?.toString?.() });
      const txOrRes = await amm.swap(params.wallet.publicKey, tokenA, quote.swapInAmount, quote.minSwapOutAmount);
      let txId = null;
      if (txOrRes?.serialize) {
        txOrRes.sign(params.wallet);
        const sig = await params.conn.sendRawTransaction(txOrRes.serialize());
        await params.conn.confirmTransaction(sig, 'confirmed');
        txId = sig;
      } else if (txOrRes?.txId) {
        txId = txOrRes.txId;
      } else if (txOrRes?.execute) {
        const execRes = await txOrRes.execute({ sendAndConfirm: true });
        txId = execRes?.txId ?? execRes?.txIdString ?? null;
      } else {
        txId = `SIM-METEORA-${Date.now()}`;
      }
      const executed = quote.swapOutAmount ? new BN(quote.swapOutAmount.toString()) : null;
      console.info('[dexRouter] Meteora swap complete', { txId, executed: executed?.toString?.() });
      return { txId, executedOutBn: executed, dex: 'meteora' };
    } else {
      // Raydium execution
      const raydium = await initSdk({ loadToken: true });
      const poolId = params.raydiumPoolId!;
      if (!poolId) throw new Error('raydiumPoolId is required for raydium execution');
      const data = await (raydium as any).cpmm.getPoolInfoFromRpc(poolId);
      const poolInfo = data.poolInfo;
      const poolKeys = data.poolKeys;
      const rpcData = data.rpcData;
      console.debug('[dexRouter] raydium execution rpcData snapshot', { poolId, rpcConfig: rpcData?.configInfo, feeOn: rpcData?.feeOn });

      // Find CurveCalculator robustly from several possible exports
      const CurveCalculator = (raydium as any).cpmm?.CurveCalculator ?? (raydium as any).CurveCalculator ?? (raydium as any).cpmm?.curveCalculator ?? (raydium as any).curveCalculator;
      const hasSwapBaseInput = CurveCalculator && typeof CurveCalculator.swapBaseInput === 'function';
      console.debug('[dexRouter] CurveCalculator presence', { hasSwapBaseInput, typeofCurveCalculator: typeof CurveCalculator });

      // Determine base/quote and baseIn using poolInfo addresses
      const baseMintAddress = poolInfo?.mintA?.address ?? poolInfo?.baseMint ?? null;
      if (!baseMintAddress) {
        console.warn('[dexRouter] Raydium poolInfo missing mintA/base info; attempt will continue but may be incorrect', { poolId });
      }
      const baseIn = (realTokenIn === baseMintAddress);
      console.debug('[dexRouter] baseIn decision', { realTokenIn, baseMintAddress, baseIn });

      // compute swapResult: either using CurveCalculator or fallback heuristic
      let swapResult: any = null;
      if (hasSwapBaseInput) {
        try {
          swapResult = CurveCalculator.swapBaseInput(
            params.amountInBn,
            baseIn ? rpcData.baseReserve : rpcData.quoteReserve,
            baseIn ? rpcData.quoteReserve : rpcData.baseReserve,
            rpcData.configInfo?.tradeFeeRate,
            rpcData.configInfo?.creatorFeeRate,
            rpcData.configInfo?.protocolFeeRate,
            rpcData.configInfo?.fundFeeRate,
            rpcData.feeOn === ((raydium as any).FeeOn ?? {})?.BothToken || rpcData.feeOn === ((raydium as any).FeeOn ?? {})?.OnlyTokenB
          );
        } catch (e) {
          console.warn('[dexRouter] CurveCalculator.swapBaseInput threw; falling back', String(e));
          swapResult = null;
        }
      }

      if (!swapResult) {
        // Fallback: simple AMM constant-product approximation (very conservative)
        const reserveIn = baseIn ? new BN(rpcData.baseReserve.toString()) : new BN(rpcData.quoteReserve.toString());
        const reserveOut = baseIn ? new BN(rpcData.quoteReserve.toString()) : new BN(rpcData.baseReserve.toString());
        const feeRate = Number(rpcData.configInfo?.tradeFeeRate ?? 0) / 1e4; // may need scaling depending on SDK shape
        const numerator = params.amountInBn.mul(reserveOut);
        const denom = reserveIn.add(params.amountInBn);
        const rawOut = numerator.div(denom);
        const afterFee = rawOut.mul(new BN(Math.round((1 - feeRate) * 100000))).div(new BN(100000));
        swapResult = {
          outputAmount: afterFee,
          inputAmount: params.amountInBn
        };
        console.warn('[dexRouter] Used fallback AMM estimate for Raydium swap (CurveCalculator missing)', { poolId, fallbackOut: afterFee.toString(), feeRate });
      } else {
        console.info('[dexRouter] Raydium computed swapResult', { poolId, outputAmount: swapResult.outputAmount?.toString?.(), inputAmount: swapResult.inputAmount?.toString?.() });
      }

      // call cpmm.swap as in your demo. Many SDKs accept swapResult as computed.
      const cpmm = (raydium as any).cpmm;
      if (!cpmm || !cpmm.swap) {
        throw new Error('Raydium CPmm.swap method not available on this SDK instance');
      }

      // Use realTokenIn to determine baseIn (already computed)
      console.info('[dexRouter] executing raydium.swap', { poolId, baseIn, amountInBn: params.amountInBn.toString(), swapOutputEstimate: swapResult.outputAmount?.toString?.() });

      const { execute } = await cpmm.swap({
        poolInfo,
        poolKeys,
        inputAmount: params.amountInBn,
        swapResult,
        slippage: (params.slippagePercent ?? Number(process.env.SWAP_SLIPPAGE ?? 1.0)) / 100,
        baseIn,
        txVersion: (raydium as any).TxVersion?.V0 ?? 0
      });

      const execRes = await execute({ sendAndConfirm: true });
      const txId = execRes?.txId ?? execRes?.txid ?? execRes?.signature ?? null;
      const executedOut = swapResult.outputAmount ? (swapResult.outputAmount instanceof BN ? swapResult.outputAmount : new BN(swapResult.outputAmount.toString())) : null;
      console.info('[dexRouter] Raydium swap complete', { poolId, txId, executedOut: executedOut?.toString?.() });
      return { txId, executedOutBn: executedOut, dex: 'raydium' };
    }
  } finally {
    if (cleanupWrapped) {
      await cleanupWrapped().catch(e => console.warn('cleanupWrapped failed', e));
    }
  }
}
