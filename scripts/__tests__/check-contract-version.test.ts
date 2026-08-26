import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  resolveDefaultSdkVersion,
  SdkPackageJsonNotFoundError,
  SdkVersionMissingError,
} from "../lib/check-contract-version-logic.js";

describe("resolveDefaultSdkVersion", () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  function writeTempPackageJson(content: string): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "check-contract-version-test-"));
    const filePath = path.join(tmpDir, "package.json");
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  it("reads the version field from the given package.json", () => {
    const filePath = writeTempPackageJson(JSON.stringify({ name: "@tariffshield/sdk", version: "1.2.3" }));

    assert.equal(resolveDefaultSdkVersion(filePath), "1.2.3");
  });

  it("picks up a bumped version automatically", () => {
    const filePath = writeTempPackageJson(JSON.stringify({ version: "0.1.0" }));
    assert.equal(resolveDefaultSdkVersion(filePath), "0.1.0");

    fs.writeFileSync(filePath, JSON.stringify({ version: "0.2.0" }));
    assert.equal(resolveDefaultSdkVersion(filePath), "0.2.0");
  });

  it("throws SdkPackageJsonNotFoundError when the file does not exist", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "check-contract-version-test-"));
    const missingPath = path.join(tmpDir, "does-not-exist.json");

    assert.throws(() => resolveDefaultSdkVersion(missingPath), SdkPackageJsonNotFoundError);
  });

  it("throws SdkVersionMissingError when the file has no version field", () => {
    const filePath = writeTempPackageJson(JSON.stringify({ name: "@tariffshield/sdk" }));

    assert.throws(() => resolveDefaultSdkVersion(filePath), SdkVersionMissingError);
  });
});

describe("real packages/sdk/package.json", () => {
  it("resolves to the actual SDK version on disk", () => {
    const sdkPackageJsonPath = path.join(
      import.meta.dirname,
      "..",
      "..",
      "packages",
      "sdk",
      "package.json",
    );
    const pkg = JSON.parse(fs.readFileSync(sdkPackageJsonPath, "utf-8"));

    assert.equal(resolveDefaultSdkVersion(sdkPackageJsonPath), pkg.version);
  });
});
