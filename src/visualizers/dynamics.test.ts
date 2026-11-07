import { describe, expect, it } from 'vitest';
import { getEffectiveSensitivity } from './dynamics';

describe('getEffectiveSensitivity', () => {
  it('reduces the default 1× gain while preserving a linear user adjustment', () => {
    expect(getEffectiveSensitivity(1)).toBeCloseTo(0.62);
    expect(getEffectiveSensitivity(0.5)).toBeCloseTo(0.31);
    expect(getEffectiveSensitivity(2)).toBeCloseTo(1.24);
  });

  it('bounds invalid and out-of-range values', () => {
    expect(getEffectiveSensitivity(Number.NaN)).toBeCloseTo(0.62);
    expect(getEffectiveSensitivity(-1)).toBeCloseTo(0.155);
    expect(getEffectiveSensitivity(9)).toBeCloseTo(1.24);
  });
});
