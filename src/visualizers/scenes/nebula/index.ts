import * as THREE from 'three';
import type { Palette, Quality, RenderAudio, VisualScene, VisualSettings } from '../../types';
import { PALETTES } from '../../palettes';
import { BeatFollower, getEffectiveSensitivity } from '../../dynamics';
import nebulaVertShader from './shaders/nebula.vert.glsl?raw';
import nebulaFragShader from './shaders/nebula.frag.glsl?raw';

export interface NebulaAudioResponse { bass: number; mid: number; pEnergy: number; transient: number; }

export function mapNebulaAudioResponse(input: {
  bass: number; mid: number; pEnergy: number; beat: number; predictiveBeat: boolean;
}): NebulaAudioResponse {
  return {
    // Broad, layered modulation suits the drifting cloud; keep additive particle light below saturation.
    bass: Math.min(1.0, input.bass),
    mid: Math.min(1.0, input.mid),
    pEnergy: Math.min(1.0, input.pEnergy),
    transient: Math.min(0.68, input.predictiveBeat ? Math.max(input.beat, 0.46) : input.beat),
  };
}

const PARTICLE_COUNTS: Record<Quality, number> = {
  low: 4000,
  medium: 8500,
  high: 13000,
};

export class NebulaScene implements VisualScene {
  public scene: THREE.Scene;
  public camera: THREE.PerspectiveCamera;
  private points: THREE.Points | null = null;
  private geometry: THREE.BufferGeometry | null = null;
  private material: THREE.ShaderMaterial | null = null;
  private renderer: THREE.WebGLRenderer;

  public ambientTime: number = 0;
  private chromaAngle: number = 0;
  private currentQuality: Quality = 'medium';
  private currentPalette: Palette = 'aurora';
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
  public get smoothedPEnergy(): number {
    return this.beatFollower.smoothedPEnergy;
  }
  public get smoothedTransient(): number {
    return this.beatFollower.beatEnergy;
  }
  public get palette(): Palette {
    return this.currentPalette;
  }

  constructor(renderer: THREE.WebGLRenderer, quality: Quality = 'medium') {
    this.renderer = renderer;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    this.camera.position.set(0, 4, 18);
    this.camera.lookAt(0, 0, 0);

    this.recreateParticles(quality, 'aurora');
  }

  private recreateParticles(quality: Quality, paletteKey: Palette): void {
    if (this.points) {
      this.scene.remove(this.points);
      this.geometry?.dispose();
      this.material?.dispose();
      this.points = null;
      this.geometry = null;
      this.material = null;
    }

    this.currentQuality = quality;
    this.currentPalette = paletteKey;
    const count = PARTICLE_COUNTS[quality] ?? PARTICLE_COUNTS.medium;

    const positions = new Float32Array(count * 3);
    const seeds = new Float32Array(count * 4); // x: phase, y: speed, z: filament index, w: lifetime
    const sizes = new Float32Array(count);
    const alphas = new Float32Array(count);

    for (let i = 0; i < count; i++) {
      // 3 spiral logarithmic arms + central core cloud
      const arm = i % 3;
      const armOffset = (arm * Math.PI * 2) / 3;
      const radius = 0.8 + Math.pow(Math.random(), 0.72) * 12.5;
      const spiralAngle = armOffset + Math.log(radius + 1.0) * 2.2 + (Math.random() - 0.5) * 0.65;
      const verticalSpread = (Math.random() - 0.5) * 2.6 * Math.exp(-radius * 0.14);

      positions[i * 3] = Math.cos(spiralAngle) * radius;
      positions[i * 3 + 1] = verticalSpread;
      positions[i * 3 + 2] = Math.sin(spiralAngle) * radius;

      seeds[i * 4] = Math.random() * Math.PI * 2; // phase
      seeds[i * 4 + 1] = 0.65 + Math.random() * 0.7; // drift speed
      seeds[i * 4 + 2] = arm / 3.0 + (Math.random() - 0.5) * 0.12; // filament index
      seeds[i * 4 + 3] = 0.4 + Math.random() * 0.6; // lifetime factor

      // Keep each point compact so additive overlap preserves cloud structure.
      sizes[i] = 1.5 + Math.random() * 2.2;
      alphas[i] = 0.3 + Math.random() * 0.42;
    }

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));
    this.geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    this.geometry.setAttribute('aAlpha', new THREE.BufferAttribute(alphas, 1));

    const palette = PALETTES[paletteKey] ?? PALETTES.aurora;

    this.material = new THREE.ShaderMaterial({
      vertexShader: nebulaVertShader,
      fragmentShader: nebulaFragShader,
      uniforms: {
        uTime: { value: 0 },
        uBass: { value: 0 },
        uSubBass: { value: 0 },
        uKick: { value: 0 },
        uMid: { value: 0 },
        uTreble: { value: 0 },
        uHEnergy: { value: 0 },
        uPEnergy: { value: 0 },
        uTransient: { value: 0 },
        uChromaShift: { value: 0 },
        uColorA: { value: palette.a },
        uColorB: { value: palette.b },
        uColorC: { value: palette.c },
        uPixelRatio: { value: 1.0 },
      },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
    });

    this.points = new THREE.Points(this.geometry, this.material);
    this.scene.add(this.points);
  }

  public update(dtSeconds: number, audio: RenderAudio, settings: VisualSettings): void {
    // Ambient motion advances continuously during both audio activity and silence
    this.ambientTime += dtSeconds;

    if (settings.quality !== this.currentQuality) {
      this.recreateParticles(settings.quality, settings.palette);
    }

    const sens = getEffectiveSensitivity(settings.sensitivity);
    const scaledAudio: RenderAudio = audio.silent
      ? audio
      : {
          ...audio,
          bass: (audio.bass ?? 0) * sens,
          subBass: (audio.subBass ?? audio.bass ?? 0) * sens,
          kick: (audio.kick ?? audio.bass ?? 0) * sens,
          mid: (audio.mid ?? 0) * sens,
          treble: (audio.treble ?? 0) * sens,
          transient: (audio.transient ?? 0) * sens,
          pEnergy: (audio.pEnergy ?? 0) * sens,
          hEnergy: (audio.hEnergy ?? 0) * sens,
        };

    const {
      bass,
      mid,
      treble,
      beat,
      subBass,
      kick,
      pEnergy,
      hEnergy,
      dominantChroma,
      isPredictiveBeat,
    } = this.beatFollower.process(scaledAudio, dtSeconds, this.ambientTime, settings.response);

    // Smoothly rotate chroma color gradient angle
    if (!audio.silent) {
      const targetAngle = (dominantChroma / 12.0) * Math.PI * 2.0;
      let diff = targetAngle - this.chromaAngle;
      while (diff < -Math.PI) diff += Math.PI * 2;
      while (diff > Math.PI) diff -= Math.PI * 2;
      this.chromaAngle += diff * Math.min(1.0, dtSeconds * 3.5);
    }

    this.currentPalette = settings.palette;
    const palette = PALETTES[settings.palette] ?? PALETTES.aurora;
    const response = mapNebulaAudioResponse({
      bass, mid, pEnergy, beat,
      predictiveBeat: isPredictiveBeat,
    });

    if (this.material) {
      this.material.uniforms.uTime.value = this.ambientTime;
      this.material.uniforms.uBass.value = response.bass;
      this.material.uniforms.uSubBass.value = subBass;
      this.material.uniforms.uKick.value = kick;
      this.material.uniforms.uMid.value = response.mid;
      this.material.uniforms.uTreble.value = treble;
      this.material.uniforms.uHEnergy.value = hEnergy;
      this.material.uniforms.uPEnergy.value = response.pEnergy;
      this.material.uniforms.uTransient.value = response.transient;
      this.material.uniforms.uChromaShift.value = this.chromaAngle / (Math.PI * 2.0);
      this.material.uniforms.uColorA.value = palette.a;
      this.material.uniforms.uColorB.value = palette.b;
      this.material.uniforms.uColorC.value = palette.c;
    }

    // Camera ambient orbital drift (soothing, smooth, non-disorienting)
    this.camera.position.x = Math.sin(this.ambientTime * 0.08) * 2.5;
    this.camera.position.y = 4.0 + Math.cos(this.ambientTime * 0.06) * 1.2;
    this.camera.position.z = 18.0 + Math.sin(this.ambientTime * 0.04) * 1.5;
    this.camera.lookAt(0, 0, 0);

    this.renderer.render(this.scene, this.camera);
  }

  public resize(width: number, height: number, pixelRatio: number): void {
    this.camera.aspect = width / Math.max(height, 1);
    this.camera.updateProjectionMatrix();
    if (this.material) {
      this.material.uniforms.uPixelRatio.value = pixelRatio;
    }
  }

  public dispose(): void {
    if (this.points) {
      this.scene.remove(this.points);
      this.points = null;
    }
    this.geometry?.dispose();
    this.geometry = null;
    this.material?.dispose();
    this.material = null;
  }
}
