// scripts/meteora-swap-test.ts
import dotenv from 'dotenv';
dotenv.config();
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import * as MeteoraPkg from '@meteora-ag/dynamic-amm-sdk';
import BN from 'bn.js';

const AmmImpl: any = (MeteoraPkg as any).AmmImpl ?? (MeteoraPkg as any).default?.AmmImpl ?? (MeteoraPkg as any).default;

function loadKeypair(): Keypair {
  const raw = process.env.WALLET_PRIVATE_KEY_JSON!;
  const arr = JSON.parse(raw);
  return Keypair.fromSecretKey(new Uint8Array(arr));
}

async function main() {
  const conn = new Connection(process.env.SOLANA_RPC || 'https://api.devnet.solana.com', 'confirmed');
  const wallet = loadKeypair();

  const poolAddr = process.env.POOL_ADDRESS!;
  if (!poolAddr) throw new Error('Set POOL_ADDRESS in .env to the pool you created');
  const poolPubkey = new PublicKey(poolAddr);

  // load AmmImpl instance
  const amm = await AmmImpl.create(conn, poolPubkey);
  console.log('Loaded pool, feeBps:', amm.feeBps?.toString?.());

  // swapping from tokenA -> tokenB
  const tokenA = new PublicKey(process.env.USDC_DEV_MINT!);
  const inHuman = Number(process.env.SWAP_IN_HUMAN ?? 1); // 1 token
  const decimals = Number(process.env.TOKEN_A_DECIMALS ?? 6);
  const inAmount = new BN(Math.floor(inHuman * Math.pow(10, decimals)));

  const quote = amm.getSwapQuote(tokenA, inAmount, Number(process.env.SWAP_SLIPPAGE ?? 0.5));
  console.log('Quote:', {
    swapInAmount: quote.swapInAmount.toString(),
    swapOutAmount: quote.swapOutAmount.toString(),
    minOut: quote.minSwapOutAmount.toString(),
    fee: quote.fee.toString()
  });

  // create tx
  const tx = await amm.swap(wallet.publicKey, tokenA, quote.swapInAmount, quote.minSwapOutAmount);
  tx.sign(wallet);
  const sig = await conn.sendRawTransaction(tx.serialize());
  console.log('Swap tx sig:', sig);
  await conn.confirmTransaction(sig, 'confirmed');
}

main().catch((e) => { console.error(e); process.exit(1); });
