import { describe, expect, it } from 'vitest';
import { mapBlackHoleAudioResponse } from '../scenes/blackhole';
import { mapFractalAudioResponse } from '../scenes/fractal';
import { mapNebulaAudioResponse } from '../scenes/nebula';
import { mapTunnelAudioResponse } from '../scenes/tunnel';

describe('per-scene audio response calibration', () => {
  it('keeps Black Hole modulation restrained from conventional frequency bands', () => {
    const response = mapBlackHoleAudioResponse({
      bass: 0.4, subBass: 0.35, kick: 0.3, mid: 0.25, treble: 0.2, pEnergy: 0.3, beat: 0.4, predictiveBeat: false,
    });
    expect(response.bass).toBeCloseTo(0.312);
    expect(response.treble).toBeCloseTo(0.156);
    expect(response.kick).toBeCloseTo(0.216);
    expect(response.pEnergy).toBeCloseTo(0.216);
    expect(response.transient).toBeCloseTo(0.288);
  });

  it('bounds fractal geometry, highlight and transient drivers', () => {
    const response = mapFractalAudioResponse({
      subBass: 1.4, kick: 1.3, bass: 1.2, mid: 1.1, treble: 1.2, hEnergy: 1.4, beat: 0.2, predictiveBeat: true,
    });
    expect(response).toEqual({ subBass: 1, kick: 1, bass: 1, mid: 1, treble: 1, hEnergy: 1, transient: 0.244 });
  });

  it('uses smoother layered nebula modulation and caps additive-light inputs', () => {
    const response = mapNebulaAudioResponse({
      bass: 0.3, mid: 0.25, pEnergy: 0.2, beat: 0.2, predictiveBeat: false,
    });
    expect(response).toEqual({ bass: 0.3, mid: 0.25, pEnergy: 0.2, transient: 0.2 });
    expect(mapNebulaAudioResponse({
      bass: 2, mid: 2, pEnergy: 2, beat: 2, predictiveBeat: true,
    })).toEqual({ bass: 1, mid: 1, pEnergy: 1, transient: 0.68 });
  });

  it('preserves Tunnel rhythm emphasis without saturating the shader', () => {
    const response = mapTunnelAudioResponse({
      bass: 0.5, mid: 0.2, treble: 0.3, beat: 0.4, pulseScale: 1.8,
      kick: 0.3, flatness: 0.6,
      predictiveBeat: false,
    });
    expect(response.bass).toBeCloseTo(0.355);
    expect(response.mid).toBeCloseTo(0.2);
    expect(response.kick).toBeCloseTo(0.3);
    expect(response.transient).toBe(0.4);
    expect(mapTunnelAudioResponse({
      bass: 3, mid: 3, treble: 3, beat: 3, pulseScale: 9,
      kick: 3, flatness: 3,
      predictiveBeat: true,
    })).toEqual({ bass: 1.15, mid: 1, treble: 1, transient: 0.78, kick: 1.1, flatness: 1 });
  });
});
