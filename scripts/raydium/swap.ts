// src/cpmm/swap.ts (updated)
// Demo swap script adapted to use your created CPMM pool and human-readable inputs.
// Usage:
//   - Ensure raydium-sdk-V2-demo/.env contains WALLET_PRIVATE_KEY_JSON and SOLANA_RPC
//   - Optional: set POOL_ID, SWAP_IN_HUMAN, SWAP_SLIPPAGE in .env
//   - Run: npx ts-node src/cpmm/swap.ts

import 'dotenv/config'
import {
  ApiV3PoolInfoStandardItemCpmm,
  CpmmKeys,
  CpmmParsedRpcData,
  CurveCalculator,
  FeeOn,
  printSimulate,
  TxVersion,
} from '@raydium-io/raydium-sdk-v2'
import { initSdk } from '../config'
import BN from 'bn.js'
import { getMint } from '@solana/spl-token'
import { PublicKey } from '@solana/web3.js'

// Defaults (replace POOL_ID in .env or let it fallback)
const DEFAULT_POOL_ID = '2qN6ZrdHcDHP9cQtVxTS7C98F44KfuDN5Ni8oPTgJuU1'
const poolIdEnv = process.env.POOL_ID || DEFAULT_POOL_ID
const SWAP_IN_HUMAN = process.env.SWAP_IN_HUMAN || '0.1' // human amount of input token
const SLIPPAGE_PERCENT = Number(process.env.SWAP_SLIPPAGE ?? '1.0') // percent

function humanToBaseUnitsBN(humanStr: string, decimals: number) {
  // Convert "12.345" into BN base units using decimals
  const parts = humanStr.split('.')
  const intPart = parts[0] || '0'
  const fracPart = parts[1] || ''
  const factor = new BN(10).pow(new BN(decimals))
  let bn = new BN(intPart).mul(factor)
  if (fracPart.length > 0) {
    const padded = (fracPart + '0'.repeat(decimals)).slice(0, decimals)
    bn = bn.add(new BN(padded))
  }
  return bn
}

export const swapTest = async () => {
  const raydium = await initSdk({ loadToken: true })
  // devnet path: use getPoolInfoFromRpc which returns poolInfo, poolKeys, rpcData
  const poolId = poolIdEnv
  let poolInfo: ApiV3PoolInfoStandardItemCpmm
  let poolKeys: CpmmKeys | undefined
  let rpcData: CpmmParsedRpcData

  if ((raydium as any).cluster === 'mainnet') {
    const data = await (raydium as any).api.fetchPoolById({ ids: poolId })
    poolInfo = data[0] as ApiV3PoolInfoStandardItemCpmm
    if (!poolInfo) throw new Error('Could not load pool info (mainnet path)')
    rpcData = await (raydium as any).cpmm.getRpcPoolInfo(poolInfo.id, true)
  } else {
    const data = await (raydium as any).cpmm.getPoolInfoFromRpc(poolId)
    if (!data || !data.poolInfo) throw new Error('Could not load pool info from RPC for poolId: ' + poolId)
    poolInfo = data.poolInfo as ApiV3PoolInfoStandardItemCpmm
    poolKeys = data.poolKeys as CpmmKeys
    rpcData = data.rpcData as CpmmParsedRpcData
  }

  // Ensure poolInfo loaded
  if (!poolInfo) throw new Error('Could not load pool info for poolId: ' + poolId)

  // Determine base/quote mints
  const baseMintAddress = poolInfo.mintA.address
  const quoteMintAddress = poolInfo.mintB.address

  // get on-chain decimals for base mint (safe fallback)
  const connection = (raydium as any)._connection ?? (raydium as any).connection
  if (!connection) throw new Error('Connection not available from SDK')

  const baseMintPub = new PublicKey(baseMintAddress)
  const quoteMintPub = new PublicKey(quoteMintAddress)
  const baseMintOnchain = await getMint(connection, baseMintPub)
  const quoteMintOnchain = await getMint(connection, quoteMintPub)

  const decimals = Number(baseMintOnchain.decimals ?? 6)

  // input is base token (mintA) by default
  const inputAmountBN = humanToBaseUnitsBN(SWAP_IN_HUMAN, decimals)

  // compute swap result using CurveCalculator.swapBaseInput (same as reference)
  const baseIn = true // swapping mintA -> mintB
  const swapResult = CurveCalculator.swapBaseInput(
    inputAmountBN,
    baseIn ? rpcData.baseReserve : rpcData.quoteReserve,
    baseIn ? rpcData.quoteReserve : rpcData.baseReserve,
    rpcData.configInfo!.tradeFeeRate,
    rpcData.configInfo!.creatorFeeRate,
    rpcData.configInfo!.protocolFeeRate,
    rpcData.configInfo!.fundFeeRate,
    rpcData.feeOn === FeeOn.BothToken || rpcData.feeOn === FeeOn.OnlyTokenB
  )

  console.log('swap result (BNs):', {
    inputAmount: swapResult.inputAmount.toString(),
    outputAmount: swapResult.outputAmount.toString(),
    tradeFee: swapResult.tradeFee.toString(),
  })

  // call cpmm.swap with the pool-style parameters used by the reference
  const { execute, transaction } = await (raydium as any).cpmm.swap({
    poolInfo,
    poolKeys,
    inputAmount: inputAmountBN,
    swapResult,
    slippage: SLIPPAGE_PERCENT / 100, // as decimal
    baseIn,
    txVersion: TxVersion.V0,
  })

  // show simulated transaction(s)
  printSimulate([transaction])

  // execute & confirm
  const { txId } = await execute({ sendAndConfirm: true })
  console.log(`swapped: ${poolInfo.mintA.symbol} -> ${poolInfo.mintB.symbol}`)
  console.log('tx:', `https://explorer.solana.com/tx/${txId}?cluster=devnet`)
}

if (require.main === module) {
  swapTest().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
