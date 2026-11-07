import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { GoniometerScene } from '../scenes/goniometer';
import { OscilloscopeScene } from '../scenes/oscilloscope';
import { createEmptyRenderAudio, defaultSettings } from '../types';

function mockRenderer(): THREE.WebGLRenderer {
  return { render: vi.fn() } as unknown as THREE.WebGLRenderer;
}

function maxAbs(values: Float32Array): number {
  let max = 0;
  for (const value of values) max = Math.max(max, Math.abs(value));
  return max;
}

describe('scene response calibration at global 1x', () => {
  it('keeps Oscilloscope traces bounded using measured audio bands', () => {
    const scene = new OscilloscopeScene(mockRenderer());
    const trace = scene as unknown as { positions: Float32Array };
    const settings = { ...defaultSettings, sensitivity: 1 };
    const active = createEmptyRenderAudio();
    Object.assign(active, {
      silent: false,
      bass: 0.7,
      mid: 0.65,
      treble: 0.55,
      transient: 0.7,
      spectrum: new Float32Array(64).fill(1),
    });

    scene.update(1 / 60, active, settings);
    expect(Array.from(trace.positions).every(Number.isFinite)).toBe(true);
    expect(maxAbs(trace.positions)).toBeLessThan(2.5);
    expect(scene.smoothedBass).toBeGreaterThan(0);
    expect(scene.smoothedMid).toBeGreaterThan(0);
    expect(scene.smoothedTransient).toBeGreaterThan(0);
    scene.dispose();
  });

  it('preserves Goniometer stereo response while limiting audio-driven bloom and scatter', () => {
    const scene = new GoniometerScene(mockRenderer());
    const trace = scene as unknown as { tracePositions: Float32Array; scatterPositions: Float32Array };
    const active = createEmptyRenderAudio();
    Object.assign(active, {
      silent: false,
      rms: 0.7,
      bass: 0.8,
      mid: 0.65,
      treble: 0.5,
      transient: 0.8,
      kick: 0.9,
      pEnergy: 0.75,
      stereoWidth: 0.55,
      waveform: Float32Array.from({ length: 128 }, (_, i) => Math.sin((i / 128) * Math.PI * 8) * 0.8),
    });

    scene.update(1 / 60, active, { ...defaultSettings, sensitivity: 1 });
    expect(Array.from(trace.tracePositions).every(Number.isFinite)).toBe(true);
    expect(Array.from(trace.scatterPositions).every(Number.isFinite)).toBe(true);
    expect(maxAbs(trace.tracePositions)).toBeLessThan(2);
    expect(scene.smoothedStereoWidth).toBeGreaterThan(0);
    expect(scene.smoothedStereoWidth).toBeLessThan(0.55);
    expect(scene.smoothedBass).toBeGreaterThan(0);
    scene.dispose();
  });
});
