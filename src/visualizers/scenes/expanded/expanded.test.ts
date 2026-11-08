import { frontNodeWeight, nodeTwinkle } from './constellation-glow';
import { createAudioStore } from '../../../audio/store';
import { defaultAnalysisFrame } from '../../../audio/types';
import * as THREE from 'three';
import { PALETTES } from '../../palettes';
import { describe, expect, it, vi } from 'vitest';
import { LiquidInterferenceScene, ParticleConstellationScene, TypographyScene, KaleidoscopeScene } from './index';
import { createEmptyRenderAudio, defaultSettings } from '../../types';

describe('expanded scenes', () => {
  it('maps liquid bands to independent bounded waves and respects silence', () => {
    const scene = new LiquidInterferenceScene();
    scene.resize(1920, 1080);
    scene.update(.1, { ...createEmptyRenderAudio(), silent: false, bass: .8, mid: .3, treble: .1 }, defaultSettings);
    expect(scene.material.uniforms.uBass.value).toBeGreaterThan(scene.material.uniforms.uMid.value);
    expect(scene.material.uniforms.uMid.value).toBeGreaterThan(scene.material.uniforms.uTreble.value);
    expect(scene.material.uniforms.uAspect.value).toBeCloseTo(1920 / 1080);
    for (let i = 0; i < 60; i++) scene.update(.1, createEmptyRenderAudio(), defaultSettings);
    expect(scene.material.uniforms.uBass.value).toBeLessThan(.001);
    scene.dispose();
  });
  it('keeps constellation geometry and connections bounded through repeated hits', () => {
    const scene = new ParticleConstellationScene();
    scene.resize(360, 800);
    for (let i = 0; i < 200; i++) scene.update(.016, { ...createEmptyRenderAudio(), silent: false, mid: 1, transient: 1 }, defaultSettings);
    expect(scene.geometry.drawRange.count).toBeGreaterThanOrEqual(128);
    expect(scene.positions).toHaveLength(256 * 3);
    expect(scene.positions.every(Number.isFinite)).toBe(true);
    expect(scene.links.drawRange.count).toBeLessThanOrEqual(1536);
    expect(scene.links.drawRange.count).toBeGreaterThan(0);
    const dispose = vi.spyOn(scene.links, 'dispose'); scene.dispose(); expect(dispose).toHaveBeenCalledOnce();
  });
  it('redraws typography only when its bounded text changes and releases its texture', () => {
    const context = { clearRect: vi.fn(), measureText: () => ({ width: 600 }), fillText: vi.fn() };
    const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
    try {
      const scene = new TypographyScene();
      scene.update(.016, createEmptyRenderAudio(), { ...defaultSettings, typographyText: 'Hello' });
      scene.update(.016, createEmptyRenderAudio(), { ...defaultSettings, typographyText: 'Hello' });
      expect(context.fillText).toHaveBeenCalledTimes(1);
      scene.update(.016, createEmptyRenderAudio(), { ...defaultSettings, typographyText: 'x'.repeat(100) });
      expect(context.fillText).toHaveBeenLastCalledWith('x'.repeat(48), 768, 256);
      const dispose = vi.spyOn(scene.texture, 'dispose'); scene.dispose(); expect(dispose).toHaveBeenCalledOnce();
    } finally { spy.mockRestore(); }
  });
});

it('drives kaleidoscope symmetry with bounded band controls and releases resources', () => {
  const scene = new KaleidoscopeScene(); scene.resize(360, 800);
  scene.update(.1, { ...createEmptyRenderAudio(), silent: false, bass: .8, mid: .4, treble: .2, transient: 1 }, defaultSettings);
  expect(scene.material.uniforms.uBass.value).toBeGreaterThan(scene.material.uniforms.uMid.value);
  expect(scene.material.uniforms.uPulse.value).toBeGreaterThan(0);
  expect(scene.material.uniforms.uAspect.value).toBeCloseTo(360 / 800);
  for (let i = 0; i < 60; i++) scene.update(.1, createEmptyRenderAudio(), defaultSettings);
  expect(scene.material.uniforms.uBass.value).toBeLessThan(.001);
  const dispose = vi.spyOn(scene.material, 'dispose'); scene.dispose(); expect(dispose).toHaveBeenCalledOnce();
});
it('starts with the original 128-point appearance and only adds slow radial reshaping', () => {
  const scene = new ParticleConstellationScene(), quiet = createEmptyRenderAudio();
  scene.update(0, quiet, defaultSettings);
  expect(scene.camera.position.z).toBe(7.4);
  expect(scene.scene.children).toHaveLength(3);
  expect(scene.scene.children.every(object => object instanceof THREE.Points || object instanceof THREE.LineSegments)).toBe(true);
  for (let i = 0; i < 128; i++) {
    const angle = i * 2.399963, y = 1 - 2 * (i + .5) / 128;
    const radius = 2.5 + Math.sin(i * 1.71) * .25, ring = Math.sqrt(1 - y * y);
    expect(scene.positions[i * 3]).toBeCloseTo(Math.cos(angle) * ring * radius, 5);
    expect(scene.positions[i * 3 + 1]).toBeCloseTo(y * radius, 5);
    expect(scene.positions[i * 3 + 2]).toBeCloseTo(Math.sin(angle) * ring * radius, 5);
  }
  expect(scene.material.color.getHex()).toBe(0xffffff);
  expect(scene.linkMaterial.color.getHex()).toBe(0xffffff);
  expect(scene.material.size).toBe(.035); expect(scene.linkMaterial.opacity).toBe(.14);
  const initial = scene.positions.slice(), previous = initial.slice(); let maximumStep = 0, largestPull = 0;
  for (let frame = 0; frame < 1200; frame++) {
    scene.update(1 / 60, quiet, defaultSettings);
    for (let i = 0; i < 128; i++) {
      const index = i * 3;
      const originalRadius = 2.5 + Math.sin(i * 1.71 + (frame + 1) / 60 * .3) * .25;
      largestPull = Math.max(largestPull, Math.abs(Math.hypot(...scene.positions.slice(index, index + 3)) - originalRadius));
      maximumStep = Math.max(maximumStep, Math.hypot(scene.positions[index] - previous[index], scene.positions[index + 1] - previous[index + 1], scene.positions[index + 2] - previous[index + 2]));
    }
    previous.set(scene.positions);
    expect(scene.links.drawRange.count).toBeLessThanOrEqual(1536);
  }
  expect(maximumStep).toBeLessThan(.01);
  expect(largestPull).toBeGreaterThan(.4);
  const node = 40, angleBefore = Math.atan2(initial[node * 3 + 2], initial[node * 3]);
  const angleAfter = Math.atan2(scene.positions[node * 3 + 2], scene.positions[node * 3]);
  expect(angleAfter - angleBefore).toBeCloseTo(.16, 4);
  scene.dispose();
});

it('maps native beat metadata into all three scenes and typography without changing the band levels', () => {
  const context = { clearRect: vi.fn(), measureText: () => ({ width: 600 }), fillText: vi.fn() };
  const canvas = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
  try {
    const store = createAudioStore();
    const base = { ...defaultAnalysisFrame, rms: .1, peak: .2, bands: [.1, .1, .1] as [number, number, number] };
    const scenes = [new LiquidInterferenceScene(), new KaleidoscopeScene(), new TypographyScene(), new ParticleConstellationScene()];
    store.publishFrame(base, 1000);
    for (const scene of scenes) { scene.resize(1280, 720); scene.update(1 / 60, store.readAudio(1000), defaultSettings); expect(scene.rhythm.pulse).toBe(0); }
    const constellation = scenes[3] as ParticleConstellationScene;
    const before = constellation.positions.slice();
    store.publishFrame({ ...base, beat: true }, 1017);
    for (const scene of scenes) {
      scene.update(1 / 60, store.readAudio(1017), defaultSettings);
      expect(scene.rhythm.pulse).toBeGreaterThan(.4);
      if (!(scene instanceof ParticleConstellationScene)) expect(scene.material.uniforms.uBeat.value).toBeGreaterThan(.4);
    }
    let changed = 0;
    for (let i = 0; i < before.length; i++) if (Math.abs(before[i] - constellation.positions[i]) > .01) changed++;
    expect(changed).toBeGreaterThan(100);
    for (let i = 0; i < 240; i++) for (const scene of scenes) scene.update(1 / 60, createEmptyRenderAudio(), defaultSettings);
    for (const scene of scenes) { expect(scene.rhythm.pulse).toBeLessThan(.001); scene.dispose(); }
  } finally { canvas.mockRestore(); }
});
it('shows all palette colors on constellation points and connections', () => {
  const scene = new ParticleConstellationScene(); scene.update(0, createEmptyRenderAudio(), defaultSettings);
  for (const target of [PALETTES.aurora.a, PALETTES.aurora.b, PALETTES.aurora.c]) {
    let closest = Infinity;
    for (let i = 0; i < 128 * 4; i += 4) closest = Math.min(closest, Math.hypot(scene.colors[i] - target.r, scene.colors[i + 1] - target.g, scene.colors[i + 2] - target.b));
    expect(closest).toBeLessThan(.04);
  }
  expect(scene.material.vertexColors).toBe(true);
  expect(scene.links.attributes.color.count).toBe(1536);
  scene.dispose();
});

it('grows gradually with time and beats, fades new nodes and stops at a fixed capacity', () => {
  const timed = new ParticleConstellationScene(), rhythmic = new ParticleConstellationScene();
  const quiet = createEmptyRenderAudio();
  timed.update(0, quiet, defaultSettings); rhythmic.update(0, quiet, defaultSettings);
  expect(timed.geometry.drawRange.count).toBe(128);
  for (let frame = 0; frame < 60; frame++) {
    timed.update(.1, quiet, defaultSettings);
    rhythmic.update(.1, { ...quiet, silent: false, rms: .1, beat: frame % 5 === 0 }, defaultSettings);
  }
  expect(timed.geometry.drawRange.count).toBe(130);
  expect(rhythmic.geometry.drawRange.count).toBeGreaterThan(timed.geometry.drawRange.count);
  expect(timed.colors[128 * 4 + 3]).toBeGreaterThan(0);
  expect(timed.colors[129 * 4 + 3]).toBeLessThan(1);
  const positionBuffer = rhythmic.positions;
  for (let frame = 0; frame < 1800; frame++) rhythmic.update(.1, { ...quiet, silent: false, rms: .1, beat: frame % 2 === 0 }, defaultSettings);
  expect(rhythmic.geometry.drawRange.count).toBe(256);
  expect(rhythmic.positions).toBe(positionBuffer);
  expect(rhythmic.links.drawRange.count).toBeLessThanOrEqual(1536);
  expect(rhythmic.positions.every(Number.isFinite)).toBe(true);
  timed.dispose(); rhythmic.dispose();
});

it('gives isolated treble a fast, independent response even with smooth dynamics and no beat', () => {
  const scene = new KaleidoscopeScene();
  const highs = { ...createEmptyRenderAudio(), silent: false, treble: .5 };
  scene.update(1 / 60, highs, { ...defaultSettings, response: 'smooth' });
  expect(scene.material.uniforms.uHigh.value).toBeGreaterThan(.2);
  expect(scene.material.uniforms.uHighAttack.value).toBeGreaterThan(.5);
  expect(scene.material.uniforms.uBass.value).toBe(0); expect(scene.rhythm.pulse).toBe(0);
  for (let i = 0; i < 180; i++) scene.update(1 / 60, createEmptyRenderAudio(), { ...defaultSettings, response: 'smooth' });
  expect(scene.material.uniforms.uHigh.value).toBe(0); expect(scene.material.uniforms.uHighAttack.value).toBe(0);
  scene.dispose();
});
it('uses high spectrum detail without mistaking bass bins for treble', () => {
  const highScene = new KaleidoscopeScene(), bassScene = new KaleidoscopeScene();
  const spectrum = new Float32Array(64); spectrum[56] = .8;
  highScene.update(.016, { ...createEmptyRenderAudio(), silent: false, spectrum }, defaultSettings);
  expect(highScene.material.uniforms.uHigh.value).toBeGreaterThan(.2);
  const bass = new Float32Array(64); bass.fill(.8, 0, 20);
  bassScene.update(.016, { ...createEmptyRenderAudio(), silent: false, bass: .8, spectrum: bass }, defaultSettings);
  expect(bassScene.material.uniforms.uHigh.value).toBe(0);
  highScene.dispose(); bassScene.dispose();
});
it('preserves high-frequency dynamic range and respects sensitivity and silent gating', () => {
  const low = new KaleidoscopeScene(), high = new KaleidoscopeScene(), silent = new KaleidoscopeScene();
  const audio = { ...createEmptyRenderAudio(), silent: false, treble: .3, spectrum: new Float32Array(64).fill(.7) };
  for (let i = 0; i < 30; i++) {
    low.update(.016, audio, { ...defaultSettings, sensitivity: .25 });
    high.update(.016, audio, { ...defaultSettings, sensitivity: 2 });
    silent.update(.016, { ...audio, silent: true }, defaultSettings);
  }
  expect(high.material.uniforms.uHigh.value).toBeGreaterThan(low.material.uniforms.uHigh.value);
  expect(high.material.uniforms.uHigh.value).toBeLessThan(1);
  expect(silent.material.uniforms.uHigh.value).toBe(0); expect(silent.material.uniforms.uHighAttack.value).toBe(0);
  low.dispose(); high.dispose(); silent.dispose();
});

it('receives isolated high-band energy through the native analysis store', () => {
  const store = createAudioStore(), scene = new KaleidoscopeScene();
  store.publishFrame({ ...defaultAnalysisFrame, rms: .1, peak: .3, bands: [0, 0, .6] }, 1000);
  scene.update(.016, store.readAudio(1000), defaultSettings);
  expect(scene.material.uniforms.uHigh.value).toBeGreaterThan(.3);
  expect(scene.material.uniforms.uBass.value).toBe(0); expect(scene.rhythm.pulse).toBe(0);
  scene.dispose();
});


it('lights only camera-facing nodes on a beat while preserving palette and mesh brightness', () => {
  const scene = new ParticleConstellationScene(), quiet = createEmptyRenderAudio();
  scene.resize(1280, 720);
  scene.update(0, quiet, defaultSettings);
  expect(scene.nodeGlow.every(value => value === 0)).toBe(true);
  const buffer = scene.nodeGlow;
  scene.update(1 / 60, { ...quiet, silent: false, rms: .1, beat: true }, defaultSettings);
  expect(scene.rhythm.pulse).toBeGreaterThan(.4);
  let front = 0, rear = 0, partial = 0;
  for (let i = 0; i < 128; i++) {
    const x = scene.positions[i * 3], y = scene.positions[i * 3 + 1], z = scene.positions[i * 3 + 2];
    const facing = z / Math.hypot(x, y, z);
    expect(scene.nodeGlow[i]).toBeCloseTo(scene.rhythm.pulse * frontNodeWeight(facing), 6);
    if (facing <= 0) { rear++; expect(scene.nodeGlow[i]).toBe(0); }
    if (facing >= .7) { front++; expect(scene.nodeGlow[i]).toBeCloseTo(scene.rhythm.pulse, 6); }
    if (facing > .15 && facing < .7) partial++;
    expect(scene.colors[i * 4 + 3]).toBe(1);
  }
  expect(front).toBeGreaterThan(10); expect(rear).toBeGreaterThan(40); expect(partial).toBeGreaterThan(10);
  expect(scene.material.size).toBe(.035);
  expect(scene.linkMaterial.opacity).toBe(.14);
  expect(scene.nodeGlow).toBe(buffer);
  const core = scene.scene.children[0] as THREE.Points;
  const halo = scene.scene.children[2] as THREE.Points;
  expect(halo.geometry).toBe(core.geometry);
  expect(scene.glowMaterial.blending).toBe(THREE.AdditiveBlending);
  expect(scene.glowMaterial.depthWrite).toBe(false);
  // Growth opacity and palette tint are shared with the original points, including the halo.
  expect(scene.glowMaterial.fragmentShader).toContain('vTint.rgb');
  expect(scene.glowMaterial.fragmentShader).toContain('vTint.a');
  scene.dispose();
});

it('moves the illuminated cap with the camera and releases beat glow in silence', () => {
  const scene = new ParticleConstellationScene(), quiet = createEmptyRenderAudio();
  scene.update(1 / 60, { ...quiet, silent: false, rms: .1, beat: true }, defaultSettings);
  const before = scene.nodeGlow.slice();
  scene.camera.position.set(0, 0, -8); scene.camera.lookAt(0, 0, 0);
  scene.update(0, { ...quiet, silent: false, beat: true }, defaultSettings);
  let newlyLit = 0;
  for (let i = 0; i < 128; i++) {
    if (before[i] > 0) expect(scene.nodeGlow[i]).toBe(0);
    if (scene.nodeGlow[i] > 0) { expect(before[i]).toBe(0); newlyLit++; }
  }
  expect(newlyLit).toBeGreaterThan(20);
  for (let i = 0; i < 240; i++) scene.update(1 / 60, { ...quiet, beat: true, transient: 1 }, defaultSettings);
  expect(scene.nodeGlow.every(value => value === 0)).toBe(true);
  expect(scene.nodeGlow.every(Number.isFinite)).toBe(true);
  const dispose = vi.spyOn(scene.glowMaterial, 'dispose');
  scene.dispose(); expect(dispose).toHaveBeenCalledOnce();
});

it('blends front depth continuously instead of switching nodes abruptly', () => {
  expect(frontNodeWeight(-1)).toBe(0);
  expect(frontNodeWeight(.15)).toBe(0);
  expect(frontNodeWeight(.7)).toBe(1);
  expect(frontNodeWeight(1)).toBe(1);
  expect(frontNodeWeight(.425)).toBeCloseTo(.5);
  let previous = 0;
  for (let facing = -.99; facing <= 1; facing += .01) {
    const weight = frontNodeWeight(facing);
    expect(weight).toBeGreaterThanOrEqual(previous);
    expect(weight - previous).toBeLessThan(.03);
    previous = weight;
  }
});


it('staggers smooth node twinkles and modestly enlarges the framing', () => {
  const scene = new ParticleConstellationScene(), quiet = createEmptyRenderAudio();
  scene.resize(1920, 1080); scene.update(0, quiet, defaultSettings);
  expect(scene.camera.position.z).toBe(7.4);
  expect(scene.camera.fov).toBe(55);
  expect(scene.geometry.drawRange.count).toBe(128);
  const buffer = scene.twinkles;
  const initial = scene.twinkles.slice(0, 128);
  expect(initial.filter(value => value > .8).length).toBeGreaterThan(5);
  expect(initial.filter(value => value < .05).length).toBeGreaterThan(40);
  let largestStep = 0;
  for (let i = 0; i < 128; i++) {
    const now = nodeTwinkle(0, i), next = nodeTwinkle(1 / 60, i);
    expect(now).toBeGreaterThanOrEqual(0); expect(now).toBeLessThanOrEqual(1);
    largestStep = Math.max(largestStep, Math.abs(next - now));
  }
  expect(largestStep).toBeLessThan(.06);
  scene.update(.1, quiet, defaultSettings);
  expect(scene.twinkles).toBe(buffer);
  expect(scene.twinkles.slice(0, 128)).not.toEqual(initial);
  expect(scene.nodeGlow.every(value => value === 0)).toBe(true);
  scene.resize(360, 800);
  expect(scene.camera.position.z).toBeCloseTo(7.4 / (360 / 800));
  expect(scene.twinkles.every(Number.isFinite)).toBe(true);
  scene.dispose();
});
