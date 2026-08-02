#!/usr/bin/env tsx
/**
 * scripts/list-wasm-hashes.ts
 *
 * Lists all wasm hashes for the TariffShield contract from deployment history
 * to help identify the correct previous hash for rollback operations.
 *
 * Usage:
 *   tsx scripts/list-wasm-hashes.ts
 *
 * The filtering/fallback/sort/selection logic lives in
 * scripts/lib/list-wasm-hashes-logic.ts as pure, exported functions
 * (loadHistory, filterDeployments, sortByDeployedAtDescending,
 * selectPreviousDeployment) so it can be unit tested — see
 * scripts/__tests__/list-wasm-hashes.test.ts — against in-memory fixtures
 * instead of a real deployments/history.json file. This file is a thin I/O
 * wrapper: read the file, call the pure functions, print.
 */

import * as path from "node:path";
import {
  DeploymentHistoryNotFoundError,
  EmptyDeploymentHistoryError,
  filterDeployments,
  loadHistory,
  selectPreviousDeployment,
  sortByDeployedAtDescending,
} from "./lib/list-wasm-hashes-logic.js";

export async function main() {
  const historyPath = path.join(process.cwd(), "deployments", "history.json");

  let history;
  try {
    history = loadHistory(historyPath);
  } catch (error) {
    if (error instanceof DeploymentHistoryNotFoundError) {
      console.error("ERROR: deployments/history.json not found");
      console.error(
        "\nThis file is created automatically by deployment scripts.",
      );
      console.error(
        "If you need to rollback and this file doesn't exist, you must",
      );
      console.error(
        "manually query the Stellar network for previous wasm hashes.",
      );
      process.exit(1);
    }
    if (error instanceof EmptyDeploymentHistoryError) {
      console.error("ERROR: No deployment history found");
      process.exit(1);
    }
    throw error;
  }

  const contractId = process.env.TARIFF_SHIELD_CONTRACT_ID;
  const network = process.env.STELLAR_NETWORK || "testnet";

  const relevantDeployments = filterDeployments(history, { contractId, network });
  // filterDeployments returns the same `history` array reference only when it
  // fell back after a zero-match filter (or when no filters were requested at
  // all, in which case there's nothing to report as a fallback).
  const usedFallback = relevantDeployments === history && Boolean(contractId || network);

  if (usedFallback) {
    console.log("No deployments found for current contract/network");
    console.log("\nShowing all deployments:");
  }

  console.log("=== TariffShield Contract Deployment History ===\n");
  console.log(`Total deployments: ${relevantDeployments.length}\n`);

  const sorted = sortByDeployedAtDescending(relevantDeployments);

  sorted.forEach((deployment, index) => {
    const isCurrent = index === 0;
    const marker = isCurrent ? " (CURRENT)" : "";

    console.log(`${index + 1}. ${marker}`);
    console.log(`   WASM Hash: ${deployment.wasmHash}`);
    console.log(`   Contract:  ${deployment.contractId}`);
    console.log(`   Network:   ${deployment.network}`);
    console.log(`   Version:   ${deployment.version || "unknown"}`);
    console.log(`   Deployed:  ${deployment.deployedAt}`);
    console.log(`   By:        ${deployment.deployedBy || "unknown"}`);
    console.log("");
  });

  const previousDeployment = selectPreviousDeployment(sorted);
  if (previousDeployment) {
    console.log("=== Quick Rollback Command ===");
    console.log(
      `tsx scripts/rollback-upgrade.ts --previous-wasm-hash ${previousDeployment.wasmHash} --contract-id ${previousDeployment.contractId}`,
    );
  }
}

// Only run when invoked directly (tsx scripts/list-wasm-hashes.ts), not when
// imported for its exported functions — e.g. by
// scripts/__tests__/list-wasm-hashes.test.ts.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
}
