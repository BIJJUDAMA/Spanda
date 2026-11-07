import * as THREE from 'three';
import type { Palette, Quality, RenderAudio, VisualScene, VisualSettings } from '../../types';
import { PALETTES } from '../../palettes';
import { BeatFollower, getEffectiveSensitivity } from '../../dynamics';
import diskVertShader from './shaders/blackhole_disk.vert.glsl?raw';
import diskFragShader from './shaders/blackhole_disk.frag.glsl?raw';
import haloVertShader from './shaders/blackhole_halo.vert.glsl?raw';
import haloFragShader from './shaders/blackhole_halo.frag.glsl?raw';
import jetsVertShader from './shaders/blackhole_jets.vert.glsl?raw';
import jetsFragShader from './shaders/blackhole_jets.frag.glsl?raw';

export interface BlackHoleAudioResponse {
  bass: number; subBass: number; kick: number; mid: number; treble: number;
  pEnergy: number; transient: number;
}

export function mapBlackHoleAudioResponse(input: {
  bass: number; subBass: number; kick: number; mid: number; treble: number;
  pEnergy: number; beat: number; predictiveBeat: boolean;
}): BlackHoleAudioResponse {
  return {
    bass: Math.min(0.9, input.bass * 0.78),
    subBass: Math.min(0.9, input.subBass * 0.78),
    kick: Math.min(0.85, input.kick * 0.72),
    mid: Math.min(1.0, input.mid),
    treble: Math.min(0.9, input.treble * 0.78),
    pEnergy: Math.min(0.85, input.pEnergy * 0.72),
    transient: Math.min(0.48, input.predictiveBeat ? Math.max(input.beat, 0.28) : input.beat * 0.72),
  };
}

const DISK_RINGS_COUNT = 16;
const PARTICLES_PER_RING: Record<Quality, number> = {
  low: 150,    // 16 * 150 = 2,400
  medium: 200, // 16 * 200 = 3,200
  high: 250,   // 16 * 250 = 4,000
};

const JET_PARTICLE_COUNTS: Record<Quality, number> = {
  low: 300,
  medium: 500,
  high: 800,
};

export class BlackHoleScene implements VisualScene {
  public scene: THREE.Scene;
  public camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;

  // 1. Event horizon central sphere (pitch black, r_s = 2.0)
  private horizonMesh: THREE.Mesh | null = null;
  private horizonGeometry: THREE.SphereGeometry | null = null;
  private horizonMaterial: THREE.MeshBasicMaterial | null = null;

  // 2. Photon sphere / Einstein ring halo (r_ph = 1.5 * r_s = 3.0)
  private haloMesh: THREE.Mesh | null = null;
  private haloGeometry: THREE.PlaneGeometry | null = null;
  private haloMaterial: THREE.ShaderMaterial | null = null;

  // 3. Accretion Disk (16 concentric Keplerian rings with Doppler beaming & lensing)
  private diskPoints: THREE.Points | null = null;
  private diskGeometry: THREE.BufferGeometry | null = null;
  private diskMaterial: THREE.ShaderMaterial | null = null;

  // 4. Relativistic Polar Jets (firing along +-Y axis, flaring on kick transients)
  private jetPoints: THREE.Points | null = null;
  private jetGeometry: THREE.BufferGeometry | null = null;
  private jetMaterial: THREE.ShaderMaterial | null = null;

  public ambientTime: number = 0;
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
  public get smoothedPEnergy(): number {
    return this.beatFollower.smoothedPEnergy;
  }
  public get smoothedHEnergy(): number {
    return this.beatFollower.smoothedHEnergy;
  }
  public get smoothedStereoWidth(): number {
    return this.beatFollower.smoothedStereoWidth;
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
    this.camera = new THREE.PerspectiveCamera(55, 1, 0.1, 100);
    this.camera.position.set(0, 5, 22);
    this.camera.lookAt(0, 0, 0);

    this.createHorizon();
    this.createHalo('aurora');
    this.rebuildParticles(quality, 'aurora');
  }

  private createHorizon(): void {
    // Pure pitch-black event horizon sphere at r_s = 2.0
    this.horizonGeometry = new THREE.SphereGeometry(2.0, 48, 48);
    this.horizonMaterial = new THREE.MeshBasicMaterial({
      color: 0x000000,
      depthTest: true,
      depthWrite: true,
    });
    this.horizonMesh = new THREE.Mesh(this.horizonGeometry, this.horizonMaterial);
    this.horizonMesh.renderOrder = 0;
    this.scene.add(this.horizonMesh);
  }

  private createHalo(paletteKey: Palette): void {
    const palette = PALETTES[paletteKey] ?? PALETTES.aurora;
    // Billboard plane centered at origin enclosing Einstein ring up to r = 6.0
    this.haloGeometry = new THREE.PlaneGeometry(12.0, 12.0);
    this.haloMaterial = new THREE.ShaderMaterial({
      vertexShader: haloVertShader,
      fragmentShader: haloFragShader,
      uniforms: {
        uTime: { value: 0 },
        uBass: { value: 0 },
        uSubBass: { value: 0 },
        uKick: { value: 0 },
        uStereoWidth: { value: 0.5 },
        uColorA: { value: palette.a },
        uColorB: { value: palette.b },
        uColorC: { value: palette.c },
      },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
    });
    this.haloMesh = new THREE.Mesh(this.haloGeometry, this.haloMaterial);
    this.haloMesh.renderOrder = 2;
    this.scene.add(this.haloMesh);
  }

  private rebuildParticles(quality: Quality, paletteKey: Palette): void {
    this.currentQuality = quality;
    this.currentPalette = paletteKey;
    const palette = PALETTES[paletteKey] ?? PALETTES.aurora;

    // --- 1. Accretion Disk Rings ---
    if (this.diskPoints) {
      this.scene.remove(this.diskPoints);
      this.diskGeometry?.dispose();
      this.diskMaterial?.dispose();
      this.diskPoints = null;
      this.diskGeometry = null;
      this.diskMaterial = null;
    }

    const perRing = PARTICLES_PER_RING[quality] ?? PARTICLES_PER_RING.medium;
    const diskCount = DISK_RINGS_COUNT * perRing;

    const diskPositions = new Float32Array(diskCount * 3);
    const diskRadii = new Float32Array(diskCount);
    const diskBaseAngles = new Float32Array(diskCount);
    const diskRingIndices = new Float32Array(diskCount);
    const diskRadialJitters = new Float32Array(diskCount);
    const diskVerticalJitters = new Float32Array(diskCount);
    const diskSizes = new Float32Array(diskCount);

    let idx = 0;
    const rIn = 3.2;  // Just outside photon sphere r_ph = 3.0
    const rOut = 13.5;

    for (let rIdx = 0; rIdx < DISK_RINGS_COUNT; rIdx++) {
      const ringFrac = rIdx / (DISK_RINGS_COUNT - 1);
      const ringRadius = rIn + (rOut - rIn) * Math.pow(ringFrac, 1.15);
      const ringSpacing = (rOut - rIn) / DISK_RINGS_COUNT;

      for (let p = 0; p < perRing; p++) {
        const baseAngle = (p / perRing) * Math.PI * 2 + (Math.random() - 0.5) * 0.05;
        const radialJitter = (Math.random() - 0.5) * ringSpacing * 0.45;
        // Outer rings have slightly thicker vertical flare
        const verticalJitter = (Math.random() - 0.5) * (0.08 + ringFrac * 0.28);
        const particleSize = 2.4 + (1.0 - ringFrac * 0.45) * 2.2 + (Math.random() - 0.5) * 1.0;

        diskRadii[idx] = ringRadius;
        diskBaseAngles[idx] = baseAngle;
        diskRingIndices[idx] = rIdx;
        diskRadialJitters[idx] = radialJitter;
        diskVerticalJitters[idx] = verticalJitter;
        diskSizes[idx] = particleSize;

        // Initial placeholder coordinates
        diskPositions[idx * 3] = ringRadius * Math.cos(baseAngle);
        diskPositions[idx * 3 + 1] = verticalJitter;
        diskPositions[idx * 3 + 2] = ringRadius * Math.sin(baseAngle);

        idx++;
      }
    }

    this.diskGeometry = new THREE.BufferGeometry();
    this.diskGeometry.setAttribute('position', new THREE.BufferAttribute(diskPositions, 3));
    this.diskGeometry.setAttribute('aRadius', new THREE.BufferAttribute(diskRadii, 1));
    this.diskGeometry.setAttribute('aBaseAngle', new THREE.BufferAttribute(diskBaseAngles, 1));
    this.diskGeometry.setAttribute('aRingIndex', new THREE.BufferAttribute(diskRingIndices, 1));
    this.diskGeometry.setAttribute('aRadialJitter', new THREE.BufferAttribute(diskRadialJitters, 1));
    this.diskGeometry.setAttribute('aVerticalJitter', new THREE.BufferAttribute(diskVerticalJitters, 1));
    this.diskGeometry.setAttribute('aSize', new THREE.BufferAttribute(diskSizes, 1));

    this.diskMaterial = new THREE.ShaderMaterial({
      vertexShader: diskVertShader,
      fragmentShader: diskFragShader,
      uniforms: {
        uTime: { value: 0 },
        uBass: { value: 0 },
        uSubBass: { value: 0 },
        uKick: { value: 0 },
        uMid: { value: 0 },
        uTreble: { value: 0 },
        uStereoWidth: { value: 0.5 },
        uColorA: { value: palette.a },
        uColorB: { value: palette.b },
        uColorC: { value: palette.c },
        uPixelRatio: { value: 1.0 },
      },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
    });

    this.diskPoints = new THREE.Points(this.diskGeometry, this.diskMaterial);
    this.diskPoints.renderOrder = 3;
    this.scene.add(this.diskPoints);

    // --- 2. Polar Relativistic Jets ---
    if (this.jetPoints) {
      this.scene.remove(this.jetPoints);
      this.jetGeometry?.dispose();
      this.jetMaterial?.dispose();
      this.jetPoints = null;
      this.jetGeometry = null;
      this.jetMaterial = null;
    }

    const jetCount = JET_PARTICLE_COUNTS[quality] ?? JET_PARTICLE_COUNTS.medium;
    const jetPositions = new Float32Array(jetCount * 3);
    const jetSeeds = new Float32Array(jetCount);
    const jetPolarities = new Float32Array(jetCount);
    const jetBaseDists = new Float32Array(jetCount);
    const jetAngles = new Float32Array(jetCount);
    const jetSizes = new Float32Array(jetCount);

    for (let j = 0; j < jetCount; j++) {
      const polarity = j % 2 === 0 ? 1.0 : -1.0;
      const seed = Math.random();
      const baseDist = 0.3 + Math.random() * 0.7;
      const angle = Math.random() * Math.PI * 2;
      const size = 2.0 + Math.random() * 2.8;

      jetSeeds[j] = seed;
      jetPolarities[j] = polarity;
      jetBaseDists[j] = baseDist;
      jetAngles[j] = angle;
      jetSizes[j] = size;

      jetPositions[j * 3] = 0;
      jetPositions[j * 3 + 1] = polarity * (2.2 + seed * 20.0);
      jetPositions[j * 3 + 2] = 0;
    }

    this.jetGeometry = new THREE.BufferGeometry();
    this.jetGeometry.setAttribute('position', new THREE.BufferAttribute(jetPositions, 3));
    this.jetGeometry.setAttribute('aSeed', new THREE.BufferAttribute(jetSeeds, 1));
    this.jetGeometry.setAttribute('aPolarity', new THREE.BufferAttribute(jetPolarities, 1));
    this.jetGeometry.setAttribute('aBaseDist', new THREE.BufferAttribute(jetBaseDists, 1));
    this.jetGeometry.setAttribute('aAngle', new THREE.BufferAttribute(jetAngles, 1));
    this.jetGeometry.setAttribute('aSize', new THREE.BufferAttribute(jetSizes, 1));

    this.jetMaterial = new THREE.ShaderMaterial({
      vertexShader: jetsVertShader,
      fragmentShader: jetsFragShader,
      uniforms: {
        uTime: { value: 0 },
        uKick: { value: 0 },
        uPEnergy: { value: 0 },
        uTransient: { value: 0 },
        uStereoWidth: { value: 0.5 },
        uColorA: { value: palette.a },
        uColorB: { value: palette.b },
        uColorC: { value: palette.c },
        uPixelRatio: { value: 1.0 },
      },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
    });

    this.jetPoints = new THREE.Points(this.jetGeometry, this.jetMaterial);
    this.jetPoints.renderOrder = 4;
    this.scene.add(this.jetPoints);
  }

  public update(dtSeconds: number, audio: RenderAudio, settings: VisualSettings): void {
    // Ambient orbital and lensing motion advances continuously even in silence
    this.ambientTime += dtSeconds;

    if (settings.quality !== this.currentQuality) {
      this.rebuildParticles(settings.quality, settings.palette);
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
      subBass,
      kick,
      mid,
      treble,
      beat,
      pEnergy,
      stereoWidth,
      isPredictiveBeat,
    } = this.beatFollower.process(scaledAudio, dtSeconds, this.ambientTime, settings.response);

    const response = mapBlackHoleAudioResponse({
      bass, subBass, kick, mid, treble, pEnergy, beat,
      predictiveBeat: isPredictiveBeat,
    });
    const effectiveStereoWidth = audio.silent ? 0.5 : Math.max(0.0, Math.min(1.0, stereoWidth));

    this.currentPalette = settings.palette;
    const palette = PALETTES[settings.palette] ?? PALETTES.aurora;

    // 1. Update Halo Uniforms
    if (this.haloMaterial) {
      this.haloMaterial.uniforms.uTime.value = this.ambientTime;
      this.haloMaterial.uniforms.uBass.value = response.bass;
      this.haloMaterial.uniforms.uSubBass.value = response.subBass;
      this.haloMaterial.uniforms.uKick.value = response.kick;
      this.haloMaterial.uniforms.uStereoWidth.value = effectiveStereoWidth;
      this.haloMaterial.uniforms.uColorA.value = palette.a;
      this.haloMaterial.uniforms.uColorB.value = palette.b;
      this.haloMaterial.uniforms.uColorC.value = palette.c;
    }

    // Always orient halo billboard to face camera for perfect Einstein ring projection
    if (this.haloMesh) {
      this.haloMesh.quaternion.copy(this.camera.quaternion);
    }

    // 2. Update Accretion Disk Uniforms
    if (this.diskMaterial) {
      this.diskMaterial.uniforms.uTime.value = this.ambientTime;
      this.diskMaterial.uniforms.uBass.value = response.bass;
      this.diskMaterial.uniforms.uSubBass.value = response.subBass;
      this.diskMaterial.uniforms.uKick.value = response.kick;
      this.diskMaterial.uniforms.uMid.value = response.mid;
      this.diskMaterial.uniforms.uTreble.value = response.treble;
      this.diskMaterial.uniforms.uStereoWidth.value = effectiveStereoWidth;
      this.diskMaterial.uniforms.uColorA.value = palette.a;
      this.diskMaterial.uniforms.uColorB.value = palette.b;
      this.diskMaterial.uniforms.uColorC.value = palette.c;
    }

    // 3. Update Polar Jets Uniforms
    if (this.jetMaterial) {
      this.jetMaterial.uniforms.uTime.value = this.ambientTime;
      this.jetMaterial.uniforms.uKick.value = response.kick;
      this.jetMaterial.uniforms.uPEnergy.value = response.pEnergy;
      this.jetMaterial.uniforms.uTransient.value = response.transient;
      this.jetMaterial.uniforms.uStereoWidth.value = effectiveStereoWidth;
      this.jetMaterial.uniforms.uColorA.value = palette.a;
      this.jetMaterial.uniforms.uColorB.value = palette.b;
      this.jetMaterial.uniforms.uColorC.value = palette.c;
    }

    // Smooth ambient camera orbital drift
    this.camera.position.x = Math.sin(this.ambientTime * 0.06) * 1.8;
    this.camera.position.y = 5.0 + Math.cos(this.ambientTime * 0.05) * 0.9;
    this.camera.position.z = 22.0 + Math.sin(this.ambientTime * 0.03) * 1.2;
    this.camera.lookAt(0, 0, 0);

    this.renderer.render(this.scene, this.camera);
  }

  public resize(width: number, height: number, pixelRatio: number): void {
    this.camera.aspect = width / Math.max(height, 1);
    this.camera.updateProjectionMatrix();
    if (this.diskMaterial) {
      this.diskMaterial.uniforms.uPixelRatio.value = pixelRatio;
    }
    if (this.jetMaterial) {
      this.jetMaterial.uniforms.uPixelRatio.value = pixelRatio;
    }
  }

  public dispose(): void {
    // 1. Horizon sphere cleanup
    if (this.horizonMesh) {
      this.scene.remove(this.horizonMesh);
      this.horizonMesh = null;
    }
    this.horizonGeometry?.dispose();
    this.horizonGeometry = null;
    this.horizonMaterial?.dispose();
    this.horizonMaterial = null;

    // 2. Halo cleanup
    if (this.haloMesh) {
      this.scene.remove(this.haloMesh);
      this.haloMesh = null;
    }
    this.haloGeometry?.dispose();
    this.haloGeometry = null;
    this.haloMaterial?.dispose();
    this.haloMaterial = null;

    // 3. Accretion Disk cleanup
    if (this.diskPoints) {
      this.scene.remove(this.diskPoints);
      this.diskPoints = null;
    }
    this.diskGeometry?.dispose();
    this.diskGeometry = null;
    this.diskMaterial?.dispose();
    this.diskMaterial = null;

    // 4. Polar Jets cleanup
    if (this.jetPoints) {
      this.scene.remove(this.jetPoints);
      this.jetPoints = null;
    }
    this.jetGeometry?.dispose();
    this.jetGeometry = null;
    this.jetMaterial?.dispose();
    this.jetMaterial = null;
  }
}
