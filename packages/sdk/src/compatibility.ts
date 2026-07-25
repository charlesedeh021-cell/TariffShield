// Matrix update process: Every contract upgrade (issue 341) must add a new SDK version entry to this file before the upgraded contract is deployed.

export interface ContractVersionRange {
  minContract: string;
  maxContract: string;
}

export const COMPATIBILITY_MATRIX: Record<string, ContractVersionRange> = {
  '0.1.0': { minContract: 'v0_1_0', maxContract: 'v0_3_0' },
  '1.0.0': { minContract: 'v0_1_0', maxContract: 'v0_1_0' },
  '1.1.0': { minContract: 'v0_1_0', maxContract: 'v0_2_0' },
};

export class CompatibilityError extends Error {
  public readonly sdkVersion: string;
  public readonly contractVersion: string;
  public readonly supportedRange: ContractVersionRange;

  constructor(sdkVersion: string, contractVersion: string, supportedRange: ContractVersionRange) {
    super(
      `SDK version ${sdkVersion} is incompatible with contract version ${contractVersion}. Supported range: ${supportedRange.minContract} to ${supportedRange.maxContract}`
    );
    this.name = 'CompatibilityError';
    this.sdkVersion = sdkVersion;
    this.contractVersion = contractVersion;
    this.supportedRange = supportedRange;
  }
}

function parseVersion(v: string): [number, number, number] {
  const clean = v.replace(/^v/, '').replace(/_/g, '.');
  const parts = clean.split('.').map((p) => parseInt(p, 10));
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

function compareVersions(v1: string, v2: string): number {
  const [a1, b1, c1] = parseVersion(v1);
  const [a2, b2, c2] = parseVersion(v2);
  if (a1 !== a2) return a1 - a2;
  if (b1 !== b2) return b1 - b2;
  return c1 - c2;
}

export function checkCompatibility(contractVersion: string, sdkVersion: string): void {
  const range = COMPATIBILITY_MATRIX[sdkVersion];
  if (!range) {
    throw new CompatibilityError(sdkVersion, contractVersion, {
      minContract: 'unknown',
      maxContract: 'unknown',
    });
  }

  const isBelowMin = compareVersions(contractVersion, range.minContract) < 0;
  const isAboveMax = compareVersions(contractVersion, range.maxContract) > 0;

  if (isBelowMin || isAboveMax) {
    throw new CompatibilityError(sdkVersion, contractVersion, range);
  }
}
