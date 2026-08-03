import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkCompatibility, CompatibilityError } from './compatibility.js';

describe('SDK Contract Compatibility Matrix', () => {
  it('verifies all matrix entries pass for in-range contract versions', () => {
    // 0.1.0 (v0_1_0 to v0_3_0)
    assert.doesNotThrow(() => checkCompatibility('v0_1_0', '0.1.0'));
    assert.doesNotThrow(() => checkCompatibility('v0_2_0', '0.1.0'));
    assert.doesNotThrow(() => checkCompatibility('v0_3_0', '0.1.0'));

    // 1.0.0 (v0_1_0 to v0_1_0)
    assert.doesNotThrow(() => checkCompatibility('v0_1_0', '1.0.0'));

    // 1.1.0 (v0_1_0 to v0_2_0)
    assert.doesNotThrow(() => checkCompatibility('v0_1_0', '1.1.0'));
    assert.doesNotThrow(() => checkCompatibility('v0_2_0', '1.1.0'));
  });

  it('throws CompatibilityError for out-of-range contract versions', () => {
    // Below range for 1.0.0
    assert.throws(
      () => checkCompatibility('v0_0_9', '1.0.0'),
      (err: unknown) => {
        return (
          err instanceof CompatibilityError &&
          err.sdkVersion === '1.0.0' &&
          err.contractVersion === 'v0_0_9'
        );
      }
    );

    // Above range for 1.0.0 (v0_2_0 > max v0_1_0)
    assert.throws(
      () => checkCompatibility('v0_2_0', '1.0.0'),
      (err: unknown) => {
        return (
          err instanceof CompatibilityError &&
          err.sdkVersion === '1.0.0' &&
          err.contractVersion === 'v0_2_0'
        );
      }
    );

    // Above range for 1.1.0 (v0_3_0 > max v0_2_0)
    assert.throws(
      () => checkCompatibility('v0_3_0', '1.1.0'),
      (err: unknown) => {
        return (
          err instanceof CompatibilityError &&
          err.sdkVersion === '1.1.0' &&
          err.contractVersion === 'v0_3_0'
        );
      }
    );
  });

  it('throws CompatibilityError for unknown SDK versions', () => {
    assert.throws(
      () => checkCompatibility('v0_1_0', '99.0.0'),
      (err: unknown) => err instanceof CompatibilityError
    );
  });
});
