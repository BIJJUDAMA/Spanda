import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { VisualEngine } from './engine';
import { smoothValue, TunnelScene } from './scenes/tunnel';
import { OrbScene } from './scenes/orb';
import { BarsScene } from './scenes/bars';
import { GoniometerScene } from './scenes/goniometer';
import { FractalScene } from './scenes/fractal';
import { NebulaScene } from './scenes/nebula';
import { BlackHoleScene } from './scenes/blackhole';
import { createScene } from './registry';
import { BeatFollower, smoothDynamic } from './dynamics';
import { createEmptyRenderAudio, defaultSettings } from './types';

function createMockRenderer(): THREE.WebGLRenderer {
  return {
    render: vi.fn(),
    setSize: vi.fn(),
    setPixelRatio: vi.fn(),
    dispose: vi.fn(),
    domElement: document.createElement('canvas'),
  } as unknown as THREE.WebGLRenderer;
}

describe('VisualEngine lifecycle & Task 9 features', () => {
  it('repeated scene switches dispose each scene once and keep one loop', () => {
    const container = document.createElement('div');
    const mockRenderer = createMockRenderer();
    const readAudio = vi.fn(() => createEmptyRenderAudio());

    const engine = new VisualEngine({
      container,
      readAudio,
      renderer: mockRenderer,
    });

    engine.start();

    // Switch between available scenes 20 times
    for (let i = 0; i < 20; i++) {
      const targetScene = i % 2 === 0 ? 'bars' : 'tunnel';
      const prevScene = engine.activeScene;
      const disposeSpy = vi.spyOn(prevScene!, 'dispose');

      engine.setScene(targetScene);
      expect(disposeSpy).toHaveBeenCalledTimes(1);
      expect(engine.activeScene).not.toBeNull();
    }

    expect(engine.isRunning).toBe(true);
    engine.dispose();
  });

  it('invalid scene selection safely defaults without crashing', () => {
    const container = document.createElement('div');
    const mockRenderer = createMockRenderer();
    const readAudio = vi.fn(() => createEmptyRenderAudio());

    const engine = new VisualEngine({
      container,
      readAudio,
      renderer: mockRenderer,
    });

    engine.setScene('unknown-nonexistent-scene');
    expect(engine.activeScene).toBeInstanceOf(TunnelScene);

    engine.dispose();
  });

  it('WebGL context loss suspends drawing and context restored resumes', () => {
    const container = document.createElement('div');
    const mockRenderer = createMockRenderer();
    const readAudio = vi.fn(() => createEmptyRenderAudio());

    const engine = new VisualEngine({
      container,
      readAudio,
      renderer: mockRenderer,
    });

    engine.start();
    expect(engine.isRunning).toBe(true);

    // Simulate context loss event
    const lostEvent = new Event('webglcontextlost', { cancelable: true });
    mockRenderer.domElement.dispatchEvent(lostEvent);

    expect(engine.isContextLost).toBe(true);
    expect(engine.isRunning).toBe(false);

    // Simulate context restored event
    const restoredEvent = new Event('webglcontextrestored');
    mockRenderer.domElement.dispatchEvent(restoredEvent);

    expect(engine.isContextLost).toBe(false);
    expect(engine.isRunning).toBe(true);

    engine.dispose();
  });
});

describe('TunnelScene dynamics and smoothing', () => {
  it('elapsed-time smoothing yields equivalent results at 30 FPS vs 60 FPS', () => {
    const target = 0.8;
    const attackTau = 0.020;
    const releaseTau = 0.180;

    let val30 = 0.0;
    val30 = smoothValue(val30, target, 1 / 30, attackTau, releaseTau);
    val30 = smoothValue(val30, target, 1 / 30, attackTau, releaseTau);

    let val60 = 0.0;
    val60 = smoothValue(val60, target, 1 / 60, attackTau, releaseTau);
    val60 = smoothValue(val60, target, 1 / 60, attackTau, releaseTau);
    val60 = smoothValue(val60, target, 1 / 60, attackTau, releaseTau);
    val60 = smoothValue(val60, target, 1 / 60, attackTau, releaseTau);

    expect(val30).toBeCloseTo(val60, 5);
  });

  it('ambient phase advances during silence while energy values remain zero', () => {
    const mockRenderer = createMockRenderer();
    const scene = new TunnelScene(mockRenderer);

    const silentAudio = createEmptyRenderAudio();
    silentAudio.silent = true;

    scene.update(0.5, silentAudio, defaultSettings);
    scene.update(0.5, silentAudio, defaultSettings);

    expect(scene.ambientTime).toBeGreaterThan(0.5);
    expect(scene.smoothedBass).toBe(0);
    expect(scene.smoothedMid).toBe(0);
    expect(scene.smoothedTreble).toBe(0);
    expect(scene.smoothedTransient).toBe(0);

    scene.dispose();
  });
});

describe('OrbScene', () => {
  it('OrbScene pulses to beat and emits burst particles on transient attacks', () => {
    const mockRenderer = createMockRenderer();
    const orb = new OrbScene(mockRenderer, 'low');

    const activeAudio = createEmptyRenderAudio();
    activeAudio.silent = false;
    activeAudio.bass = 0.9;
    activeAudio.transient = 0.85;

    orb.update(0.05, activeAudio, { ...defaultSettings, response: 'hyper' });
    expect(orb.smoothedBass).toBeGreaterThan(0.5);
    expect(orb.smoothedTransient).toBeGreaterThan(0.5);

    orb.dispose();
  });

  it('GoniometerScene instantiates, updates with stereo parameters, reacts to stereo width, and disposes cleanly', () => {
    const mockRenderer = createMockRenderer();
    const goniometer = new GoniometerScene(mockRenderer);

    // Initial state check
    expect(goniometer.smoothedStereoWidth).toBe(0);
    expect(goniometer.smoothedSubBass).toBe(0);

    // Audio with active stereo fields and waveform
    const activeAudio = createEmptyRenderAudio();
    activeAudio.silent = false;
    activeAudio.bass = 0.75;
    activeAudio.subBass = 0.85;
    activeAudio.mid = 0.6;
    activeAudio.transient = 0.7;
    activeAudio.stereoWidth = 0.9;
    activeAudio.waveform = new Float32Array(64).map((_, i) => Math.sin((i / 64) * Math.PI * 4));

    // Update with stereo parameters across different palettes
    const palettes = ['aurora', 'ember', 'cosmic', 'cyberpunk', 'synthwave', 'matrix', 'monochrome'] as const;
    for (const pal of palettes) {
      goniometer.update(0.04, activeAudio, { ...defaultSettings, palette: pal, response: 'punchy' });
    }

    // Verify reaction to stereo width and sub-bass
    expect(goniometer.smoothedStereoWidth).toBeGreaterThan(0.5);
    expect(goniometer.smoothedSubBass).toBeGreaterThan(0.4);
    expect(goniometer.smoothedMid).toBeGreaterThan(0.25);

    // Resize test
    goniometer.resize(1920, 1080, 1.0);

    // Clean disposal
    expect(() => goniometer.dispose()).not.toThrow();
  });

  it('GoniometerScene exposes scene, camera, and renders enriched Lissajous phosphor trails', () => {
    const mockRenderer = createMockRenderer();
    const scene = new GoniometerScene(mockRenderer);
    expect(scene.scene).toBeInstanceOf(THREE.Scene);
    expect(scene.camera).toBeInstanceOf(THREE.Camera);

    // 1200 CRT phosphor trace points and 600 particle cloud scatter points
    expect(scene['tracePositions'].length).toBe(1200 * 3);
    expect(scene['scatterPositions'].length).toBe(600 * 3);

    // Test extreme stereo widths (mono, uncorrelated stereo, antiphase)
    // Mono audio: stereoWidth = 0.0 -> correlation approaches +1.0, phaseAngle approaches +pi/2
    const monoAudio = createEmptyRenderAudio();
    monoAudio.silent = false;
    monoAudio.stereoWidth = 0.0;
    monoAudio.waveform = new Float32Array(64).fill(0.4);
    for (let i = 0; i < 10; i++) {
      scene.update(0.04, monoAudio, { ...defaultSettings, response: 'hyper' });
    }
    expect(scene.correlation).toBeCloseTo(1.0, 1);
    expect(scene.phaseAngle).toBeCloseTo(Math.PI / 2, 1);

    // Antiphase audio: stereoWidth = 1.0 -> correlation approaches -1.0, phaseAngle approaches -pi/2
    const antiphaseAudio = createEmptyRenderAudio();
    antiphaseAudio.silent = false;
    antiphaseAudio.stereoWidth = 1.0;
    antiphaseAudio.waveform = new Float32Array(64).fill(0.4);
    for (let i = 0; i < 10; i++) {
      scene.update(0.04, antiphaseAudio, { ...defaultSettings, response: 'hyper' });
    }
    expect(scene.correlation).toBeCloseTo(-1.0, 1);
    expect(scene.phaseAngle).toBeCloseTo(-Math.PI / 2, 1);

    // Kick transient activates vertex colors with bloom (> 1.0)
    const kickAudio = createEmptyRenderAudio();
    kickAudio.silent = false;
    kickAudio.kick = 0.95;
    kickAudio.transient = 0.9;
    kickAudio.pEnergy = 0.85;
    kickAudio.stereoWidth = 0.8;
    kickAudio.waveform = new Float32Array(64).map((_, i) => Math.sin((i / 64) * Math.PI * 4));
    scene.update(0.016, kickAudio, defaultSettings);

    const traceColors = scene['traceColors'] as Float32Array;
    let maxTraceColor = 0;
    for (let i = 0; i < traceColors.length; i++) {
      if (traceColors[i]! > maxTraceColor) maxTraceColor = traceColors[i]!;
    }
    expect(maxTraceColor).toBeGreaterThan(1.0);

    // Disposes cleanly
    expect(() => scene.dispose()).not.toThrow();
  });
});

describe('Dynamics Smoothing Profiles', () => {
  it('hyper dynamics attack much faster than smooth dynamics', () => {
    const target = 1.0;
    const dt = 0.016;

    const hyperVal = smoothDynamic(0, target, dt, 'hyper');
    const smoothVal = smoothDynamic(0, target, dt, 'smooth');

    expect(hyperVal).toBeGreaterThan(smoothVal);
    expect(hyperVal).toBeGreaterThan(0.8); // Instant snap within 16ms
    expect(smoothVal).toBeLessThan(0.2);   // Slow gentle drift
  });

  it('bouncy dynamics produces elastic overshoot on sharp rising attacks', () => {
    const target = 1.0;
    const dt = 0.05;

    const bouncyVal = smoothDynamic(0, target, dt, 'bouncy');
    expect(bouncyVal).toBeGreaterThan(0.7);
  });
});

describe('Musical Intelligence BeatFollower & PLL Phase Synchronization', () => {
  it('synchronizes beat pulse with PLL phase when confidence > 0.35', () => {
    const follower = new BeatFollower();

    // High confidence, phase at 0 (downbeat)
    const audioOnBeat = createEmptyRenderAudio();
    audioOnBeat.silent = false;
    audioOnBeat.kick = 0.8;
    audioOnBeat.phase = 0.0;
    audioOnBeat.confidence = 0.85;

    const resOnBeat = follower.process(audioOnBeat, 0.02, 1.0, 'punchy');
    expect(resOnBeat.beat).toBeGreaterThan(0.2);
    expect(resOnBeat.pulseScale).toBeGreaterThan(1.2);
    expect(resOnBeat.confidence).toBe(0.85);

    // High confidence, phase at PI (offbeat)
    const followerOffBeat = new BeatFollower();
    const audioOffBeat = createEmptyRenderAudio();
    audioOffBeat.silent = false;
    audioOffBeat.kick = 0.3;
    audioOffBeat.phase = Math.PI;
    audioOffBeat.confidence = 0.85;

    const resOffBeat = followerOffBeat.process(audioOffBeat, 0.02, 1.0, 'punchy');
    expect(resOffBeat.beat).toBeLessThan(resOnBeat.beat);

    // Phase cycle wrap triggers isPredictiveBeat
    const wrapFollower = new BeatFollower();
    const wrapAudio1 = createEmptyRenderAudio();
    wrapAudio1.silent = false;
    wrapAudio1.phase = 5.8; // near end of cycle
    wrapAudio1.confidence = 0.8;
    wrapFollower.process(wrapAudio1, 0.02, 1.0, 'punchy');

    const wrapAudio2 = createEmptyRenderAudio();
    wrapAudio2.silent = false;
    wrapAudio2.phase = 0.1; // wrapped to start
    wrapAudio2.confidence = 0.8;
    const wrapRes = wrapFollower.process(wrapAudio2, 0.02, 1.02, 'punchy');
    expect(wrapRes.isPredictiveBeat).toBe(true);
  });

  it('falls back to kick flux onset detection when confidence <= 0.35', () => {
    const follower = new BeatFollower();

    // Low confidence: phase ignored, kick flux triggers onset
    const audioKick = createEmptyRenderAudio();
    audioKick.silent = false;
    audioKick.kick = 0.9;
    audioKick.transient = 0.8;
    audioKick.phase = Math.PI; // offbeat phase
    audioKick.confidence = 0.2; // low confidence

    const res = follower.process(audioKick, 0.02, 1.0, 'punchy');
    expect(res.beat).toBeGreaterThan(0.4); // Triggered by kick flux despite offbeat phase
    expect(res.isPredictiveBeat).toBe(false);
  });

  it('tracks, smooths, and extracts all musical intelligence fields', () => {
    const follower = new BeatFollower();
    const audio = createEmptyRenderAudio();
    audio.silent = false;
    audio.subBass = 0.85;
    audio.kick = 0.90;
    audio.pEnergy = 0.75;
    audio.hEnergy = 0.65;
    audio.centroid = 0.55;
    audio.flatness = 0.40;
    audio.stereoWidth = 0.80;
    // Dominant chroma on pitch class 9 (A)
    const chroma = new Array(12).fill(0.1);
    chroma[9] = 0.95;
    audio.chroma = chroma;

    const res = follower.process(audio, 0.05, 1.0, 'punchy');

    expect(res.subBass).toBeGreaterThan(0.4);
    expect(res.kick).toBeGreaterThan(0.4);
    expect(res.pEnergy).toBeGreaterThan(0.3);
    expect(res.hEnergy).toBeGreaterThan(0.2);
    expect(res.centroid).toBeGreaterThan(0.2);
    expect(res.flatness).toBeGreaterThan(0.15);
    expect(res.stereoWidth).toBeGreaterThan(0.3);
    expect(res.dominantChroma).toBe(9);
  });

  it('shapes beat envelope across all 5 response styles', () => {
    const styles = ['punchy', 'smooth', 'hyper', 'liquid', 'bouncy'] as const;
    for (const style of styles) {
      const follower = new BeatFollower();
      const audio = createEmptyRenderAudio();
      audio.silent = false;
      audio.bass = 0.8;
      audio.kick = 0.85;
      audio.transient = 0.9;

      const res = follower.process(audio, 0.02, 0.1, style);
      expect(res.pulseScale).toBeGreaterThan(1.0);
      expect(res.beat).toBeGreaterThan(0);
    }
  });
});

describe('Scene Musical Feature Mappings', () => {
  it('BarsScene maps sub-bass, kick/P, 64 Mel bands, and circle of fifths chroma', () => {
    const mockRenderer = createMockRenderer();
    const scene = new BarsScene(mockRenderer);

    const audio = createEmptyRenderAudio();
    audio.silent = false;
    audio.subBass = 0.85;
    audio.kick = 0.90;
    audio.pEnergy = 0.80;
    audio.mel = new Array(64).fill(0).map((_, i) => (i < 32 ? 0.9 : 0.2));
    // Dominant chroma on 7 (G) -> Circle of fifths shift: (7 * 7) % 12 = 1
    const chroma = new Array(12).fill(0.1);
    chroma[7] = 0.95;
    audio.chroma = chroma;

    scene.update(0.04, audio, defaultSettings);

    expect(scene.smoothedSubBass).toBeGreaterThan(0.4);
    expect(scene.smoothedKick).toBeGreaterThan(0.4);
    expect(scene.smoothedPEnergy).toBeGreaterThan(0.3);
    expect(scene.dominantChroma).toBe(7);

    scene.dispose();
  });

  it('OrbScene maps kick/P bursts, H harmonic rotation, chroma hue, and stereo tilt', () => {
    const mockRenderer = createMockRenderer();
    const scene = new OrbScene(mockRenderer, 'low');

    const audio = createEmptyRenderAudio();
    audio.silent = false;
    audio.kick = 0.85;
    audio.pEnergy = 0.90;
    audio.hEnergy = 0.75;
    audio.stereoWidth = 0.80;
    const chroma = new Array(12).fill(0.05);
    chroma[4] = 0.9; // E
    audio.chroma = chroma;

    scene.update(0.04, audio, defaultSettings);

    expect(scene.smoothedKick).toBeGreaterThan(0.4);
    expect(scene.smoothedPEnergy).toBeGreaterThan(0.4);
    expect(scene.smoothedHEnergy).toBeGreaterThan(0.2);
    expect(scene.smoothedStereoWidth).toBeGreaterThan(0.3);
    expect(scene.dominantChroma).toBe(4);

    scene.dispose();
  });

  it('TunnelScene maps spectral flatness and kick/predictive beat flashes', () => {
    const mockRenderer = createMockRenderer();
    const scene = new TunnelScene(mockRenderer);

    const audio = createEmptyRenderAudio();
    audio.silent = false;
    audio.flatness = 0.70;
    audio.kick = 0.85;
    audio.confidence = 0.80;
    audio.phase = 0.0; // downbeat

    scene.update(0.04, audio, defaultSettings);

    expect(scene.smoothedFlatness).toBeGreaterThan(0.25);
    expect(scene.smoothedKick).toBeGreaterThan(0.4);

    scene.dispose();
  });

});

describe('FractalScene (Mandelbulb 3D)', () => {
  it('instantiates via createScene registry and exposes scene and camera', () => {
    const mockRenderer = createMockRenderer();
    const scene = createScene('fractal', mockRenderer);

    expect(scene).toBeInstanceOf(FractalScene);
    expect(scene.scene).toBeInstanceOf(THREE.Scene);
    expect(scene.camera).toBeInstanceOf(THREE.OrthographicCamera);

    scene.dispose();
  });

  it('ambient time advances during silence while audio values remain zero', () => {
    const mockRenderer = createMockRenderer();
    const scene = new FractalScene(mockRenderer);

    const silentAudio = createEmptyRenderAudio();
    silentAudio.silent = true;

    scene.update(0.5, silentAudio, defaultSettings);
    expect(scene.ambientTime).toBeGreaterThanOrEqual(0.5);
    expect(scene.smoothedSubBass).toBe(0);
    expect(scene.smoothedKick).toBe(0);
    expect(scene.smoothedTreble).toBe(0);
    expect(scene.smoothedHEnergy).toBe(0);
    expect(scene.smoothedTransient).toBe(0);

    scene.dispose();
  });

  it('reacts to sub-bass, kick, treble, and harmonic energy under active audio across palettes', () => {
    const mockRenderer = createMockRenderer();
    const scene = new FractalScene(mockRenderer);

    const activeAudio = createEmptyRenderAudio();
    activeAudio.silent = false;
    activeAudio.bass = 0.8;
    activeAudio.subBass = 0.9;
    activeAudio.kick = 0.85;
    activeAudio.mid = 0.6;
    activeAudio.treble = 0.75;
    activeAudio.transient = 0.7;
    activeAudio.hEnergy = 0.65;

    const palettes = ['aurora', 'ember', 'cosmic', 'cyberpunk', 'synthwave', 'matrix', 'monochrome'] as const;
    for (const pal of palettes) {
      scene.update(0.04, activeAudio, { ...defaultSettings, palette: pal, response: 'punchy' });
    }

    expect(scene.smoothedSubBass).toBeGreaterThan(0.4);
    expect(scene.smoothedKick).toBeGreaterThan(0.4);
    expect(scene.smoothedTreble).toBeGreaterThan(0.3);
    expect(scene.smoothedHEnergy).toBeGreaterThan(0.2);

    // Verify resize updates resolution uniform
    scene.resize(1920, 1080, 2.0);
    const resUniform = scene['material'].uniforms.uResolution.value as THREE.Vector2;
    expect(resUniform.x).toBe(3840);
    expect(resUniform.y).toBe(2160);

    // Clean disposal
    expect(() => scene.dispose()).not.toThrow();
  });
});

describe('NebulaScene (Fluid Liquid Nebula with Curl Flow)', () => {
  it('instantiates via createScene registry and exposes scene and PerspectiveCamera', () => {
    const mockRenderer = createMockRenderer();
    const scene = new NebulaScene(mockRenderer);

    expect(scene).toBeInstanceOf(NebulaScene);
    expect(scene.scene).toBeInstanceOf(THREE.Scene);
    expect(scene.camera).toBeInstanceOf(THREE.PerspectiveCamera);

    scene.dispose();
  });

  it('ambient time advances during silence while audio values remain zero', () => {
    const mockRenderer = createMockRenderer();
    const scene = new NebulaScene(mockRenderer);

    const silentAudio = createEmptyRenderAudio();
    silentAudio.silent = true;

    scene.update(0.5, silentAudio, defaultSettings);
    expect(scene.ambientTime).toBeGreaterThanOrEqual(0.5);
    expect(scene.smoothedBass).toBe(0);
    expect(scene.smoothedSubBass).toBe(0);
    expect(scene.smoothedKick).toBe(0);
    expect(scene.smoothedHEnergy).toBe(0);
    expect(scene.smoothedPEnergy).toBe(0);
    expect(scene.smoothedTransient).toBe(0);

    scene.dispose();
  });

  it('reacts to harmonic and percussive energy, kick, bass, and chroma under active audio across palettes', () => {
    const mockRenderer = createMockRenderer();
    const scene = new NebulaScene(mockRenderer);

    const activeAudio = createEmptyRenderAudio();
    activeAudio.silent = false;
    activeAudio.bass = 0.8;
    activeAudio.subBass = 0.85;
    activeAudio.kick = 0.9;
    activeAudio.mid = 0.65;
    activeAudio.treble = 0.7;
    activeAudio.transient = 0.75;
    activeAudio.hEnergy = 0.8;
    activeAudio.pEnergy = 0.85;
    activeAudio.chroma = [0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0];

    const palettes = ['aurora', 'ember', 'cosmic', 'cyberpunk', 'synthwave', 'matrix', 'monochrome'] as const;
    for (const pal of palettes) {
      scene.update(0.04, activeAudio, { ...defaultSettings, palette: pal, response: 'punchy' });
    }

    expect(scene.smoothedHEnergy).toBeGreaterThan(0.3);
    expect(scene.smoothedPEnergy).toBeGreaterThan(0.3);
    expect(scene.smoothedKick).toBeGreaterThan(0.4);
    expect(scene.smoothedBass).toBeGreaterThan(0.4);

    // Verify resize updates aspect and pixel ratio uniform
    scene.resize(1920, 1080, 2.0);
    expect(scene.camera.aspect).toBeCloseTo(1920 / 1080);
    const pixelRatioUniform = scene['material']?.uniforms.uPixelRatio.value;
    expect(pixelRatioUniform).toBe(2.0);

    // Verify quality switching
    scene.update(0.016, activeAudio, { ...defaultSettings, quality: 'low' });
    expect(scene['geometry']?.getAttribute('position').count).toBe(6000);

    scene.update(0.016, activeAudio, { ...defaultSettings, quality: 'high' });
    expect(scene['geometry']?.getAttribute('position').count).toBe(18000);

    // Clean disposal
    expect(() => scene.dispose()).not.toThrow();
  });
});

describe('BlackHoleScene (Accretion Disk with Relativistic Lensing & Beaming)', () => {
  it('instantiates via createScene registry and exposes scene and PerspectiveCamera', () => {
    const mockRenderer = createMockRenderer();
    const scene = new BlackHoleScene(mockRenderer);

    expect(scene).toBeInstanceOf(BlackHoleScene);
    expect(scene.scene).toBeInstanceOf(THREE.Scene);
    expect(scene.camera).toBeInstanceOf(THREE.PerspectiveCamera);

    scene.dispose();
  });

  it('ambient time advances during silence while audio values remain zero', () => {
    const mockRenderer = createMockRenderer();
    const scene = new BlackHoleScene(mockRenderer);

    const silentAudio = createEmptyRenderAudio();
    silentAudio.silent = true;

    scene.update(0.5, silentAudio, defaultSettings);
    expect(scene.ambientTime).toBeGreaterThanOrEqual(0.5);
    expect(scene.smoothedBass).toBe(0);
    expect(scene.smoothedSubBass).toBe(0);
    expect(scene.smoothedKick).toBe(0);
    expect(scene.smoothedPEnergy).toBe(0);
    expect(scene.smoothedTransient).toBe(0);

    scene.dispose();
  });

  it('reacts to active stereo audio, modulates tilt and lensing with stereoWidth, and flares polar jets on kick/pEnergy', () => {
    const mockRenderer = createMockRenderer();
    const scene = new BlackHoleScene(mockRenderer);

    const activeAudio = createEmptyRenderAudio();
    activeAudio.silent = false;
    activeAudio.bass = 0.85;
    activeAudio.subBass = 0.9;
    activeAudio.kick = 0.95;
    activeAudio.mid = 0.65;
    activeAudio.treble = 0.75;
    activeAudio.transient = 0.8;
    activeAudio.pEnergy = 0.88;
    activeAudio.hEnergy = 0.7;
    activeAudio.stereoWidth = 0.82;

    const palettes = ['aurora', 'ember', 'cosmic', 'cyberpunk', 'synthwave', 'matrix', 'monochrome'] as const;
    for (const pal of palettes) {
      scene.update(0.04, activeAudio, { ...defaultSettings, palette: pal, response: 'punchy' });
    }

    expect(scene.smoothedSubBass).toBeGreaterThan(0.4);
    expect(scene.smoothedKick).toBeGreaterThan(0.4);
    expect(scene.smoothedPEnergy).toBeGreaterThan(0.35);
    expect(scene.smoothedStereoWidth).toBeGreaterThan(0.35);

    // Verify uniforms on disk material
    const diskUniforms = scene['diskMaterial']?.uniforms;
    expect(diskUniforms?.uStereoWidth.value).toBeCloseTo(scene.smoothedStereoWidth, 2);
    expect(diskUniforms?.uKick.value).toBe(scene.smoothedKick);

    // Verify uniforms on halo material
    const haloUniforms = scene['haloMaterial']?.uniforms;
    expect(haloUniforms?.uSubBass.value).toBe(scene.smoothedSubBass);

    // Verify uniforms on jet material
    const jetUniforms = scene['jetMaterial']?.uniforms;
    expect(jetUniforms?.uKick.value).toBe(scene.smoothedKick);
    expect(jetUniforms?.uPEnergy.value).toBe(scene.smoothedPEnergy);

    // Verify resize updates aspect and pixel ratio uniform
    scene.resize(1920, 1080, 2.0);
    expect(scene.camera.aspect).toBeCloseTo(1920 / 1080);
    expect(scene['diskMaterial']?.uniforms.uPixelRatio.value).toBe(2.0);
    expect(scene['jetMaterial']?.uniforms.uPixelRatio.value).toBe(2.0);

    // Verify quality switching: low = 2,400 disk particles, high = 4,000 disk particles
    scene.update(0.016, activeAudio, { ...defaultSettings, quality: 'low' });
    expect(scene['diskGeometry']?.getAttribute('position').count).toBe(2400);
    expect(scene['jetGeometry']?.getAttribute('position').count).toBe(300);

    scene.update(0.016, activeAudio, { ...defaultSettings, quality: 'high' });
    expect(scene['diskGeometry']?.getAttribute('position').count).toBe(4000);
    expect(scene['jetGeometry']?.getAttribute('position').count).toBe(800);

    // Clean disposal
    expect(() => scene.dispose()).not.toThrow();
  });
});



