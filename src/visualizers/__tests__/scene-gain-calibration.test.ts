import { describe, expect, it } from 'vitest';
import { calibrateBarsLevel, sampleFrequencyBand } from '../scenes/bars';
import { calibrateOrbLevel } from '../scenes/orb';

const calibrations = [
  ['orb', calibrateOrbLevel],
  ['bars (also used by vinyl)', calibrateBarsLevel],
] as const;

describe.each(calibrations)('%s response calibration', (_scene, calibrate) => {
  it('keeps a representative 1x input responsive without saturating', () => {
    const result = calibrate(0.6, 1);

    expect(result).toBeGreaterThan(0.25);
    expect(result).toBeLessThan(0.4);
  });

  it('increases smoothly at high sensitivity while retaining headroom', () => {
    const balanced = calibrate(0.6, 1);
    const strong = calibrate(0.6, 2);

    expect(strong).toBeGreaterThan(balanced * 1.3);
    expect(strong).toBeLessThan(balanced * 1.9);
    expect(strong).toBeLessThan(0.6);
  });

  it('maps invalid and negative inputs to zero', () => {
    expect(calibrate(-1, 1)).toBe(0);
    expect(calibrate(Number.NaN, 1)).toBe(0);
    expect(calibrate(Number.POSITIVE_INFINITY, 1)).toBe(0);
  });
});

describe('spectrum bar frequency sampling', () => {
  it('combines neighboring bins while preserving a narrow peak', () => {
    const bins = new Float32Array(64);
    bins[20] = 0.9;
    bins[21] = 0.3;

    expect(sampleFrequencyBand(bins, 20 / 63)).toBeGreaterThan(0.6);
  });

  it('returns zero for silence and safely clamps invalid positions', () => {
    expect(sampleFrequencyBand(new Float32Array(64), 0.5)).toBe(0);
    expect(sampleFrequencyBand([0.2, 0.4], Number.NaN)).toBeGreaterThan(0);
  });
});

