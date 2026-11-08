import { expect, it } from 'vitest';
import { SceneBeatResponse } from './beat-response';
import { createEmptyRenderAudio, defaultSettings } from './types';
const steady = () => ({ ...createEmptyRenderAudio(), silent: false, rms: .1, peak: .2, bass: .1, mid: .1, treble: .1 });
it('accents a reported beat even when band levels and transient values do not change', () => {
  const response = new SceneBeatResponse(), audio = steady(); response.update(1 / 60, audio, defaultSettings);
  expect(response.pulse).toBe(0);
  response.update(1 / 60, { ...audio, beat: true }, defaultSettings);
  expect(response.triggered).toBe(true); expect(response.pulse).toBeGreaterThan(.4); expect(response.age).toBe(0);
  let triggers = 1;
  for (let i = 0; i < 120; i++) { response.update(1 / 60, { ...audio, beat: true }, defaultSettings); if (response.triggered) triggers++; }
  expect(triggers).toBe(1); expect(response.pulse).toBeLessThan(.001);
});
it('uses a confident phase wrap and measured onsets when confidence is low', () => {
  const response = new SceneBeatResponse(), audio = steady();
  response.update(.016, { ...audio, phase: 6.1, confidence: .9 }, defaultSettings);
  response.update(.016, { ...audio, phase: .05, confidence: .9 }, defaultSettings);
  expect(response.triggered).toBe(true);
  const low = new SceneBeatResponse(); low.update(.016, { ...audio, phase: 6.1, confidence: .2 }, defaultSettings);
  low.update(.016, { ...audio, phase: .05, confidence: .2 }, defaultSettings); expect(low.triggered).toBe(false);
  low.update(.016, { ...audio, kick: .7 }, defaultSettings); expect(low.triggered).toBe(true);
});
it('never generates beats from BPM alone or stale beat metadata during silence', () => {
  const response = new SceneBeatResponse();
  for (let i = 0; i < 300; i++) response.update(1 / 60, { ...steady(), bpm: 120 }, defaultSettings);
  expect(response.pulse).toBe(0);
  for (let i = 0; i < 300; i++) {
    response.update(1 / 60, { ...steady(), silent: true, beat: true, kick: 1, transient: 1, confidence: 1, phase: i % 2 ? .05 : 6 }, defaultSettings);
    expect(response.triggered).toBe(false);
  }
  expect(response.pulse).toBe(0);
});
it('respects sensitivity and dynamics without unbounded pulses', () => {
  const beat = { ...steady(), beat: true }, low = new SceneBeatResponse(), high = new SceneBeatResponse(), smooth = new SceneBeatResponse();
  low.update(.016, beat, { ...defaultSettings, sensitivity: .25 });
  high.update(.016, beat, { ...defaultSettings, sensitivity: 2 });
  smooth.update(.016, beat, { ...defaultSettings, response: 'smooth' });
  expect(high.pulse).toBeGreaterThan(low.pulse); expect(high.pulse).toBeGreaterThan(smooth.pulse); expect(high.pulse).toBeLessThanOrEqual(1);
});
