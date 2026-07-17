import { describe, expect, it } from 'vitest';

import { compareVersions } from '../modules/version-utils.js';

describe('version utils', () => {
  it('compares numeric semantic versions', () => {
    expect(compareVersions('1.2.5', '1.2.6')).toBe(-1);
    expect(compareVersions('1.2.6', '1.2.6')).toBe(0);
    expect(compareVersions('1.3.0', '1.2.6')).toBe(1);
  });
});
