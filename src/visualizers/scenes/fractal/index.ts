import * as THREE from 'three';
import type { RenderAudio, VisualScene, VisualSettings } from '../../types';
import { PALETTES } from '../../palettes';
import { BeatFollower, getEffectiveSensitivity } from '../../dynamics';
import fractalVertShader from './shaders/fractal.vert.glsl?raw';
import fractalFragShader from './shaders/fractal.frag.glsl?raw';

export interface FractalAudioResponse { subBass: number; kick: number; bass: number; mid: number; treble: number; hEnergy: number; transient: number; }

const unit = (value: number): number => Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;

export function mapFractalAudioResponse(input: {
  subBass: number; kick: number; bass: number; mid: number; treble: number;
  hEnergy: number; beat: number;
  predictiveBeat: boolean;
}): FractalAudioResponse {
  const beat = unit(input.beat);
  return {
    // Keep audio visible in the shape while limiting how far the bulb can morph.
    subBass: unit(unit(input.subBass) * 0.72),
    kick: unit(unit(input.kick) * 0.68),
    bass: unit(unit(input.bass) * 0.72),
    mid: unit(unit(input.mid) * 0.76),
    treble: unit(unit(input.treble) * 0.70),
    hEnergy: unit(input.hEnergy) * 0.75,
    // A PLL prediction adds a restrained accent to the measured beat envelope;
    // it never replaces that envelope with a fixed-strength pulse.
    transient: Math.min(0.58, beat * 0.72 + (input.predictiveBeat ? 0.10 : 0)),
  };
}

export class FractalScene implements VisualScene {
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
  public get smoothedSubBass(): number {
    return this.beatFollower.smoothedSubBass;
  }
  public get smoothedKick(): number {
    return this.beatFollower.smoothedKick;
  }
  public get smoothedMid(): number {
    return this.beatFollower.smoothedMid;
  }
  public get smoothedTreble(): number {
    return this.beatFollower.smoothedTreble;
  }
  public get smoothedHEnergy(): number {
    return this.beatFollower.smoothedHEnergy;
  }
  public get smoothedTransient(): number {
    return this.beatFollower.beatEnergy;
  }

  constructor(renderer: THREE.WebGLRenderer) {
    this.renderer = renderer;
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this.geometry = new THREE.PlaneGeometry(2, 2);
    this.material = new THREE.ShaderMaterial({
      vertexShader: fractalVertShader,
      fragmentShader: fractalFragShader,
      uniforms: {
        uTime: { value: 0 },
        uResolution: { value: new THREE.Vector2(800, 600) },
        uSubBass: { value: 0 },
        uKick: { value: 0 },
        uBass: { value: 0 },
        uMid: { value: 0 },
        uTreble: { value: 0 },
        uHEnergy: { value: 0 },
        uTransient: { value: 0 },
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
    // Ambient motion advances during both active audio and silence
    this.ambientTime += dtSeconds;
    const sens = getEffectiveSensitivity(settings.sensitivity);

    const rawBass = audio.silent ? 0 : audio.bass * sens;
    const rawMid = audio.silent ? 0 : audio.mid * sens;
    const rawTreble = audio.silent ? 0 : audio.treble * sens;
    const rawTransient = audio.silent ? 0 : audio.transient * sens;

    const { bass, mid, treble, beat, subBass, kick, hEnergy, isPredictiveBeat } =
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
          hEnergy: audio.silent ? 0 : (audio.hEnergy ?? 0) * sens,
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
    const response = mapFractalAudioResponse({
      subBass, kick, bass, mid, treble, hEnergy, beat,
      predictiveBeat: isPredictiveBeat,
    });

    this.material.uniforms.uTime.value = this.ambientTime;
    // Bass changes the bulb geometry and camera distance; drums drive its transient flash.
    this.material.uniforms.uSubBass.value = response.subBass;
    this.material.uniforms.uKick.value = response.kick;
    this.material.uniforms.uBass.value = response.bass;
    this.material.uniforms.uMid.value = response.mid;
    // Vocal activity adds a distinct specular response without removing treble detail.
    this.material.uniforms.uTreble.value = response.treble;
    this.material.uniforms.uHEnergy.value = response.hEnergy;
    this.material.uniforms.uTransient.value = response.transient;
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
