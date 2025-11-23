// src/config.ts
import 'dotenv/config'
import { Keypair, Connection, PublicKey } from '@solana/web3.js'

/**
 * Demo config for DEVNET with helper initSdk()
 *
 * - Reads WALLET_PRIVATE_KEY_JSON from .env (JSON array)
 * - Exports BASE_MINT / QUOTE_MINT as PublicKey
 * - Exports BASE_HUMAN / QUOTE_HUMAN (strings)
 * - Exports initSdk(connection+owner loader) for the demo scripts
 * - Exports txVersion
 */

/* -------- Network and RPC -------- */
export const NETWORK = 'devnet'
export const RPC_URL = process.env.SOLANA_RPC || 'https://api.devnet.solana.com'

/* -------- Wallet loading helper -------- */
function getWalletSecret(): number[] {
  const raw = process.env.WALLET_PRIVATE_KEY_JSON
  if (!raw) {
    throw new Error(
      'WALLET_PRIVATE_KEY_JSON not set in environment. Put your secret key array in .env'
    )
  }
  try {
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) throw new Error('WALLET_PRIVATE_KEY_JSON must be a JSON array')
    return arr
  } catch (e) {
    throw new Error(`Failed to parse WALLET_PRIVATE_KEY_JSON: ${String(e)}`)
  }
}

export const WALLET_SECRET_KEY: number[] = getWalletSecret()
export const WALLET_KEYPAIR = Keypair.fromSecretKey(Uint8Array.from(WALLET_SECRET_KEY))

/* -------- Your token config (update if you want other mints/amounts) -------- */
// These are your mints (already provided earlier)
export const BASE_MINT = new PublicKey('6n8Bkmfg1szhfLknyPLu3MfK6L8BxvQYdNYX9m9gJsqY')
export const QUOTE_MINT = new PublicKey('DZkw6Nm9GagPnnZUoMYo3wD3Cgb7ZNY4eqYWPmn9Hgnn')

// Human amounts computed earlier (both mints have 6 decimals -> base units 1_000_000_000 => 1000 human)
export const BASE_HUMAN = '1000'
export const QUOTE_HUMAN = '1000'

/* -------- txVersion (common demo expectation) -------- */
export const txVersion = 'V0'

/* -------- initSdk helper --------
   Dynamically imports the Raydium SDK and returns a loaded sdk instance.
   This mirrors what demo scripts expect (connection + owner + helpers).
*/
export async function initSdk(options?: { loadToken?: boolean }) {
  // dynamic import so demo works both in CJS/ESM setups
  const { default: raydiumAll, Raydium, load } = (await import('@raydium-io/raydium-sdk-v2')) as any

  const connection = new Connection(RPC_URL, 'confirmed')

  // determine loader
  let sdk: any = null
  // prefer Raydium.load if available
  if (Raydium?.load) {
    sdk = await Raydium.load({
      connection,
      owner: WALLET_KEYPAIR,
      cluster: NETWORK,
      loadToken: options?.loadToken ?? true,
    })
  } else if (load) {
    sdk = await load({ connection, owner: WALLET_KEYPAIR, cluster: NETWORK })
  } else if (raydiumAll?.load) {
    sdk = await raydiumAll.load({ connection, owner: WALLET_KEYPAIR, cluster: NETWORK })
  } else {
    // fallback: export the raw module as sdk-like (some repo variants export differently)
    sdk = raydiumAll || { _connection: connection, owner: WALLET_KEYPAIR }
  }

  return sdk
}

/* Optional debug helper */
export function printConfigSummary() {
  console.log('=== CONFIG SUMMARY ===')
  console.log('NETWORK:', NETWORK)
  console.log('RPC_URL:', RPC_URL)
  console.log('WALLET:', WALLET_KEYPAIR.publicKey.toBase58())
  console.log('BASE_MINT:', BASE_MINT.toBase58())
  console.log('QUOTE_MINT:', QUOTE_MINT.toBase58())
  console.log('BASE_HUMAN:', BASE_HUMAN)
  console.log('QUOTE_HUMAN:', QUOTE_HUMAN)
  console.log('txVersion:', txVersion)
  console.log('======================')
}
