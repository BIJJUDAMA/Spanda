import { describe, expect, it } from 'vitest';
import { createAudioStore } from './store';
import { defaultAnalysisFrame, idleAnalysis, idleSnapshot, type CaptureSnapshot } from './types';

describe('defaultAnalysisFrame', () => {
  it('has 64-element mel, spectrum, waveform, and 12-element chroma', () => {
    expect(defaultAnalysisFrame.mel).toHaveLength(64);
    expect(defaultAnalysisFrame.spectrum).toHaveLength(64);
    expect(defaultAnalysisFrame.waveform).toHaveLength(64);
    expect(defaultAnalysisFrame.chroma).toHaveLength(12);
    expect(defaultAnalysisFrame.bands).toEqual([0, 0, 0]);
    expect(defaultAnalysisFrame.beat).toBe(false);
    expect(defaultAnalysisFrame.subBass).toBe(0);
    expect(defaultAnalysisFrame.kick).toBe(0);
  });
});

describe('createAudioStore readAudio', () => {
  it('sanitizes invalid and nonfinite payloads to zero', () => {
    const store = createAudioStore();
    const badSnapshot: CaptureSnapshot = {
      ...idleSnapshot,
      generation: 1,
      sequence: 1,
      state: 'running',
      analysis: {
        ...idleAnalysis,
        rms: Number.NaN,
        peak: Number.POSITIVE_INFINITY,
        bands: [Number.NaN, Number.NEGATIVE_INFINITY, 'bad' as unknown as number],
        spectrum: [Number.NaN, Number.POSITIVE_INFINITY, 0.5],
        transient: Number.NaN,
      },
      silent: false,
    };

    store.publish(badSnapshot, 1000);
    const audio = store.readAudio(1050);

    expect(audio.rms).toBe(0);
    expect(audio.bass).toBe(0);
    expect(audio.mid).toBe(0);
    expect(audio.treble).toBe(0);
    expect(audio.transient).toBe(0);
    expect(audio.spectrum[0]).toBe(0);
    expect(audio.spectrum[1]).toBe(0);
    expect(audio.spectrum[2]).toBe(0.5);
  });

  it('handles wrong spectrum bin counts gracefully', () => {
    const store = createAudioStore();
    // Too few bins
    const fewBins: CaptureSnapshot = {
      ...idleSnapshot,
      generation: 1,
      sequence: 1,
      state: 'running',
      analysis: {
        ...idleAnalysis,
        rms: 0.5,
        spectrum: [0.1, 0.2, 0.3],
      },
      silent: false,
    };
    store.publish(fewBins, 1000);
    let audio = store.readAudio(1050);
    expect(audio.spectrum.length).toBe(64);
    expect(audio.spectrum[0]).toBeCloseTo(0.1);
    expect(audio.spectrum[1]).toBeCloseTo(0.2);
    expect(audio.spectrum[2]).toBeCloseTo(0.3);
    expect(audio.spectrum[3]).toBe(0);

    // Too many bins (e.g. 128)
    const manyBins: CaptureSnapshot = {
      ...idleSnapshot,
      generation: 1,
      sequence: 2,
      state: 'running',
      analysis: {
        ...idleAnalysis,
        rms: 0.5,
        spectrum: new Array(128).fill(0.9),
      },
      silent: false,
    };
    store.publish(manyBins, 1100);
    audio = store.readAudio(1150);
    expect(audio.spectrum.length).toBe(64);
    expect(audio.spectrum[63]).toBeCloseTo(0.9);
  });

  it('resets render audio on generation change', () => {
    const store = createAudioStore();
    store.publish(
      {
        ...idleSnapshot,
        generation: 1,
        sequence: 1,
        state: 'running',
        analysis: {
          ...idleAnalysis,
          rms: 0.8,
          bands: [0.7, 0.6, 0.5],
          spectrum: new Array(64).fill(0.5),
        },
        silent: false,
      },
      1000
    );

    let audio = store.readAudio(1050);
    expect(audio.rms).toBe(0.8);
    expect(audio.bass).toBe(0.7);

    // New session generation
    store.publish(
      {
        ...idleSnapshot,
        generation: 2,
        sequence: 1,
        state: 'running',
        analysis: {
          ...idleAnalysis,
          rms: 0.2,
          bands: [0.1, 0.1, 0.1],
          spectrum: new Array(64).fill(0.1),
        },
        silent: false,
      },
      2000
    );

    audio = store.readAudio(2050);
    expect(audio.rms).toBe(0.2);
    expect(audio.bass).toBe(0.1);
    expect(audio.spectrum[0]).toBeCloseTo(0.1);
  });

  it('decays toward zero and marks silent after 250 ms without fresh data', () => {
    const store = createAudioStore();
    store.publish(
      {
        ...idleSnapshot,
        generation: 1,
        sequence: 1,
        state: 'running',
        analysis: {
          ...idleAnalysis,
          rms: 0.5,
          bands: [0.5, 0.5, 0.5],
          spectrum: new Array(64).fill(0.5),
        },
        silent: false,
      },
      1000
    );

    // Within 250ms: active
    let audio = store.readAudio(1100);
    expect(audio.silent).toBe(false);
    expect(audio.rms).toBe(0.5);

    // 251ms later: decays toward zero and marks silent
    audio = store.readAudio(1251);
    expect(audio.silent).toBe(true);
    expect(audio.rms).toBeLessThan(0.5);
    expect(audio.bass).toBeLessThan(0.5);

    // Repeated reads without new data decay to zero
    for (let t = 1300; t < 2000; t += 50) {
      audio = store.readAudio(t);
    }
    expect(audio.rms).toBe(0);
    expect(audio.spectrum[0]).toBe(0);

    // New fresh data restores response
    store.publish(
      {
        ...idleSnapshot,
        generation: 1,
        sequence: 2,
        state: 'running',
        analysis: {
          ...idleAnalysis,
          rms: 0.7,
          bands: [0.6, 0.5, 0.4],
          spectrum: new Array(64).fill(0.6),
        },
        silent: false,
      },
      2050
    );

    audio = store.readAudio(2060);
    expect(audio.silent).toBe(false);
    expect(audio.rms).toBe(0.7);
    expect(audio.bass).toBe(0.6);
  });

  it('recovers from 5-second frontend stall using latest snapshot without replay backlog', () => {
    const store = createAudioStore();
    store.publish(
      {
        ...idleSnapshot,
        generation: 1,
        sequence: 1,
        state: 'running',
        analysis: {
          ...idleAnalysis,
          rms: 0.5,
        },
        silent: false,
      },
      1000
    );

    // Simulate 5-second stall where no readAudio was invoked and intermediate packets arrived
    const latestSnapshot: CaptureSnapshot = {
      ...idleSnapshot,
      generation: 1,
      sequence: 150, // 150 frames later (~5 seconds at 30 fps)
      state: 'running',
      analysis: {
        ...idleAnalysis,
        rms: 0.42,
        bands: [0.8, 0.5, 0.2],
        spectrum: new Array(64).fill(0.42),
      },
      silent: false,
    };

    store.publish(latestSnapshot, 6000);

    // Read directly after stall
    const audio = store.readAudio(6016);
    expect(audio.rms).toBe(0.42);
    expect(audio.bass).toBe(0.8);
    expect(audio.silent).toBe(false);
  });
});

describe('createAudioStore native source attribution', () => {
  it('initializes with idle source', () => {
    const store = createAudioStore();
    expect(store.getSnapshot().source).toBe('idle');
    expect(store.getSnapshot().sourceName).toBeUndefined();
  });

  it('derives source and endpoint name from capture snapshots', () => {
    const store = createAudioStore();
    store.publish({ ...idleSnapshot, generation: 1, sequence: 1, state: 'running', deviceName: 'Speakers (Realtek)' });
    expect(store.getSnapshot().source).toBe('wasapi');
    expect(store.getSnapshot().sourceName).toBe('Speakers (Realtek)');

    store.publish({ ...idleSnapshot, generation: 1, sequence: 2 });
    expect(store.getSnapshot().source).toBe('idle');
    expect(store.getSnapshot().sourceName).toBeUndefined();
  });

  it('updates renderAudio and snapshot levels when publishing native frames', () => {
    const store = createAudioStore();
    store.publish({ ...idleSnapshot, generation: 1, sequence: 1, state: 'running', deviceName: 'Speakers' }, 900);

    store.publishFrame(
      {
        ...defaultAnalysisFrame,
        rms: 0.35,
        peak: 0.85,
        subBass: 0.4,
        kick: 0.7,
        mids: 0.3,
        treble: 0.2,
        bands: [0.55, 0.3, 0.2],
        transient: 0.6,
      },
      1000
    );

    const snapshot = store.getSnapshot();
    expect(snapshot.source).toBe('wasapi');
    expect(snapshot.sourceName).toBe('Speakers');
    expect(snapshot.rms).toBeCloseTo(0.35);
    expect(snapshot.peak).toBeCloseTo(0.85);
    expect(snapshot.silent).toBe(false);

    const render = store.readAudio(1000);
    expect(render.rms).toBeCloseTo(0.35);
    expect(render.peak).toBeCloseTo(0.85);
    expect(render.bass).toBeCloseTo(0.55);
    expect(render.silent).toBe(false);
  });

});
