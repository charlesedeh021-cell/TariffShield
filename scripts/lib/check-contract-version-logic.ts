import * as fs from "node:fs";

export class SdkPackageJsonNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SdkPackageJsonNotFoundError";
  }
}

export class SdkVersionMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SdkVersionMissingError";
  }
}

/**
 * Resolves the default --sdk-version by reading the "version" field out of
 * packages/sdk/package.json, so the default tracks whatever version the SDK
 * was last bumped to instead of a hardcoded literal going stale.
 */
export function resolveDefaultSdkVersion(sdkPackageJsonPath: string): string {
  if (!fs.existsSync(sdkPackageJsonPath)) {
    throw new SdkPackageJsonNotFoundError(
      `packages/sdk/package.json not found at ${sdkPackageJsonPath}`,
    );
  }

  const raw = fs.readFileSync(sdkPackageJsonPath, "utf-8");
  const pkg: { version?: string } = JSON.parse(raw);

  if (!pkg.version) {
    throw new SdkVersionMissingError(
      `No "version" field found in ${sdkPackageJsonPath}`,
    );
  }

  return pkg.version;
}
