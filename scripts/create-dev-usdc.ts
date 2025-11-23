// scripts/create-dev-usdc.ts
import dotenv from "dotenv";
dotenv.config();
import { Connection, Keypair } from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";

function loadKeypair(): Keypair {
  const raw = process.env.WALLET_PRIVATE_KEY_JSON;
  if (!raw) throw new Error("WALLET_PRIVATE_KEY_JSON missing in .env");
  const arr = JSON.parse(raw);
  return Keypair.fromSecretKey(new Uint8Array(arr));
}

async function main() {
  const conn = new Connection(process.env.SOLANA_RPC || "https://api.devnet.solana.com", "confirmed");
  const payer = loadKeypair();
  console.log("Payer:", payer.publicKey.toBase58());

  const decimals = 6; // USDC-like
  console.log("Creating new mint (USDC-dev) with", decimals, "decimals...");
  const mint = await createMint(conn, payer, payer.publicKey, null, decimals);
  console.log("Created mint:", mint.toBase58());

  const ata = await getOrCreateAssociatedTokenAccount(conn, payer, mint, payer.publicKey);
  console.log("Payer ATA:", ata.address.toBase58());

  const humanAmount = 1_000_000;
  const amountBaseUnits = BigInt(humanAmount) * BigInt(10 ** decimals); // 1_000_000 base units = 1e6 base units
  // For clarity: amountBaseUnits represents "base units" (tokenDecimals aware).
  console.log(`Minting ${amountBaseUnits.toLocaleString()} base units to ATA...`);
  const sig = await mintTo(conn, payer, mint, ata.address, payer, BigInt(amountBaseUnits));
  console.log("Mint tx:", sig);

  console.log("Save this USDC mint address in your .env as USDC_DEV_MINT:");
  console.log("USDC_DEV_MINT=", mint.toBase58());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
