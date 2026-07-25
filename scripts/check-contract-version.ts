import { parseArgs } from 'node:util';
import { TariffShieldClient, checkCompatibility, CompatibilityError } from '@tariffshield/sdk';

async function main() {
  const { values } = parseArgs({
    options: {
      'contract-id': { type: 'string' },
      'rpc-url': { type: 'string' },
      'sdk-version': { type: 'string' },
    },
  });

  const contractId = values['contract-id'] || process.env.TARIFF_SHIELD_CONTRACT_ID;
  const rpcUrl =
    values['rpc-url'] || process.env.STELLAR_RPC_URL || 'https://soroban-testnet.stellar.org';
  const sdkVersion = values['sdk-version'] || '0.1.0';

  if (!contractId) {
    console.error(
      'Error: --contract-id flag or TARIFF_SHIELD_CONTRACT_ID environment variable is required.'
    );
    process.exit(1);
  }

  const networkPassphrase =
    process.env.STELLAR_NETWORK_PASSPHRASE || 'Test SDF Network ; September 2015';

  const client = new TariffShieldClient({
    rpcUrl,
    contractId,
    networkPassphrase,
    skipCompatibilityCheck: true,
  });

  try {
    const contractVersion = await client.version();
    checkCompatibility(contractVersion, sdkVersion);
    console.log(`✓ Compatible: SDK v${sdkVersion} is compatible with contract ${contractVersion}.`);
    process.exit(0);
  } catch (err) {
    if (err instanceof CompatibilityError) {
      console.error(`❌ Incompatible: ${err.message}`);
    } else {
      console.error(`❌ Error checking contract version:`, err);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
