// scripts/create-dev-token.ts
import dotenv from "dotenv";
dotenv.config();
import { Connection, Keypair } from "@solana/web3.js";
import { createMint, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";

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

  const decimals = 6; // match USDC for easy pairing
  console.log("Creating new mint (TEST) with", decimals, "decimals...");
  const mint = await createMint(conn, payer, payer.publicKey, null, decimals);
  console.log("Created mint:", mint.toBase58());

  const ata = await getOrCreateAssociatedTokenAccount(conn, payer, mint, payer.publicKey);
  console.log("Payer ATA:", ata.address.toBase58());

  // Mint 1_000_000 TEST = 1e6 tokens with 6 decimals => 1e6 * 1e6 = 1e12 base units
  const humanAmount = 1_000_000;
  const amountBaseUnits = BigInt(humanAmount) * BigInt(10 ** decimals);
  console.log(`Minting ${humanAmount} TEST (${amountBaseUnits.toString()} base units) to ATA...`);
  const sig = await mintTo(conn, payer, mint, ata.address, payer, amountBaseUnits);
  console.log("Mint tx:", sig);

  console.log("Save this TEST mint address in your .env as TEST_DEV_MINT:");
  console.log("TEST_DEV_MINT=", mint.toBase58());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
