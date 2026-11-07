import * as THREE from 'three';
import type { RenderAudio, VisualScene, VisualSettings } from '../../types';
import { smoothDynamic, DYNAMIC_PROFILES, getEffectiveSensitivity } from '../../dynamics';
import { PALETTES } from '../../palettes';

const POINTS_COUNT = 1200;

// Compress only the visual drive, preserving detail at quiet levels while
// keeping loud tracks and hyper dynamics inside the scope's readable bounds.
function scopeDrive(value: number): number {
  const positive = Math.max(0, value);
  return positive / (1 + positive * 0.55);
}

export class OscilloscopeScene implements VisualScene {
  public scene: THREE.Scene;
  public camera: THREE.OrthographicCamera;
  private line: THREE.Line;
  private glowLine: THREE.Line;
  private graticule: THREE.LineSegments;
  private geometry: THREE.BufferGeometry;
  private glowGeometry: THREE.BufferGeometry;
  private material: THREE.LineBasicMaterial;
  private glowMaterial: THREE.LineBasicMaterial;
  private renderer: THREE.WebGLRenderer;

  private ambientTime: number = 0;
  private positions: Float32Array;
  private colors: Float32Array;
  private glowPositions: Float32Array;
  private glowColors: Float32Array;

  public smoothedBass: number = 0;
  public smoothedMid: number = 0;
  public smoothedTreble: number = 0;
  public smoothedTransient: number = 0;

  constructor(renderer: THREE.WebGLRenderer) {
    this.renderer = renderer;
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1.77, 1.77, 1.0, -1.0, 0, 10);
    this.camera.position.z = 2;

    // 1. Create a subtle retro CRT boundary and division marks
    const gridPositions: number[] = [];
    // Reference division tick marks
    for (let x = -1.2; x <= 1.25; x += 0.3) {
      if (Math.abs(x) > 1e-6) gridPositions.push(x, -0.02, 0, x, 0.02, 0);
    }
    for (let y = -0.8; y <= 0.85; y += 0.2) {
      if (Math.abs(y) > 1e-6) gridPositions.push(-0.02, y, 0, 0.02, y, 0);
    }
    // Outer circular boundary ring
    const ringSegments = 64;
    for (let i = 0; i < ringSegments; i++) {
      const a1 = (i / ringSegments) * Math.PI * 2;
      const a2 = ((i + 1) / ringSegments) * Math.PI * 2;
      gridPositions.push(Math.cos(a1) * 1.35, Math.sin(a1) * 0.85, 0);
      gridPositions.push(Math.cos(a2) * 1.35, Math.sin(a2) * 0.85, 0);
    }

    const gridGeo = new THREE.BufferGeometry();
    gridGeo.setAttribute('position', new THREE.Float32BufferAttribute(gridPositions, 3));
    const gridMat = new THREE.LineBasicMaterial({
      color: 0x1f2937,
      transparent: true,
      opacity: 0.35,
    });
    this.graticule = new THREE.LineSegments(gridGeo, gridMat);
    this.scene.add(this.graticule);

    // 2. Primary Sharp Electron Beam
    this.positions = new Float32Array(POINTS_COUNT * 3);
    this.colors = new Float32Array(POINTS_COUNT * 3);
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));

    this.material = new THREE.LineBasicMaterial({
      vertexColors: true,
      linewidth: 2,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
    });
    this.line = new THREE.Line(this.geometry, this.material);
    this.scene.add(this.line);

    // 3. Phosphor Bloom Halo Trail
    this.glowPositions = new Float32Array(POINTS_COUNT * 3);
    this.glowColors = new Float32Array(POINTS_COUNT * 3);
    this.glowGeometry = new THREE.BufferGeometry();
    this.glowGeometry.setAttribute('position', new THREE.BufferAttribute(this.glowPositions, 3));
    this.glowGeometry.setAttribute('color', new THREE.BufferAttribute(this.glowColors, 3));

    this.glowMaterial = new THREE.LineBasicMaterial({
      vertexColors: true,
      linewidth: 4,
      transparent: true,
      opacity: 0.45,
      blending: THREE.AdditiveBlending,
    });
    this.glowLine = new THREE.Line(this.glowGeometry, this.glowMaterial);
    this.scene.add(this.glowLine);
  }

  update(dtSeconds: number, audio: RenderAudio, settings: VisualSettings): void {
    this.ambientTime += dtSeconds * 1.6;

    const dynStyle = settings.response;
    const profile = DYNAMIC_PROFILES[dynStyle] ?? DYNAMIC_PROFILES.punchy;
    const sens = getEffectiveSensitivity(settings.sensitivity);

    const targetBass = audio.silent ? 0 : scopeDrive(audio.bass * sens * profile.bassMultiplier * 0.82);
    const targetMid = audio.silent ? 0 : scopeDrive(audio.mid * sens * 0.9);
    const targetTreble = audio.silent ? 0 : scopeDrive(audio.treble * sens * 0.9);
    const targetTransient = audio.silent ? 0 : scopeDrive(audio.transient * sens * profile.transientMultiplier * 0.72);

    this.smoothedBass = smoothDynamic(this.smoothedBass, targetBass, dtSeconds, dynStyle);
    this.smoothedMid = smoothDynamic(this.smoothedMid, targetMid, dtSeconds, dynStyle);
    this.smoothedTreble = smoothDynamic(this.smoothedTreble, targetTreble, dtSeconds, dynStyle);
    this.smoothedTransient = smoothDynamic(
      this.smoothedTransient,
      targetTransient,
      dtSeconds,
      dynStyle,
    );

    const palette = PALETTES[settings.palette] ?? PALETTES.aurora;

    // Update Graticule color with subtle tint of palette
    (this.graticule.material as THREE.LineBasicMaterial).color.copy(palette.a).multiplyScalar(0.25);

    const pos = this.positions;
    const cols = this.colors;
    const glowPos = this.glowPositions;
    const glowCols = this.glowColors;

    const spectrum = audio.spectrum;
    const spectrumLen = spectrum ? spectrum.length : 64;

    const bassScale = 0.7 + this.smoothedBass * 0.55 + this.smoothedTransient * 0.25;
    const midScale = 0.55 + this.smoothedMid * 0.45;
    const trebleMod = this.smoothedTreble * 0.4;
    const t = this.ambientTime;

    const freqA = 2.0 + Math.floor(this.smoothedBass * 3.5);
    const freqB = 3.0 + Math.floor(this.smoothedMid * 4.5);
    const phaseA = t * 1.35;
    const phaseB = t * 0.85 + this.smoothedTransient * Math.PI;

    const tempColor = new THREE.Color();

    for (let i = 0; i < POINTS_COUNT; i++) {
      const u = (i / (POINTS_COUNT - 1)) * Math.PI * 2;
      const specIdx = Math.floor((i / POINTS_COUNT) * spectrumLen);
      const rawSpectrum = spectrum && !audio.silent ? Math.max(0, spectrum[specIdx] ?? 0) : 0;
      const specAmp = scopeDrive(rawSpectrum * sens) * 0.2;

      // Real-time Lissajous harmonic knot formulation
      let x = Math.sin(u * freqA + phaseA) * bassScale;
      let y = Math.cos(u * freqB + phaseB) * midScale;

      // High-frequency harmonic flutter & ripple
      const ripple = Math.sin(u * 20.0 + t * 5.0) * (trebleMod + specAmp);
      x += ripple * 0.18;
      y += Math.cos(u * 15.0 - t * 4.0) * (trebleMod + specAmp) * 0.18;

      pos[i * 3] = x;
      pos[i * 3 + 1] = y;
      pos[i * 3 + 2] = 0;

      // Soft glow line with slight chromatic phase displacement
      glowPos[i * 3] = x * 1.015;
      glowPos[i * 3 + 1] = y * 1.015;
      glowPos[i * 3 + 2] = 0;

      // Multi-stop rainbow/palette color interpolation along the trace
      const colorRatio = (i / POINTS_COUNT + t * 0.1) % 1.0;
      if (colorRatio < 0.5) {
        tempColor.lerpColors(palette.a, palette.b, colorRatio * 2.0);
      } else {
        tempColor.lerpColors(palette.b, palette.c, (colorRatio - 0.5) * 2.0);
      }

      // Add transient flash intensity
      const flash = this.smoothedTransient * 0.35;
      cols[i * 3] = Math.min(1.0, tempColor.r + flash);
      cols[i * 3 + 1] = Math.min(1.0, tempColor.g + flash);
      cols[i * 3 + 2] = Math.min(1.0, tempColor.b + flash);

      glowCols[i * 3] = tempColor.r * 0.8;
      glowCols[i * 3 + 1] = tempColor.g * 0.8;
      glowCols[i * 3 + 2] = tempColor.b * 0.8;
    }

    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.color.needsUpdate = true;
    this.glowGeometry.attributes.position.needsUpdate = true;
    this.glowGeometry.attributes.color.needsUpdate = true;

    this.renderer.render(this.scene, this.camera);
  }

  resize(width: number, height: number, _pixelRatio: number): void {
    const aspect = width / Math.max(height, 1);
    this.camera.left = -aspect;
    this.camera.right = aspect;
    this.camera.top = 1.0;
    this.camera.bottom = -1.0;
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.glowGeometry.dispose();
    this.glowMaterial.dispose();
    this.graticule.geometry.dispose();
    (this.graticule.material as THREE.Material).dispose();
    this.scene.remove(this.line);
    this.scene.remove(this.glowLine);
    this.scene.remove(this.graticule);
  }
}
