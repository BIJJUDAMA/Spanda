import { describe, expect, it } from 'vitest';
import { createEmptyRenderAudio } from '../../types';
import { RippleTiming } from './rippleTiming';

describe('ripple beat timing', () => {
  it('launches immediately on a beat and does not repeat a held flag', () => {
    const timing = new RippleTiming();
    const audio = { ...createEmptyRenderAudio(), silent: false, beat: true };
    expect(timing.update(audio, 1 / 60)).toBe(true);
    for (let i = 0; i < 60; i++) expect(timing.update(audio, 1 / 60)).toBe(false);
    timing.update({ ...audio, beat: false }, 1 / 60);
    expect(timing.update(audio, 1 / 60)).toBe(true);
  });

  it('does not interpret sustained loudness as repeating beats', () => {
    const timing = new RippleTiming();
    const audio = { ...createEmptyRenderAudio(), silent: false, kick: 0.9, pEnergy: 0.9 };
    for (let i = 0; i < 120; i++) expect(timing.update(audio, 1 / 60)).toBe(false);
  });

  it('uses measured phase crossings and coalesces a nearby beat flag', () => {
    const timing = new RippleTiming();
    const audio = { ...createEmptyRenderAudio(), silent: false, phase: 5.9, confidence: 0.9, bpm: 120 };
    expect(timing.update(audio, 1 / 60)).toBe(false);
    expect(timing.update({ ...audio, phase: 0.1 }, 1 / 60)).toBe(true);
    expect(timing.update({ ...audio, phase: 0.2, beat: true }, 1 / 60)).toBe(false);
  });

  it('allows a fresh percussion onset without tempo lock and suppresses silence', () => {
    const timing = new RippleTiming();
    const audio = { ...createEmptyRenderAudio(), silent: false, transient: 0.7, kick: 0.6 };
    expect(timing.update(audio, 1 / 60)).toBe(true);
    expect(timing.update({ ...audio, silent: true, beat: true }, 0.5)).toBe(false);
  });
});
