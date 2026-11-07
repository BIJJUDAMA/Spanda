import * as THREE from 'three';
import type { RenderAudio, VisualScene, VisualSettings } from '../../types';
import { BeatFollower, getEffectiveSensitivity } from '../../dynamics';
import { PALETTES } from '../../palettes';
import tunnelFragShader from './shaders/tunnel.frag.glsl?raw';

export interface TunnelAudioResponse { bass: number; mid: number; treble: number; transient: number; kick: number; flatness: number; }

export function mapTunnelAudioResponse(input: {
  bass: number; mid: number; treble: number; beat: number; pulseScale: number;
  kick: number; flatness: number;
  predictiveBeat: boolean;
}): TunnelAudioResponse {
  return {
    // Tunnel keeps the most explicit beat motion, while all shader drivers stay in a useful range.
    bass: Math.min(1.15, input.bass * (0.55 + Math.min(1.25, input.pulseScale - 1) * 0.20)),
    mid: Math.min(1.0, input.mid),
    treble: Math.min(1.0, input.treble),
    transient: Math.min(0.78, input.predictiveBeat ? Math.max(input.beat, 0.58) : input.beat),
    kick: Math.min(1.1, input.kick),
    flatness: Math.min(1.0, Math.max(0, input.flatness)),
  };
}

export function smoothValue(
  current: number,
  target: number,
  dt: number,
  attackTau: number,
  releaseTau: number
): number {
  if (dt <= 0) return current;
  const tau = target > current ? attackTau : releaseTau;
  const alpha = 1.0 - Math.exp(-dt / tau);
  const next = current + alpha * (target - current);
  return Math.abs(next) < 1e-4 ? 0 : next;
}

export class TunnelScene implements VisualScene {
  public scene: THREE.Scene;
  public camera: THREE.OrthographicCamera;
  private mesh: THREE.Mesh;
  private material: THREE.ShaderMaterial;
  private geometry: THREE.PlaneGeometry;
  private renderer: THREE.WebGLRenderer;

  public ambientTime: number = 0;
  private beatFollower: BeatFollower = new BeatFollower();

  public get smoothedBass(): number {
    return this.beatFollower.smoothedBass;
  }
  public get smoothedMid(): number {
    return this.beatFollower.smoothedMid;
  }
  public get smoothedTreble(): number {
    return this.beatFollower.smoothedTreble;
  }
  public get smoothedTransient(): number {
    return this.beatFollower.beatEnergy;
  }
  public get smoothedKick(): number {
    return this.beatFollower.smoothedKick;
  }
  public get smoothedFlatness(): number {
    return this.beatFollower.smoothedFlatness;
  }

  constructor(renderer: THREE.WebGLRenderer) {
    this.renderer = renderer;
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this.geometry = new THREE.PlaneGeometry(2, 2);
    this.material = new THREE.ShaderMaterial({
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position, 1.0);
        }
      `,
      fragmentShader: tunnelFragShader,
      uniforms: {
        uTime: { value: 0 },
        uResolution: { value: new THREE.Vector2(800, 600) },
        uBass: { value: 0 },
        uMid: { value: 0 },
        uTreble: { value: 0 },
        uTransient: { value: 0 },
        uFlatness: { value: 0 },
        uKick: { value: 0 },
        uColorA: { value: PALETTES.aurora.a },
        uColorB: { value: PALETTES.aurora.b },
        uColorC: { value: PALETTES.aurora.c },
      },
      depthWrite: false,
      depthTest: false,
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.scene.add(this.mesh);
  }

  update(dtSeconds: number, audio: RenderAudio, settings: VisualSettings): void {
    this.ambientTime += dtSeconds;
    const sens = getEffectiveSensitivity(settings.sensitivity);

    const rawBass = audio.silent ? 0 : audio.bass * sens;
    const rawMid = audio.silent ? 0 : audio.mid * sens;
    const rawTreble = audio.silent ? 0 : audio.treble * sens;
    const rawTransient = audio.silent ? 0 : audio.transient * sens;

    const { bass, mid, treble, beat, pulseScale, kick, flatness, isPredictiveBeat } =
      this.beatFollower.process(
        rawBass,
        rawMid,
        rawTreble,
        rawTransient,
        dtSeconds,
        this.ambientTime,
        settings.response,
        {
          subBass: audio.silent ? 0 : (audio.subBass ?? audio.bass) * sens,
          kick: audio.silent ? 0 : (audio.kick ?? audio.bass) * sens,
          pEnergy: audio.silent ? 0 : (audio.pEnergy ?? 0) * sens,
          hEnergy: audio.silent ? 0 : (audio.hEnergy ?? 0),
          centroid: audio.silent ? 0 : audio.centroid,
          flatness: audio.silent ? 0 : audio.flatness,
          stereoWidth: audio.silent ? 0 : audio.stereoWidth,
          chroma: audio.silent ? undefined : audio.chroma,
          phase: audio.phase,
          confidence: audio.silent ? 0 : audio.confidence,
          beat: audio.beat,
        }
      );

    const palette = PALETTES[settings.palette] ?? PALETTES.aurora;

    this.material.uniforms.uTime.value = this.ambientTime;
    const response = mapTunnelAudioResponse({
      bass, mid, treble, beat, pulseScale, kick, flatness,
      predictiveBeat: isPredictiveBeat,
    });
    this.material.uniforms.uBass.value = response.bass;
    this.material.uniforms.uMid.value = response.mid;
    this.material.uniforms.uTreble.value = response.treble;
    // Kick and predictive beat trigger tunnel contraction and white transient flashes
    this.material.uniforms.uTransient.value = response.transient;
    this.material.uniforms.uKick.value = response.kick;
    // Spectral flatness modulates wireframe facet distortion
    this.material.uniforms.uFlatness.value = response.flatness;
    this.material.uniforms.uColorA.value = palette.a;
    this.material.uniforms.uColorB.value = palette.b;
    this.material.uniforms.uColorC.value = palette.c;

    this.renderer.render(this.scene, this.camera);
  }

  resize(width: number, height: number, pixelRatio: number): void {
    this.material.uniforms.uResolution.value.set(width * pixelRatio, height * pixelRatio);
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.scene.remove(this.mesh);
  }
}
