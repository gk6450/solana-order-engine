// scripts/create-meteora-pool.ts
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
  console.log('Wallet:', wallet.publicKey.toBase58());

  const tokenAMint = new PublicKey(process.env.USDC_DEV_MINT!);
  const tokenBMint = new PublicKey(process.env.TEST_DEV_MINT!);
  const tokenAAmount = new BN(process.env.TOKEN_A_AMOUNT_BASE_UNITS!);
  const tokenBAmount = new BN(process.env.TOKEN_B_AMOUNT_BASE_UNITS!);

  const stableFlag = (process.env.POOL_TYPE ?? 'volatile') === 'stable';

  // 1) fetch valid fee configs from SDK
  console.log('Fetching fee configurations from SDK...');
  let feeConfigs: any[] = [];
  try {
    // pass programId if available
    const programIdStr = (MeteoraPkg as any)?.PROGRAM_ID ?? process.env.METEORA_PROGRAM_ID;
    const programIdArg = programIdStr ? { programId: programIdStr } : {};
    feeConfigs = await AmmImpl.getFeeConfigurations(conn, programIdArg);
    console.log('Found', (feeConfigs || []).length, 'fee configurations');
  } catch (err) {
    console.warn('getFeeConfigurations failed:', (err as any).message ?? err);
  }

  // 2) choose a fee - prefer a public config (pool_creator_authority === 111...),
  // otherwise take first available feeBps
  let tradeFeeBps: BN | null = null;
  if (Array.isArray(feeConfigs) && feeConfigs.length > 0) {
    // find public config first
    const pubConfig = feeConfigs.find((c: any) => {
      try {
        const creator = c.pool_creator_authority?.toString?.() ?? c.pool_creator_authority;
        return creator === '11111111111111111111111111111111';
      } catch {
        return false;
      }
    });
    const chosen = pubConfig ?? feeConfigs[0];
    // The SDK returns tradeFeeBps (d.ts indicates it's a BN)
    tradeFeeBps = chosen.tradeFeeBps ?? chosen.trade_fee_bps ?? chosen.trade_fee_bps_bn ?? null;
    if (!tradeFeeBps) {
      // try the numeric field
      const nf = chosen.trade_fee_bps ?? chosen.trade_fee_bps_value ?? chosen.tradeFeeBps;
      tradeFeeBps = nf ? new BN(Number(nf)) : null;
    }
    console.log('Selected tradeFeeBps from config:', tradeFeeBps?.toString?.() ?? tradeFeeBps);
  }

  // fallback: pick a conservative known allowed value if none found (example: 25 -> 0.25%)
  if (!tradeFeeBps) {
    console.warn('No fee configs found; falling back to 25 (0.25%)');
    tradeFeeBps = new BN(25);
  }

  // 3) call createPermissionlessPool using the valid tradeFeeBps
  if (typeof AmmImpl.createPermissionlessPool !== 'function') {
    throw new Error('AmmImpl.createPermissionlessPool not available in installed SDK.');
  }

  const tx = await AmmImpl.createPermissionlessPool(
    conn,
    wallet.publicKey,
    tokenAMint,
    tokenBMint,
    tokenAAmount,
    tokenBAmount,
    stableFlag,
    tradeFeeBps
  );

  // handle return shapes (Transaction or array/object)
  if (Array.isArray(tx)) {
    for (const t of tx) {
      t.sign(wallet);
      const sig = await conn.sendRawTransaction(t.serialize());
      console.log('submitted tx', sig);
      await conn.confirmTransaction(sig, 'confirmed');
    }
  } else if (tx?.serialize) {
    tx.sign(wallet);
    const sig = await conn.sendRawTransaction(tx.serialize());
    console.log('submitted tx', sig);
    await conn.confirmTransaction(sig, 'confirmed');
  } else if (Array.isArray(tx?.transactions)) {
    for (const t of tx.transactions) {
      t.sign(wallet);
      const sig = await conn.sendRawTransaction(t.serialize());
      console.log('submitted tx', sig);
      await conn.confirmTransaction(sig, 'confirmed');
    }
  } else {
    console.log('Returned create value shape:', tx);
    throw new Error('Unexpected return shape; paste it if you want me to adapt the script.');
  }

  console.log('Pool created (simple path with valid fee).');
}

main().catch((e) => { console.error('fatal:', e); process.exit(1); });
