#!/usr/bin/env tsx
/**
 * scripts/deploy-contracts.ts
 *
 * Wraps the Stellar CLI `contract deploy` + `contract invoke -- initialize`
 * flow documented in the README Quickstart section.
 *
 * Usage:
 *   npm run contract:deploy
 *   npm run contract:deploy -- --network testnet --source my-admin
 *   npm run contract:deploy -- --network testnet --source my-admin \
 *       --surety GABCD... --token CDEF...
 *
 * Flags:
 *   --network  <name>   Stellar network name (default: testnet)
 *   --source   <name>   Stellar CLI identity / key name to sign with (default: my-admin)
 *   --wasm     <path>   Path to compiled .wasm file
 *                       (default: target/wasm32-unknown-unknown/release/tariff_shield.optimized.wasm)
 *   --admin    <G…>     Admin public key (defaults to the public key of --source)
 *   --surety   <G…>     Surety public key (required if not set via env SURETY_PUBLIC_KEY)
 *   --token    <C…>     Collateral token contract ID (required if not set via env TOKEN_CONTRACT_ID)
 *   --skip-init         Deploy the wasm but skip the initialize call
 */

import { execSync, ExecSyncOptionsWithStringEncoding } from "node:child_process";
import { existsSync } from "node:fs";
import { Command } from "commander";

const DEFAULT_NETWORK = "testnet";
const DEFAULT_SOURCE = "my-admin";
const DEFAULT_WASM =
  "target/wasm32-unknown-unknown/release/tariff_shield.optimized.wasm";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function run(cmd: string, label: string): string {
  const opts: ExecSyncOptionsWithStringEncoding = {
    encoding: "utf-8",
    stdio: ["inherit", "pipe", "pipe"],
  };
  try {
    const stdout = execSync(cmd, opts).trim();
    return stdout;
  } catch (err: any) {
    // execSync throws with stderr / stdout attached to the error object
    const detail =
      (err.stderr as string | undefined)?.trim() ||
      (err.stdout as string | undefined)?.trim() ||
      err.message;
    console.error(`\n[deploy-contracts] ERROR during "${label}":`);
    console.error(detail);
    process.exit(1);
  }
}

function resolveAdminAddress(source: string, network: string): string {
  console.log(`[deploy-contracts] Resolving public key for identity "${source}"...`);
  const address = run(
    `stellar keys address ${source} --network ${network}`,
    "resolve admin address",
  );
  if (!address.startsWith("G")) {
    console.error(
      `[deploy-contracts] Expected a Stellar public key (starts with G), got: ${address}`,
    );
    process.exit(1);
  }
  return address;
}

// ---------------------------------------------------------------------------
// CLI definition
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name("deploy-contracts")
  .description(
    "Deploy the TariffShield Soroban contract and run the initialize entrypoint",
  )
  .version("1.0.0")
  .option("--network <name>", "Stellar network name", DEFAULT_NETWORK)
  .option(
    "--source <name>",
    "Stellar CLI identity / key name used to sign transactions",
    DEFAULT_SOURCE,
  )
  .option("--wasm <path>", "Path to compiled .wasm file", DEFAULT_WASM)
  .option(
    "--admin <address>",
    "Admin public key (defaults to public key of --source)",
  )
  .option(
    "--surety <address>",
    "Surety public key (can also be set via SURETY_PUBLIC_KEY env var)",
  )
  .option(
    "--token <address>",
    "Collateral token contract ID (can also be set via TOKEN_CONTRACT_ID env var)",
  )
  .option("--skip-init", "Skip the initialize call after deployment")
  .parse(process.argv);

const opts = program.opts<{
  network: string;
  source: string;
  wasm: string;
  admin?: string;
  surety?: string;
  token?: string;
  skipInit?: boolean;
}>();

// ---------------------------------------------------------------------------
// Pre-flight checks
// ---------------------------------------------------------------------------

if (!existsSync(opts.wasm)) {
  console.error(
    `[deploy-contracts] WASM file not found: ${opts.wasm}`,
  );
  console.error(
    "  Build it first with:  npm run contract:build",
  );
  process.exit(1);
}

// Verify stellar CLI is available
run("stellar --version", "check stellar CLI");

// ---------------------------------------------------------------------------
// Deploy
// ---------------------------------------------------------------------------

console.log(`\n[deploy-contracts] Deploying contract on network "${opts.network}"...`);
console.log(`  Source account : ${opts.source}`);
console.log(`  WASM           : ${opts.wasm}`);

const deployCmd = [
  "stellar contract deploy",
  `--network ${opts.network}`,
  `--source-account ${opts.source}`,
  `--wasm ${opts.wasm}`,
].join(" ");

const contractId = run(deployCmd, "stellar contract deploy");

console.log(`\n[deploy-contracts] Contract deployed successfully.`);
console.log(`  Contract ID: ${contractId}`);

// ---------------------------------------------------------------------------
// Initialize
// ---------------------------------------------------------------------------

if (opts.skipInit) {
  console.log("\n[deploy-contracts] Skipping initialize (--skip-init).");
} else {
  const adminAddress = opts.admin ?? resolveAdminAddress(opts.source, opts.network);
  const suretyAddress = opts.surety ?? process.env.SURETY_PUBLIC_KEY;
  const tokenAddress = opts.token ?? process.env.TOKEN_CONTRACT_ID;

  if (!suretyAddress) {
    console.error(
      "[deploy-contracts] ERROR: --surety <address> (or env SURETY_PUBLIC_KEY) is required for initialize.",
    );
    console.error(
      "  Re-run with --skip-init to skip the initialize step, or provide --surety.",
    );
    process.exit(1);
  }

  if (!tokenAddress) {
    console.error(
      "[deploy-contracts] ERROR: --token <address> (or env TOKEN_CONTRACT_ID) is required for initialize.",
    );
    console.error(
      "  Re-run with --skip-init to skip the initialize step, or provide --token.",
    );
    process.exit(1);
  }

  console.log(`\n[deploy-contracts] Running initialize...`);
  console.log(`  Admin  : ${adminAddress}`);
  console.log(`  Surety : ${suretyAddress}`);
  console.log(`  Token  : ${tokenAddress}`);

  const initCmd = [
    `stellar contract invoke ${contractId}`,
    `--network ${opts.network}`,
    `--source-account ${opts.source}`,
    "-- initialize",
    `--admin ${adminAddress}`,
    `--surety ${suretyAddress}`,
    `--token ${tokenAddress}`,
  ].join(" ");

  run(initCmd, "stellar contract invoke -- initialize");
  console.log(`\n[deploy-contracts] Contract initialized successfully.`);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log("\n=== Deployment Summary ===");
console.log(`Network     : ${opts.network}`);
console.log(`Contract ID : ${contractId}`);
console.log(`\nUpdate TARIFF_SHIELD_CONTRACT_ID in your .env:`);
console.log(`  TARIFF_SHIELD_CONTRACT_ID=${contractId}`);
