import type { RenderAudio } from '../visualizers/types';
import {
  idleView,
  type AudioSourceType,
  type AudioView,
  type CaptureSnapshot,
  type UnifiedAnalysisFrame,
} from './types';

export function createAudioStore() {
  let value: AudioView = { ...idleView };
  const listeners = new Set<() => void>();

  const renderSpectrum = new Float32Array(64);
  const renderAudio: RenderAudio = {
    rms: 0,
    bass: 0,
    mid: 0,
    treble: 0,
    transient: 0,
    spectrum: renderSpectrum,
    silent: true,
    peak: 0,
  };

  let lastValidMs = 0;
  let lastFramePushMs = 0;
  let currentGeneration = 0;
  let heldPeak = 0;

  function sanitize(num: unknown): number {
    if (typeof num !== 'number' || !Number.isFinite(num)) return 0;
    return num;
  }

  function readAudio(nowMs: number = Date.now()): RenderAudio {
    const isRunning = value.state === 'running';
    if (nowMs - lastValidMs >= 250 || !isRunning) {
      renderAudio.silent = true;
      renderAudio.rms *= 0.7;
      renderAudio.bass *= 0.7;
      renderAudio.mid *= 0.7;
      renderAudio.treble *= 0.7;
      renderAudio.transient = 0;
      heldPeak = 0;
      renderAudio.peak = 0;
      for (let i = 0; i < 64; i++) {
        renderSpectrum[i] *= 0.7;
      }
      if (renderAudio.rms < 0.01) {
        renderAudio.rms = 0;
        renderAudio.bass = 0;
        renderAudio.mid = 0;
        renderAudio.treble = 0;
        renderSpectrum.fill(0);
      }
    } else if (nowMs > lastValidMs) {
      // Smooth transient and peak decay envelope between frames
      renderAudio.transient *= 0.90;
      heldPeak *= 0.95;
      renderAudio.peak = heldPeak;
    }
    return renderAudio;
  }

  return {
    getSnapshot: () => value,
    readAudio,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    update(next: Partial<AudioView>) {
      const rms = next.rms ?? (next.analysis ? next.analysis.rms : value.rms);
      const peak = next.peak ?? (next.analysis ? next.analysis.peak : value.peak);
      if (next.peak !== undefined) {
        heldPeak = next.peak;
        renderAudio.peak = next.peak;
      }
      value = { ...value, ...next, rms, peak };
      listeners.forEach((fn) => fn());
    },
    publishFrame(frame: UnifiedAnalysisFrame, nowMs: number = Date.now()) {
      if (value.state === 'idle' || value.state === 'starting') {
        value.state = 'running';
      }
      lastFramePushMs = nowMs;
      lastValidMs = nowMs;

      // Update renderAudio directly
      renderAudio.rms = sanitize(frame.rms);
      renderAudio.bass = sanitize(frame.bands?.[0] ?? (frame.subBass + frame.kick) / 2);
      renderAudio.mid = sanitize(frame.bands?.[1] ?? frame.mids);
      renderAudio.treble = sanitize(frame.bands?.[2] ?? frame.treble);

      const incomingPeak = sanitize(frame.peak);
      heldPeak = Math.max(incomingPeak, heldPeak * 0.95);
      renderAudio.peak = heldPeak;

      const incomingTransient = sanitize(frame.transient);
      renderAudio.transient = Math.max(incomingTransient, renderAudio.transient);

      renderAudio.silent = incomingPeak <= 1e-7 && renderAudio.rms <= 1e-7;

      if (Array.isArray(frame.spectrum)) {
        const count = Math.min(64, frame.spectrum.length);
        for (let i = 0; i < count; i++) {
          renderSpectrum[i] = sanitize(frame.spectrum[i]);
        }
        if (count < 64) {
          renderSpectrum.fill(0, count);
        }
      }

      // Musical intelligence fields
      if (frame.mel) renderAudio.mel = frame.mel;
      if (frame.subBass !== undefined) renderAudio.subBass = sanitize(frame.subBass);
      if (frame.kick !== undefined) renderAudio.kick = sanitize(frame.kick);
      if (frame.phase !== undefined) renderAudio.phase = sanitize(frame.phase);
      if (frame.bpm !== undefined) renderAudio.bpm = sanitize(frame.bpm);
      if (frame.confidence !== undefined) renderAudio.confidence = sanitize(frame.confidence);
      if (frame.beat !== undefined) renderAudio.beat = Boolean(frame.beat);
      if (frame.chroma) renderAudio.chroma = frame.chroma;
      if (frame.centroid !== undefined) renderAudio.centroid = sanitize(frame.centroid);
      if (frame.flatness !== undefined) renderAudio.flatness = sanitize(frame.flatness);
      if (frame.stereoWidth !== undefined) renderAudio.stereoWidth = sanitize(frame.stereoWidth);
      if (frame.waveform) renderAudio.waveform = frame.waveform;
      if (frame.hEnergy !== undefined) renderAudio.hEnergy = sanitize(frame.hEnergy);
      if (frame.pEnergy !== undefined) renderAudio.pEnergy = sanitize(frame.pEnergy);

      const rms = renderAudio.rms;
      const peak = heldPeak;
      value = {
        ...value,
        analysis: frame,
        rms,
        peak,
        silent: renderAudio.silent,
      };
      listeners.forEach((fn) => fn());
      return true;
    },
    publish(next: CaptureSnapshot, nowMs: number = Date.now()) {
      if (
        next.generation < value.generation ||
        (next.generation === value.generation && next.sequence <= value.sequence)
      ) {
        return false;
      }

      if (next.generation !== currentGeneration) {
        currentGeneration = next.generation;
        renderAudio.rms = 0;
        renderAudio.bass = 0;
        renderAudio.mid = 0;
        renderAudio.treble = 0;
        renderAudio.transient = 0;
        heldPeak = 0;
        renderAudio.peak = 0;
        renderAudio.silent = true;
        renderSpectrum.fill(0);
      }

      // Prefer the native push stream while frames are arriving.
      const pushStreamActive = nowMs - lastFramePushMs < 100;

      const analysis = next.analysis;
      if (analysis && !pushStreamActive) {
        renderAudio.rms = sanitize(analysis.rms);
        renderAudio.bass = sanitize(analysis.bands?.[0]);
        renderAudio.mid = sanitize(analysis.bands?.[1]);
        renderAudio.treble = sanitize(analysis.bands?.[2]);
        const incomingPeak = sanitize(analysis.peak);
        heldPeak = Math.max(incomingPeak, heldPeak * 0.95);
        renderAudio.peak = heldPeak;
        const incomingTransient = sanitize(analysis.transient);
        renderAudio.transient = Math.max(incomingTransient, renderAudio.transient);
        renderAudio.silent = next.silent || renderAudio.rms <= 1e-7;

        if (Array.isArray(analysis.spectrum)) {
          const count = Math.min(64, analysis.spectrum.length);
          for (let i = 0; i < count; i++) {
            renderSpectrum[i] = sanitize(analysis.spectrum[i]);
          }
          if (count < 64) {
            renderSpectrum.fill(0, count);
          }
        }

        if (analysis.mel) renderAudio.mel = analysis.mel;
        if (analysis.subBass !== undefined) renderAudio.subBass = sanitize(analysis.subBass);
        if (analysis.kick !== undefined) renderAudio.kick = sanitize(analysis.kick);
        if (analysis.phase !== undefined) renderAudio.phase = sanitize(analysis.phase);
        if (analysis.bpm !== undefined) renderAudio.bpm = sanitize(analysis.bpm);
        if (analysis.confidence !== undefined) renderAudio.confidence = sanitize(analysis.confidence);
        if (analysis.beat !== undefined) renderAudio.beat = Boolean(analysis.beat);
        if (analysis.chroma) renderAudio.chroma = analysis.chroma;
        if (analysis.centroid !== undefined) renderAudio.centroid = sanitize(analysis.centroid);
        if (analysis.flatness !== undefined) renderAudio.flatness = sanitize(analysis.flatness);
        if (analysis.stereoWidth !== undefined) renderAudio.stereoWidth = sanitize(analysis.stereoWidth);
        if (analysis.waveform) renderAudio.waveform = analysis.waveform;
        if (analysis.hEnergy !== undefined) renderAudio.hEnergy = sanitize(analysis.hEnergy);
        if (analysis.pEnergy !== undefined) renderAudio.pEnergy = sanitize(analysis.pEnergy);
      }

      lastValidMs = nowMs;

      const rms = next.analysis?.rms ?? value.rms;
      const peak = pushStreamActive ? heldPeak : (next.analysis?.peak ?? value.peak);
      const silent = next.silent;
      const source: AudioSourceType =
        ['running', 'starting', 'recovering'].includes(next.state) ? 'wasapi' : 'idle';
      const sourceName = source === 'wasapi' ? (next.deviceName ?? 'Windows default output') : undefined;

      value = {
        ...value,
        ...next,
        rms,
        peak,
        silent,
        analysis: next.analysis,
        source,
        sourceName,
      };
      listeners.forEach((fn) => fn());
      return true;
    },
  };
}
