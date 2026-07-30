#!/usr/bin/env tsx
/**
 * scripts/verify-upgrade.ts
 *
 * Post-upgrade verification suite that confirms all importer accounts are readable,
 * storage is intact, and all entrypoints function correctly after a contract upgrade.
 *
 * Usage:
 *   tsx scripts/verify-upgrade.ts
 *   tsx scripts/verify-upgrade.ts --skip-canary
 *   tsx scripts/verify-upgrade.ts --dry-run
 *
 * Flags:
 *   --skip-canary   Skip the deposit/withdraw canary cycle entirely.
 *   --dry-run       Run the canary cycle against simulateTransaction only — no
 *                   transaction is signed or submitted, and no funds move. The
 *                   deposit/withdraw balance-comparison assertions still run,
 *                   evaluated against the simulated (not on-chain) balances.
 *                   Mirrors the --dry-run pattern in rotate-admin.ts. Combining
 *                   --dry-run with --skip-canary is treated the same as
 *                   --skip-canary alone (canary cycle does not run).
 */

import {
  TariffShieldClient,
  Keypair,
} from "../packages/sdk/src/index.js";
import {
  Contract,
  TransactionBuilder,
  rpc as SorobanRpc,
  nativeToScVal,
  scValToNative,
  Address,
} from "@stellar/stellar-sdk";
import { pool } from "../apps/api/src/db.js";
import * as fs from "node:fs";
import * as path from "node:path";

export interface VerificationReport {
  contractId: string;
  wasmHash: string;
  ledgerSequence: number;
  timestamp: string;
  totalAccountsVerified: number;
  accountResults: AccountVerificationResult[];
  canaryResult: CanaryResult | null;
  overallStatus: "PASS" | "FAIL";
}

export interface AccountVerificationResult {
  stellarAddress: string;
  bondId: string;
  status: "PASS" | "FAIL";
  error?: string;
  fieldsChanged?: string[];
}

export interface CanaryResult {
  status: "PASS" | "FAIL";
  depositTxHash?: string;
  withdrawTxHash?: string;
  error?: string;
  /** true when this result came from --dry-run simulateTransaction calls rather than a live submit. */
  simulated?: boolean;
}

interface OnChainAccount {
  bondId: { toString(): string };
  collateralBalance: { toString(): string };
  requiredCollateral: { toString(): string };
  reserveBalance: { toString(): string };
  yieldAccrued: { toString(): string };
  isClawbacked: boolean;
}

interface BackupAccount {
  stellarAddress: string;
  bondId: string;
  collateralBalance: string;
  requiredCollateral: string;
  reserveBalance: string;
  yieldAccrued: string;
  isClawbacked: boolean;
}

/**
 * Compares an on-chain account's post-upgrade field values against its
 * pre-upgrade backup snapshot. Returns the list of field names whose value
 * changed unexpectedly — an empty array means the account is unchanged.
 */
export function diffAccountFields(
  account: OnChainAccount,
  backupAccount: BackupAccount | undefined,
): string[] {
  const fieldsChanged: string[] = [];
  if (!backupAccount) return fieldsChanged;

  if (account.bondId.toString() !== backupAccount.bondId) {
    fieldsChanged.push("bondId");
  }
  if (account.collateralBalance.toString() !== backupAccount.collateralBalance) {
    fieldsChanged.push("collateralBalance");
  }
  if (account.requiredCollateral.toString() !== backupAccount.requiredCollateral) {
    fieldsChanged.push("requiredCollateral");
  }
  if (account.reserveBalance.toString() !== backupAccount.reserveBalance) {
    fieldsChanged.push("reserveBalance");
  }
  if (account.yieldAccrued.toString() !== backupAccount.yieldAccrued) {
    fieldsChanged.push("yieldAccrued");
  }
  if (account.isClawbacked !== backupAccount.isClawbacked) {
    fieldsChanged.push("isClawbacked");
  }

  return fieldsChanged;
}

/** A verification run passes only when every account and the canary (if run) passed. */
export function determineOverallStatus(failedAccounts: number): "PASS" | "FAIL" {
  return failedAccounts === 0 ? "PASS" : "FAIL";
}

/** Minimal shape of the parsed on-chain account object used by the canary cycle. */
interface CanaryAccountLike {
  collateralBalance: bigint;
}

/**
 * Dependencies the canary cycle needs, injected so runCanaryCycle can be unit
 * tested against fakes instead of a live SorobanRpc.Server / TariffShieldClient.
 *
 * dryRun=false uses `client` (getAccount / depositCollateral / withdrawCollateral) —
 * the existing live path, unchanged in behavior.
 *
 * dryRun=true instead builds the deposit/withdraw transactions manually via
 * `contract`/`server` and reads balances from `server.simulateTransaction(...)`
 * results (via `scValToNative`), since TariffShieldClient's write methods build
 * + sign + submit in one shot and don't expose a simulate-only path. Live
 * getAccount is still used for the *before* balance in dry-run mode too, since
 * that's a read-only simulate call already (see TariffShieldClient#getAccount).
 */
export interface RunCanaryCycleOptions {
  client: Pick<TariffShieldClient, "getAccount" | "depositCollateral" | "withdrawCollateral">;
  canaryKeypair: Keypair;
  canaryImporterAddress: string;
  testAmount: bigint;
  dryRun: boolean;
  /** Required when dryRun=true; unused otherwise. */
  server?: SorobanRpc.Server;
  contractId?: string;
  networkPassphrase?: string;
}

/** Simulates deposit_collateral/withdraw_collateral and extracts the resulting collateral_balance field. */
async function simulateCollateralCall(
  server: SorobanRpc.Server,
  contract: Contract,
  networkPassphrase: string,
  sourcePublicKey: string,
  method: "deposit_collateral" | "withdraw_collateral",
  importer: string,
  from: string,
  amount: bigint,
): Promise<CanaryAccountLike> {
  const sourceAccount = await server.getAccount(sourcePublicKey);
  const tx = new TransactionBuilder(sourceAccount, {
    fee: "1000000",
    networkPassphrase,
  })
    .addOperation(
      contract.call(
        method,
        new Address(importer).toScVal(),
        new Address(from).toScVal(),
        nativeToScVal(amount, { type: "i128" }),
      ),
    )
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (SorobanRpc.Api.isSimulationError(sim)) {
    throw new Error(`${method} simulation failed: ${sim.error}`);
  }
  if (!sim.result?.retval) {
    throw new Error(`${method} simulation returned no value`);
  }

  // deposit_collateral/withdraw_collateral return the full post-call account
  // record (same shape as get_account) per the contract's write-method convention.
  const obj = scValToNative(sim.result.retval) as Record<string, unknown>;
  return { collateralBalance: BigInt(obj.collateral_balance as string) };
}

/**
 * Runs the deposit/withdraw canary cycle and returns its CanaryResult.
 *
 * Extracted from main() so both the live and --dry-run paths are independently
 * unit-testable (scripts/__tests__/verify-upgrade.test.ts) against a mocked
 * TariffShieldClient / SorobanRpc.Server, without needing a live database,
 * network connection, or process-level mocking.
 */
export async function runCanaryCycle(opts: RunCanaryCycleOptions): Promise<CanaryResult> {
  const { client, canaryKeypair, canaryImporterAddress, testAmount, dryRun } = opts;

  try {
    const beforeAccount = await client.getAccount(canaryImporterAddress);
    const beforeBalance = beforeAccount.collateralBalance;

    if (!dryRun) {
      const depositResult = await client.depositCollateral(
        canaryKeypair,
        canaryImporterAddress,
        canaryImporterAddress,
        testAmount,
      );

      const afterDepositAccount = await client.getAccount(canaryImporterAddress);
      const afterDepositBalance = afterDepositAccount.collateralBalance;

      if (afterDepositBalance !== beforeBalance + testAmount) {
        throw new Error(
          `Balance mismatch after deposit. Expected ${beforeBalance + testAmount}, got ${afterDepositBalance}`,
        );
      }

      const withdrawResult = await client.withdrawCollateral(
        canaryKeypair,
        canaryImporterAddress,
        canaryImporterAddress,
        testAmount,
      );

      const afterWithdrawAccount = await client.getAccount(canaryImporterAddress);
      const afterWithdrawBalance = afterWithdrawAccount.collateralBalance;

      if (afterWithdrawBalance !== beforeBalance) {
        throw new Error(
          `Balance mismatch after withdrawal. Expected ${beforeBalance}, got ${afterWithdrawBalance}`,
        );
      }

      return {
        status: "PASS",
        depositTxHash: depositResult.txHash,
        withdrawTxHash: withdrawResult.txHash,
      };
    }

    // --dry-run: simulate both calls instead of submitting them.
    if (!opts.server || !opts.contractId || !opts.networkPassphrase) {
      throw new Error("runCanaryCycle: server/contractId/networkPassphrase are required when dryRun=true");
    }
    const contract = new Contract(opts.contractId);

    const afterDepositAccount = await simulateCollateralCall(
      opts.server,
      contract,
      opts.networkPassphrase,
      canaryKeypair.publicKey(),
      "deposit_collateral",
      canaryImporterAddress,
      canaryImporterAddress,
      testAmount,
    );
    const afterDepositBalance = afterDepositAccount.collateralBalance;

    if (afterDepositBalance !== beforeBalance + testAmount) {
      throw new Error(
        `[dry-run] Balance mismatch after simulated deposit. Expected ${beforeBalance + testAmount}, got ${afterDepositBalance}`,
      );
    }

    const afterWithdrawAccount = await simulateCollateralCall(
      opts.server,
      contract,
      opts.networkPassphrase,
      canaryKeypair.publicKey(),
      "withdraw_collateral",
      canaryImporterAddress,
      canaryImporterAddress,
      testAmount,
    );
    const afterWithdrawBalance = afterWithdrawAccount.collateralBalance;

    if (afterWithdrawBalance !== beforeBalance) {
      throw new Error(
        `[dry-run] Balance mismatch after simulated withdrawal. Expected ${beforeBalance}, got ${afterWithdrawBalance}`,
      );
    }

    return {
      status: "PASS",
      simulated: true,
    };
  } catch (error: any) {
    return {
      status: "FAIL",
      error: error.message,
      ...(dryRun ? { simulated: true } : {}),
    };
  }
}

async function main() {
  const args = process.argv.slice(2);
  const skipCanary = args.includes("--skip-canary");
  const dryRun = args.includes("--dry-run");

  const contractId = process.env.TARIFF_SHIELD_CONTRACT_ID;
  const rpcUrl = process.env.STELLAR_RPC_URL;
  const networkPassphrase = process.env.STELLAR_NETWORK_PASSPHRASE;
  const canaryImporterAddress = process.env.CANARY_IMPORTER_ADDRESS;
  const canaryImporterSecret = process.env.CANARY_IMPORTER_SECRET;

  if (!contractId || !rpcUrl || !networkPassphrase) {
    console.error("ERROR: Missing required environment variables");
    console.error(
      "Required: TARIFF_SHIELD_CONTRACT_ID, STELLAR_RPC_URL, STELLAR_NETWORK_PASSPHRASE",
    );
    process.exit(1);
  }

  const client = new TariffShieldClient({
    rpcUrl,
    contractId,
    networkPassphrase,
  });

  console.log("[verify-upgrade] Starting post-upgrade verification...\n");

  // Load pre-upgrade backup for comparison
  const backupDir = "./backups";
  let backupData: any = null;
  if (fs.existsSync(backupDir)) {
    const backupFiles = fs
      .readdirSync(backupDir)
      .filter((f) => f.startsWith("state-backup-") && f.endsWith(".json"))
      .sort()
      .reverse();

    if (backupFiles.length > 0) {
      const latestBackup = path.join(backupDir, backupFiles[0]);
      backupData = JSON.parse(fs.readFileSync(latestBackup, "utf-8"));
      console.log(`[verify-upgrade] Using backup: ${backupFiles[0]}\n`);
    } else {
      console.warn("[verify-upgrade] WARNING: No backup found in ./backups/\n");
    }
  }

  // Verify view entrypoints are functional
  console.log("[verify-upgrade] Testing view entrypoints...");
  try {
    const admin = await client.getAdmin();
    console.log(`  ✓ get_admin: ${admin}`);

    const surety = await client.getSurety();
    console.log(`  ✓ get_surety: ${surety}`);

    const token = await client.getToken();
    console.log(`  ✓ get_token: ${token}`);
  } catch (error: any) {
    console.error(`  ✗ View entrypoint failure: ${error.message}`);
    console.error(
      "\n[verify-upgrade] FAILURE: Basic view entrypoints are broken",
    );
    process.exit(1);
  }

  // Query all importer addresses
  console.log("\n[verify-upgrade] Querying all importers from database...");
  const result = await pool.query(
    "SELECT stellar_address, bond_id FROM importers ORDER BY created_at",
  );

  const totalImporters = result.rowCount || 0;
  console.log(`[verify-upgrade] Found ${totalImporters} importers\n`);

  const accountResults: AccountVerificationResult[] = [];
  let failedAccounts = 0;

  for (const row of result.rows) {
    const stellarAddress = row.stellar_address;
    const bondId = row.bond_id.toString();

    try {
      const account = await client.getAccount(stellarAddress);

      // Compare with backup if available
      const backupAccount = backupData
        ? backupData.accounts.find(
            (a: any) => a.stellarAddress === stellarAddress,
          )
        : undefined;
      const fieldsChanged = diffAccountFields(account, backupAccount);

      if (fieldsChanged.length > 0) {
        accountResults.push({
          stellarAddress,
          bondId,
          status: "FAIL",
          fieldsChanged,
          error: `Unexpected field changes: ${fieldsChanged.join(", ")}`,
        });
        failedAccounts++;
        console.log(`  ✗ ${stellarAddress}: Field changes detected`);
      } else {
        accountResults.push({
          stellarAddress,
          bondId,
          status: "PASS",
        });
        console.log(`  ✓ ${stellarAddress}`);
      }
    } catch (error: any) {
      accountResults.push({
        stellarAddress,
        bondId,
        status: "FAIL",
        error: error.message,
      });
      failedAccounts++;
      console.log(`  ✗ ${stellarAddress}: ${error.message}`);
    }
  }

  // Canary deposit/withdrawal cycle
  let canaryResult: CanaryResult | null = null;
  if (!skipCanary) {
    console.log(
      dryRun
        ? "\n[verify-upgrade] Running canary deposit/withdrawal cycle (--dry-run, simulateTransaction only)..."
        : "\n[verify-upgrade] Running canary deposit/withdrawal cycle...",
    );

    if (!canaryImporterAddress || !canaryImporterSecret) {
      console.error(
        "  ✗ ERROR: CANARY_IMPORTER_ADDRESS and CANARY_IMPORTER_SECRET required",
      );
      canaryResult = {
        status: "FAIL",
        error: "Missing canary credentials",
      };
      failedAccounts++;
    } else {
      const canaryKeypair = Keypair.fromSecret(canaryImporterSecret);
      const testAmount = BigInt(1_000_000); // 0.1 XLM

      console.log(
        dryRun
          ? `  Simulating deposit/withdraw of ${testAmount.toString()} stroops (no funds will move)...`
          : `  Depositing/withdrawing ${testAmount.toString()} stroops...`,
      );

      canaryResult = await runCanaryCycle({
        client,
        canaryKeypair,
        canaryImporterAddress,
        testAmount,
        dryRun,
        server: dryRun
          ? new SorobanRpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith("http://") })
          : undefined,
        contractId,
        networkPassphrase,
      });

      if (canaryResult.status === "PASS") {
        if (canaryResult.simulated) {
          console.log(`  ✓ Canary cycle simulated successfully (--dry-run, nothing broadcast)`);
        } else {
          console.log(`  ✓ Deposit tx: ${canaryResult.depositTxHash}`);
          console.log(`  ✓ Withdraw tx: ${canaryResult.withdrawTxHash}`);
          console.log(`  ✓ Canary cycle completed successfully`);
        }
      } else {
        failedAccounts++;
        console.log(`  ✗ Canary cycle failed: ${canaryResult.error}`);
      }
    }
  } else {
    console.log(
      "\n[verify-upgrade] Skipping canary cycle (--skip-canary flag)\n",
    );
  }

  // Get current ledger and wasm hash
  const ledgerSequence = await getCurrentLedgerSequence(rpcUrl);
  const wasmHash = await getContractWasmHash(rpcUrl, contractId);

  // Generate report
  const report: VerificationReport = {
    contractId,
    wasmHash,
    ledgerSequence,
    timestamp: new Date().toISOString(),
    totalAccountsVerified: totalImporters,
    accountResults,
    canaryResult,
    overallStatus: determineOverallStatus(failedAccounts),
  };

  // Write report
  const reportDir = "./verification-reports";
  if (!fs.existsSync(reportDir)) {
    fs.mkdirSync(reportDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = path.join(reportDir, `verify-${timestamp}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\n[verify-upgrade] Report written to: ${reportPath}`);

  // Print summary
  console.log("\n=== Verification Summary ===");
  console.log(`Contract ID: ${contractId}`);
  console.log(`WASM Hash: ${wasmHash}`);
  console.log(`Ledger Sequence: ${ledgerSequence}`);
  console.log(`Total Accounts Verified: ${totalImporters}`);
  console.log(`Passed: ${totalImporters - failedAccounts}`);
  console.log(`Failed: ${failedAccounts}`);
  console.log(`Canary Status: ${canaryResult?.status || "SKIPPED"}`);
  console.log(`Overall Status: ${report.overallStatus}`);

  await pool.end();

  if (report.overallStatus === "FAIL") {
    process.exit(1);
  }
}

async function getCurrentLedgerSequence(rpcUrl: string): Promise<number> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getLatestLedger",
      params: [],
    }),
  });

  const data = await response.json();
  return data.result?.sequence ?? 0;
}

async function getContractWasmHash(
  rpcUrl: string,
  contractId: string,
): Promise<string> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getContractData",
      params: [contractId],
    }),
  });

  const data = await response.json();
  return data.result?.wasmHash ?? "unknown";
}

// Only run when invoked directly (tsx scripts/verify-upgrade.ts), not when
// imported for its exported functions — e.g. by scripts/__tests__/verify-upgrade.test.ts.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error("[verify-upgrade] Fatal error:", error);
    process.exit(1);
  });
}
