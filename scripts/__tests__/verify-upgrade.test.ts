/**
 * Unit tests for scripts/verify-upgrade.ts.
 *
 * Covers the field-diffing logic (diffAccountFields) that compares on-chain
 * post-upgrade account state against a pre-upgrade backup, the overallStatus
 * PASS/FAIL determination (determineOverallStatus) based on the
 * failedAccounts count, and runCanaryCycle — both its live path (deposit +
 * withdraw via TariffShieldClient) and its --dry-run path (#776), which
 * simulates the same deposit_collateral/withdraw_collateral calls via
 * SorobanRpc.Server#simulateTransaction instead of submitting them. These
 * were extracted out of the previously inline verification/canary loops in
 * main() specifically so they could be unit tested here without a live
 * database or network connection.
 *
 * The --skip-canary flag branch and the full end-to-end run (database query +
 * report generation) are exercised only via manual/staging runs of the
 * script itself — they depend on a live pool.query, which main() wires up
 * directly rather than accepting as an injectable dependency.
 *
 * Run via:  npm run test:scripts
 */

import { describe, it, before, mock } from 'node:test';
import assert from 'node:assert/strict';
import { nativeToScVal, TransactionBuilder, Keypair } from '@stellar/stellar-sdk';

// scripts/verify-upgrade.ts transitively imports apps/api/src/db.ts, which
// validates process.env against a Zod schema at module load time, opens a
// `pg` Pool (lazily — no connection is made until a query runs), and starts
// an unconditional setInterval for pool-exhaustion alerting. Stub the
// required env vars (same values the CI api-integration.yml job uses) before
// dynamically importing the module under test, so the import itself doesn't
// throw — no real database or network connection is ever made from these
// tests, since only the pure diffAccountFields/determineOverallStatus
// exports are exercised below. The import happens inside before() (rather
// than at module top level) so this file doesn't require top-level-await/ESM
// support from the runner.
//
// db.ts's setInterval is never cleared, so this suite must be run with
// `--test-force-exit` (see the test:scripts script in package.json) —
// otherwise the process hangs after all tests finish waiting for a timer
// that will never fire.
let diffAccountFields: (typeof import('../verify-upgrade.js'))['diffAccountFields'];
let determineOverallStatus: (typeof import('../verify-upgrade.js'))['determineOverallStatus'];
let runCanaryCycle: (typeof import('../verify-upgrade.js'))['runCanaryCycle'];

before(async () => {
  process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/tariffshield_test';
  process.env.JWT_SECRET ??= 'ci-stub-jwt-secret-not-used-by-migrations-0000';
  process.env.STELLAR_RPC_URL ??= 'https://soroban-testnet.stellar.org';
  process.env.STELLAR_HORIZON_URL ??= 'https://horizon-testnet.stellar.org';
  process.env.STELLAR_NETWORK_PASSPHRASE ??= 'Test SDF Network ; September 2015';
  process.env.TARIFF_SHIELD_CONTRACT_ID ??=
    'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  process.env.PLATFORM_STELLAR_SECRET ??=
    'SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB';
  process.env.SURETY_STELLAR_SECRET ??= 'SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAC';

  const mod = await import('../verify-upgrade.js');
  diffAccountFields = mod.diffAccountFields;
  determineOverallStatus = mod.determineOverallStatus;
  runCanaryCycle = mod.runCanaryCycle;
});

function makeOnChainAccount(
  overrides: Partial<{
    bondId: string;
    collateralBalance: string;
    requiredCollateral: string;
    reserveBalance: string;
    yieldAccrued: string;
    isClawbacked: boolean;
  }> = {}
) {
  const values = {
    bondId: '1001',
    collateralBalance: '5000000',
    requiredCollateral: '4000000',
    reserveBalance: '1000000',
    yieldAccrued: '12345',
    isClawbacked: false,
    ...overrides,
  };
  return {
    bondId: { toString: () => values.bondId },
    collateralBalance: { toString: () => values.collateralBalance },
    requiredCollateral: { toString: () => values.requiredCollateral },
    reserveBalance: { toString: () => values.reserveBalance },
    yieldAccrued: { toString: () => values.yieldAccrued },
    isClawbacked: values.isClawbacked,
  };
}

function makeBackupAccount(
  overrides: Partial<{
    stellarAddress: string;
    bondId: string;
    collateralBalance: string;
    requiredCollateral: string;
    reserveBalance: string;
    yieldAccrued: string;
    isClawbacked: boolean;
  }> = {}
) {
  return {
    stellarAddress: 'GBACKUP',
    bondId: '1001',
    collateralBalance: '5000000',
    requiredCollateral: '4000000',
    reserveBalance: '1000000',
    yieldAccrued: '12345',
    isClawbacked: false,
    ...overrides,
  };
}

describe('diffAccountFields', () => {
  it('returns an empty array when no backup account is provided', () => {
    const account = makeOnChainAccount();
    assert.deepEqual(diffAccountFields(account, undefined), []);
  });

  it('returns an empty array when every field matches the backup', () => {
    const account = makeOnChainAccount();
    const backup = makeBackupAccount();
    assert.deepEqual(diffAccountFields(account, backup), []);
  });

  it('flags bondId when it differs from the backup', () => {
    const account = makeOnChainAccount({ bondId: '1002' });
    const backup = makeBackupAccount({ bondId: '1001' });
    assert.deepEqual(diffAccountFields(account, backup), ['bondId']);
  });

  it('flags collateralBalance when it differs from the backup', () => {
    const account = makeOnChainAccount({ collateralBalance: '9999999' });
    const backup = makeBackupAccount();
    assert.deepEqual(diffAccountFields(account, backup), ['collateralBalance']);
  });

  it('flags requiredCollateral when it differs from the backup', () => {
    const account = makeOnChainAccount({ requiredCollateral: '1' });
    const backup = makeBackupAccount();
    assert.deepEqual(diffAccountFields(account, backup), ['requiredCollateral']);
  });

  it('flags reserveBalance when it differs from the backup', () => {
    const account = makeOnChainAccount({ reserveBalance: '1' });
    const backup = makeBackupAccount();
    assert.deepEqual(diffAccountFields(account, backup), ['reserveBalance']);
  });

  it('flags yieldAccrued when it differs from the backup', () => {
    const account = makeOnChainAccount({ yieldAccrued: '1' });
    const backup = makeBackupAccount();
    assert.deepEqual(diffAccountFields(account, backup), ['yieldAccrued']);
  });

  it('flags isClawbacked when it differs from the backup', () => {
    const account = makeOnChainAccount({ isClawbacked: true });
    const backup = makeBackupAccount({ isClawbacked: false });
    assert.deepEqual(diffAccountFields(account, backup), ['isClawbacked']);
  });

  it('flags every changed field at once, in a stable order', () => {
    const account = makeOnChainAccount({
      bondId: '9999',
      collateralBalance: '0',
      isClawbacked: true,
    });
    const backup = makeBackupAccount();
    assert.deepEqual(diffAccountFields(account, backup), [
      'bondId',
      'collateralBalance',
      'isClawbacked',
    ]);
  });
});

describe('determineOverallStatus', () => {
  it('returns PASS when there are zero failed accounts', () => {
    assert.equal(determineOverallStatus(0), 'PASS');
  });

  it('returns FAIL when there is at least one failed account', () => {
    assert.equal(determineOverallStatus(1), 'FAIL');
  });

  it('returns FAIL for a large failedAccounts count', () => {
    assert.equal(determineOverallStatus(42), 'FAIL');
  });
});

describe('runCanaryCycle (live, dryRun=false)', () => {
  const canaryKeypair = Keypair.random();
  const canaryImporterAddress = canaryKeypair.publicKey();
  const testAmount = 1_000_000n;

  it('passes and returns tx hashes when deposit/withdraw round-trips the balance back to the starting point', async () => {
    let balance = 5_000_000n;
    const client = {
      getAccount: async () => ({ collateralBalance: balance }),
      depositCollateral: async () => {
        balance += testAmount;
        return { txHash: 'DEPOSIT_TX_HASH' };
      },
      withdrawCollateral: async () => {
        balance -= testAmount;
        return { txHash: 'WITHDRAW_TX_HASH' };
      },
    };

    const result = await runCanaryCycle({
      client: client as any,
      canaryKeypair,
      canaryImporterAddress,
      testAmount,
      dryRun: false,
    });

    assert.deepEqual(result, {
      status: 'PASS',
      depositTxHash: 'DEPOSIT_TX_HASH',
      withdrawTxHash: 'WITHDRAW_TX_HASH',
    });
  });

  it('fails with a balance-mismatch error when the post-deposit balance is wrong', async () => {
    const client = {
      getAccount: async () => ({ collateralBalance: 5_000_000n }), // never actually increments
      depositCollateral: async () => ({ txHash: 'DEPOSIT_TX_HASH' }),
      withdrawCollateral: async () => ({ txHash: 'WITHDRAW_TX_HASH' }),
    };

    const result = await runCanaryCycle({
      client: client as any,
      canaryKeypair,
      canaryImporterAddress,
      testAmount,
      dryRun: false,
    });

    assert.equal(result.status, 'FAIL');
    assert.match(result.error ?? '', /Balance mismatch after deposit/);
    assert.equal(result.simulated, undefined);
  });

  it('fails with a balance-mismatch error when the post-withdraw balance does not return to baseline', async () => {
    let balance = 5_000_000n;
    const client = {
      getAccount: async () => ({ collateralBalance: balance }),
      depositCollateral: async () => {
        balance += testAmount;
        return { txHash: 'DEPOSIT_TX_HASH' };
      },
      withdrawCollateral: async () => {
        // Intentionally do not decrement — simulates a withdraw that silently no-ops on-chain.
        return { txHash: 'WITHDRAW_TX_HASH' };
      },
    };

    const result = await runCanaryCycle({
      client: client as any,
      canaryKeypair,
      canaryImporterAddress,
      testAmount,
      dryRun: false,
    });

    assert.equal(result.status, 'FAIL');
    assert.match(result.error ?? '', /Balance mismatch after withdrawal/);
  });

  it('fails when depositCollateral itself rejects (e.g. contract call reverts)', async () => {
    const client = {
      getAccount: async () => ({ collateralBalance: 5_000_000n }),
      depositCollateral: async () => {
        throw new Error('deposit_collateral: insufficient reserve');
      },
      withdrawCollateral: async () => ({ txHash: 'WITHDRAW_TX_HASH' }),
    };

    const result = await runCanaryCycle({
      client: client as any,
      canaryKeypair,
      canaryImporterAddress,
      testAmount,
      dryRun: false,
    });

    assert.equal(result.status, 'FAIL');
    assert.match(result.error ?? '', /insufficient reserve/);
  });
});

describe('runCanaryCycle (--dry-run, dryRun=true)', () => {
  const canaryKeypair = Keypair.random();
  const canaryImporterAddress = canaryKeypair.publicKey();
  const testAmount = 1_000_000n;
  const contractId = 'CA4XHIJVTYFEATMWUUUDKCEIRXXOSMIYKNLFLHYM4UBCLYD4FPIXNJIU';
  const networkPassphrase = 'Test SDF Network ; September 2015';

  function scValAccountReturn(collateralBalance: bigint) {
    return nativeToScVal(
      { collateral_balance: collateralBalance.toString() },
      { type: { collateral_balance: ['symbol', 'i128'] } },
    );
  }

  function stubTransactionBuilder(fakeTx: unknown) {
    const buildStub = mock.method(TransactionBuilder.prototype, 'build', function () {
      return fakeTx;
    });
    const addOpStub = mock.method(TransactionBuilder.prototype, 'addOperation', function (this: any) {
      return this;
    });
    const setTimeoutStub = mock.method(TransactionBuilder.prototype, 'setTimeout', function (this: any) {
      return this;
    });
    return () => {
      buildStub.mock.restore();
      addOpStub.mock.restore();
      setTimeoutStub.mock.restore();
    };
  }

  it('simulates deposit + withdraw and returns simulated:true without calling depositCollateral/withdrawCollateral', async () => {
    const depositCollateral = mock.fn(async () => {
      throw new Error('depositCollateral (live submit) must not be called in --dry-run mode');
    });
    const withdrawCollateral = mock.fn(async () => {
      throw new Error('withdrawCollateral (live submit) must not be called in --dry-run mode');
    });

    const client = {
      getAccount: async () => ({ collateralBalance: 5_000_000n }),
      depositCollateral,
      withdrawCollateral,
    };

    const fakeTx = {};
    const restore = stubTransactionBuilder(fakeTx);

    let simCallCount = 0;
    const server = {
      getAccount: async () => ({ accountId: () => 'GSOURCE', sequenceNumber: () => '1' }),
      simulateTransaction: async () => {
        simCallCount += 1;
        // First call is the simulated deposit (balance goes up by testAmount),
        // second is the simulated withdraw (balance returns to baseline).
        const balance = simCallCount === 1 ? 5_000_000n + testAmount : 5_000_000n;
        return { result: { retval: scValAccountReturn(balance) } };
      },
    };

    try {
      const result = await runCanaryCycle({
        client: client as any,
        canaryKeypair,
        canaryImporterAddress,
        testAmount,
        dryRun: true,
        server: server as any,
        contractId,
        networkPassphrase,
      });

      assert.deepEqual(result, { status: 'PASS', simulated: true });
      assert.equal(depositCollateral.mock.callCount(), 0);
      assert.equal(withdrawCollateral.mock.callCount(), 0);
      assert.equal(simCallCount, 2);
    } finally {
      restore();
    }
  });

  it('still runs the balance-comparison assertions against simulated results and fails on a simulated deposit mismatch', async () => {
    const client = {
      getAccount: async () => ({ collateralBalance: 5_000_000n }),
      depositCollateral: async () => ({ txHash: 'unused' }),
      withdrawCollateral: async () => ({ txHash: 'unused' }),
    };

    const fakeTx = {};
    const restore = stubTransactionBuilder(fakeTx);

    const server = {
      getAccount: async () => ({ accountId: () => 'GSOURCE', sequenceNumber: () => '1' }),
      simulateTransaction: async () => {
        // Simulated deposit reports no balance change at all — should fail the assertion.
        return { result: { retval: scValAccountReturn(5_000_000n) } };
      },
    };

    try {
      const result = await runCanaryCycle({
        client: client as any,
        canaryKeypair,
        canaryImporterAddress,
        testAmount,
        dryRun: true,
        server: server as any,
        contractId,
        networkPassphrase,
      });

      assert.equal(result.status, 'FAIL');
      assert.equal(result.simulated, true);
      assert.match(result.error ?? '', /\[dry-run] Balance mismatch after simulated deposit/);
    } finally {
      restore();
    }
  });

  it('fails when simulateTransaction reports a simulation error (isSimulationError)', async () => {
    const client = {
      getAccount: async () => ({ collateralBalance: 5_000_000n }),
      depositCollateral: async () => ({ txHash: 'unused' }),
      withdrawCollateral: async () => ({ txHash: 'unused' }),
    };

    const fakeTx = {};
    const restore = stubTransactionBuilder(fakeTx);

    const server = {
      getAccount: async () => ({ accountId: () => 'GSOURCE', sequenceNumber: () => '1' }),
      simulateTransaction: async () => ({
        error: 'HostError: Error(Contract, #4) — insufficient collateral',
      }),
    };

    try {
      const result = await runCanaryCycle({
        client: client as any,
        canaryKeypair,
        canaryImporterAddress,
        testAmount,
        dryRun: true,
        server: server as any,
        contractId,
        networkPassphrase,
      });

      assert.equal(result.status, 'FAIL');
      assert.equal(result.simulated, true);
      assert.match(result.error ?? '', /deposit_collateral simulation failed/);
    } finally {
      restore();
    }
  });

  it('throws a clear error when dryRun=true but server/contractId/networkPassphrase are not provided', async () => {
    const client = {
      getAccount: async () => ({ collateralBalance: 5_000_000n }),
      depositCollateral: async () => ({ txHash: 'unused' }),
      withdrawCollateral: async () => ({ txHash: 'unused' }),
    };

    const result = await runCanaryCycle({
      client: client as any,
      canaryKeypair,
      canaryImporterAddress,
      testAmount,
      dryRun: true,
      // server/contractId/networkPassphrase intentionally omitted
    });

    assert.equal(result.status, 'FAIL');
    assert.equal(result.simulated, true);
    assert.match(
      result.error ?? '',
      /server\/contractId\/networkPassphrase are required when dryRun=true/,
    );
  });
});
