import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmRawTransaction } from '@solana/web3.js';
import {
  createWrappedNativeAccount,
  closeAccount,
  NATIVE_MINT,
  getAccount,
  createSyncNativeInstruction
} from '@solana/spl-token';

/**
 * Wrap native SOL into a temporary WSOL token account.
 * - conn: Connection
 * - payer: Keypair paying fees (your wallet)
 * - owner: PublicKey who will own the token account (usually wallet.publicKey)
 * - lamports: number of lamports to wrap
 *
 * Returns { tokenAccountPubkey: PublicKey, cleanup: async ()=>void }
 */
export async function wrapSOLAndGetCleanup(conn: Connection, payer: Keypair, owner: PublicKey, lamports: number) {
  // createWrappedNativeAccount will create a new token account for NATIVE_MINT and fund it
  const tokenAccountPub = await createWrappedNativeAccount(conn, payer, owner, lamports);
  // createWrappedNativeAccount usually returns PublicKey
  // Cleanup function closes the account and recovers SOL to owner
  async function cleanup() {
    try {
      await closeAccount(conn, payer, tokenAccountPub, owner, payer);
    } catch (err) {
      console.warn('closeAccount failed during cleanup', err);
      // best effort
    }
  }
  return { tokenAccount: tokenAccountPub, cleanup };
}

export const WSOL_MINT = NATIVE_MINT.toBase58();
