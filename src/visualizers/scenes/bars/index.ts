import * as THREE from 'three';
import type { Quality, RenderAudio, VisualScene, VisualSettings } from '../../types';
import { BeatFollower, getEffectiveSensitivity } from '../../dynamics';
import { PALETTES } from '../../palettes';
import { RippleTiming } from './rippleTiming';

const NUM_BARS = 64;
const MAX_BAR_HEIGHT = 6.4;
const SHOCKWAVE_SLOTS = 4;
const SHOCKWAVE_LIFETIME = 1.6;
const BARS_BASELINE_GAIN = 0.8;
const BAR_SPECTRUM_GAIN = 4.6;

interface FloorWave {
  age: number;
  strength: number;
  speed: number;
}

/** Bars retain readable peaks while sensitivity scales height with a soft knee. */
export function calibrateBarsLevel(value: number, sensitivity: number): number {
  const drive = Math.max(0, Number.isFinite(value) ? value : 0) * getEffectiveSensitivity(sensitivity) * BARS_BASELINE_GAIN;
  return drive / (1 + drive * 0.55);
}

/** Combine nearby log/Mel bins so each mirrored bar represents a small pitch band. */
export function sampleFrequencyBand(values: ArrayLike<number>, position: number, slots = NUM_BARS / 2): number {
  if (values.length === 0 || slots <= 0) return 0;

  const safePosition = Math.min(1, Math.max(0, Number.isFinite(position) ? position : 0));
  const center = safePosition * (values.length - 1);
  const halfWidth = (values.length - 1) / (slots * 2);
  const first = Math.max(0, Math.floor(center - halfWidth));
  const last = Math.min(values.length - 1, Math.ceil(center + halfWidth));
  let total = 0;
  let peak = 0;
  let count = 0;

  for (let i = first; i <= last; i++) {
    const value = values[i] ?? 0;
    const safeValue = Number.isFinite(value) ? Math.max(0, value) : 0;
    total += safeValue;
    peak = Math.max(peak, safeValue);
    count++;
  }

  const mean = count > 0 ? total / count : 0;
  return mean * 0.35 + peak * 0.65;
}

export class BarsScene implements VisualScene {
  public scene: THREE.Scene;
  public camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;

  private barGroup: THREE.Group;
  private barMeshes: THREE.Mesh[] = [];
  private barMaterials: THREE.MeshBasicMaterial[] = [];
  private peakMeshes: THREE.Mesh[] = [];
  private peakMaterials: THREE.MeshBasicMaterial[] = [];
  private peakHeights: Float32Array = new Float32Array(NUM_BARS);
  private peakVelocities: Float32Array = new Float32Array(NUM_BARS);
  private barHeights: Float32Array = new Float32Array(NUM_BARS);
  private paletteHueShift = 0;
  private readonly colorScratch = new THREE.Color();

  // Mirrored reflection floor plane
  private floorMesh: THREE.Mesh;
  private floorMaterial: THREE.MeshPhongMaterial;
  private floorGlow: THREE.Mesh;
  private floorGlowMaterial: THREE.ShaderMaterial;
  private floorGrid: THREE.GridHelper;
  private floorWaves: FloorWave[] = [];
  private readonly rippleTiming = new RippleTiming();
  private previousRippleEnergy = new Float32Array(NUM_BARS);
  private shockwaveRings: THREE.Line[][] = [];
  private shockwaveRingMaterials: THREE.LineBasicMaterial[][] = [];

  // Subwoofer beat pulse ring
  private subRing: THREE.Line;
  private subRingMaterial: THREE.LineBasicMaterial;

  private beatFollower: BeatFollower = new BeatFollower();
  private ambientTime: number = 0;

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
  public get smoothedSubBass(): number {
    return this.beatFollower.smoothedSubBass;
  }
  public get smoothedKick(): number {
    return this.beatFollower.smoothedKick;
  }
  public get smoothedPEnergy(): number {
    return this.beatFollower.smoothedPEnergy;
  }
  public get dominantChroma(): number {
    return this.beatFollower.dominantChroma;
  }

  constructor(renderer: THREE.WebGLRenderer, _quality: Quality = 'medium') {
    this.renderer = renderer;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(55, 1, 0.1, 100);
    this.camera.position.set(0, 5.0, 18);
    this.camera.lookAt(0, 1.5, 0);

    // Reflective dark glass floor
    const ambient = new THREE.AmbientLight(0x8290b8, 0.28);
    this.scene.add(ambient);
    const floorLight = new THREE.DirectionalLight(0x8ea8d8, 0.5);
    floorLight.position.set(-4, 8, 5);
    this.scene.add(floorLight);

    const floorGeo = new THREE.PlaneGeometry(42, 28);
    floorGeo.rotateX(-Math.PI / 2);
    this.floorMaterial = new THREE.MeshPhongMaterial({
      color: 0x070912,
      specular: 0x27344f,
      shininess: 56,
    });
    this.floorMesh = new THREE.Mesh(floorGeo, this.floorMaterial);
    this.floorMesh.position.y = -2.025;
    this.scene.add(this.floorMesh);

    this.floorGrid = new THREE.GridHelper(40, 28, 0x24324e, 0x141b2b);
    this.floorGrid.position.y = -2.006;
    const gridMaterial = this.floorGrid.material as THREE.LineBasicMaterial;
    gridMaterial.transparent = true;
    gridMaterial.opacity = 0.12;
    gridMaterial.depthWrite = false;
    this.scene.add(this.floorGrid);

    this.floorGlowMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uPoolColor: { value: PALETTES.aurora.a.clone() },
        uRippleColor: { value: PALETTES.aurora.b.clone() },
        uBass: { value: 0 },
        uTime: { value: 0 },
        uWaves: { value: Array.from({ length: SHOCKWAVE_SLOTS }, () => new THREE.Vector4(-1, 0, 0, 0)) },
      },
      vertexShader: `
        varying vec2 vFloorPosition;
        void main() {
          vFloorPosition = position.xz;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 uPoolColor;
        uniform vec3 uRippleColor;
        uniform float uBass;
        uniform float uTime;
        uniform vec4 uWaves[4];
        varying vec2 vFloorPosition;
        void main() {
          float distanceFromCenter = length(vec2(vFloorPosition.x, (vFloorPosition.y + 1.8) * 1.45));
          float pool = exp(-distanceFromCenter * 0.2);
          float shimmer = 0.88 + 0.12 * sin(uTime * 1.7 - distanceFromCenter * 0.8);
          float rippleLight = 0.0;
          for (int i = 0; i < 4; i++) {
            float width = 0.62 + uWaves[i].x * 0.028;
            float waveDistance = (distanceFromCenter - uWaves[i].x) / width;
            float mainRim = exp(-waveDistance * waveDistance * 1.15);
            float trailingDistance = (distanceFromCenter - (uWaves[i].x - 1.05)) / (width * 1.25);
            float trailingRim = exp(-trailingDistance * trailingDistance * 1.15);
            rippleLight += (mainRim + trailingRim * 0.42) * uWaves[i].y;
          }
          vec3 color = uPoolColor * pool * (0.045 + uBass * 0.13) * shimmer;
          color += uRippleColor * rippleLight * 0.62;
          float alpha = pool * (0.055 + uBass * 0.1) + rippleLight * 0.72;
          gl_FragColor = vec4(color, min(alpha, 0.9));
        }
      `,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    const glowGeo = new THREE.PlaneGeometry(42, 28);
    glowGeo.rotateX(-Math.PI / 2);
    this.floorGlow = new THREE.Mesh(glowGeo, this.floorGlowMaterial);
    this.floorGlow.position.y = -1.985;
    this.floorGlow.renderOrder = 2;
    this.scene.add(this.floorGlow);

    const ripplePoints = Array.from({ length: 97 }, (_, index) => {
      const angle = index / 96 * Math.PI * 2;
      return new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle));
    });
    for (let waveIndex = 0; waveIndex < SHOCKWAVE_SLOTS; waveIndex++) {
      const rings: THREE.Line[] = [];
      const materials: THREE.LineBasicMaterial[] = [];
      for (let ringIndex = 0; ringIndex < 3; ringIndex++) {
        const geometry = new THREE.BufferGeometry().setFromPoints(ripplePoints);
        const material = new THREE.LineBasicMaterial({
          color: ringIndex === 0 ? PALETTES.aurora.b : PALETTES.aurora.c,
          transparent: true,
          opacity: 0,
          depthTest: false,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        });
        const line = new THREE.LineLoop(geometry, material);
        line.position.y = -1.962 + ringIndex * 0.001;
        line.position.z = -1.8;
        line.renderOrder = 3;
        this.scene.add(line);
        rings.push(line);
        materials.push(material);
      }
      this.shockwaveRings.push(rings);
      this.shockwaveRingMaterials.push(materials);
    }

    // Subwoofer bass pulse ring
    const ringPts: THREE.Vector3[] = [];
    const ringSegs = 64;
    for (let i = 0; i <= ringSegs; i++) {
      const a = (i / ringSegs) * Math.PI * 2;
      ringPts.push(new THREE.Vector3(Math.cos(a) * 4.0, 0, Math.sin(a) * 2.5));
    }
    const ringGeo = new THREE.BufferGeometry().setFromPoints(ringPts);
    this.subRingMaterial = new THREE.LineBasicMaterial({
      color: PALETTES.aurora.a,
      transparent: true,
      opacity: 0.4,
    });
    this.subRing = new THREE.Line(ringGeo, this.subRingMaterial);
    this.subRing.position.y = -1.975;
    this.subRing.position.z = -1.8;
    this.subRing.renderOrder = 4;
    this.scene.add(this.subRing);

    // 3D Audio Spectrum Bars (64 Mel-scale bars)
    this.barGroup = new THREE.Group();
    const barWidth = 0.22;
    const barDepth = 0.22;
    const barUnitHeight = 1.0;
    const barGeo = new THREE.BoxGeometry(barWidth, barUnitHeight, barDepth);
    const peakGeo = new THREE.BoxGeometry(barWidth * 1.15, 0.08, barDepth * 1.15);

    const spacing = 0.32;
    const totalWidth = NUM_BARS * spacing;
    const startX = -totalWidth / 2 + spacing / 2;

    for (let i = 0; i < NUM_BARS; i++) {
      // Main Bar
      const mat = new THREE.MeshBasicMaterial({
        color: PALETTES.aurora.a,
        transparent: true,
        opacity: 0.9,
      });
      this.barMaterials.push(mat);
      const mesh = new THREE.Mesh(barGeo, mat);
      // Gentle amphitheater arc
      const arcZ = Math.sin((i / (NUM_BARS - 1)) * Math.PI) * -1.8;
      mesh.position.set(startX + i * spacing, -2.0, arcZ);
      mesh.scale.set(1, 0.1, 1);
      this.barMeshes.push(mesh);
      this.barGroup.add(mesh);

      // Peak Hold Cap
      const peakMat = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.95,
      });
      this.peakMaterials.push(peakMat);
      const peakMesh = new THREE.Mesh(peakGeo, peakMat);
      peakMesh.position.set(startX + i * spacing, -1.9, arcZ);
      this.peakMeshes.push(peakMesh);
      this.barGroup.add(peakMesh);
    }
    this.scene.add(this.barGroup);
  }

  update(dtSeconds: number, audio: RenderAudio, settings: VisualSettings): void {
    this.ambientTime += dtSeconds;
    const rawBass = audio.silent ? 0 : calibrateBarsLevel(audio.bass, settings.sensitivity);
    const rawMid = audio.silent ? 0 : calibrateBarsLevel(audio.mid, settings.sensitivity);
    const rawTreble = audio.silent ? 0 : calibrateBarsLevel(audio.treble, settings.sensitivity);
    const rawTransient = audio.silent ? 0 : calibrateBarsLevel(audio.transient, settings.sensitivity);

    const { bass, beat, subBass, kick, pEnergy, dominantChroma } =
      this.beatFollower.process(
        rawBass,
        rawMid,
        rawTreble,
        rawTransient,
        dtSeconds,
        this.ambientTime,
        settings.response,
        {
          subBass: audio.silent ? 0 : calibrateBarsLevel(audio.subBass ?? audio.bass, settings.sensitivity),
          kick: audio.silent ? 0 : calibrateBarsLevel(audio.kick ?? audio.bass, settings.sensitivity),
          pEnergy: audio.silent ? 0 : calibrateBarsLevel(audio.pEnergy ?? 0, settings.sensitivity),
          hEnergy: audio.silent ? 0 : calibrateBarsLevel(audio.hEnergy ?? 0, settings.sensitivity),
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
    const effectiveSub = subBass > 0 ? subBass : bass;

    const shockwaveDrive = Math.max(beat, kick * 0.85, pEnergy * 0.9);
    for (const wave of this.floorWaves) wave.age += Math.max(0, dtSeconds);
    if (this.rippleTiming.update(audio, dtSeconds)) {
      const tempo = (audio.confidence ?? 0) >= 0.5 && (audio.bpm ?? 0) >= 45 ? audio.bpm! : 120;
      const speed = THREE.MathUtils.clamp(tempo / 60 * 10.5, 14, 36);
      this.floorWaves.push({ age: 0, strength: Math.min(1.35, 0.65 + shockwaveDrive * 0.72), speed });
      if (this.floorWaves.length > SHOCKWAVE_SLOTS) this.floorWaves.shift();
    }
    this.floorWaves = this.floorWaves.filter((wave) => wave.age < SHOCKWAVE_LIFETIME);

    this.floorGlowMaterial.uniforms.uPoolColor.value.copy(palette.a);
    this.floorGlowMaterial.uniforms.uRippleColor.value.copy(palette.b);
    this.floorGlowMaterial.uniforms.uBass.value = Math.min(1, effectiveSub);
    this.floorGlowMaterial.uniforms.uTime.value = this.ambientTime;
    const waveUniforms = this.floorGlowMaterial.uniforms.uWaves.value as THREE.Vector4[];
    for (let i = 0; i < SHOCKWAVE_SLOTS; i++) {
      const wave = this.floorWaves[i];
      const rings = this.shockwaveRings[i];
      const ringMaterials = this.shockwaveRingMaterials[i];
      if (!wave) {
        waveUniforms[i].set(-1, 0, 0, 0);
        rings?.forEach((ring, ringIndex) => {
          ring.scale.setScalar(0);
          if (ringMaterials?.[ringIndex]) ringMaterials[ringIndex].opacity = 0;
        });
        continue;
      }
      const progress = wave.age / SHOCKWAVE_LIFETIME;
      const radius = 0.25 + wave.age * wave.speed;
      waveUniforms[i].set(radius, wave.strength * (1 - progress) ** 1.4, progress, 1);
      rings?.forEach((ring, ringIndex) => {
        const ringRadius = Math.max(0, radius - ringIndex * 0.72);
        ring.scale.set(ringRadius, 1, ringRadius / 1.45);
        ringMaterials![ringIndex].color.copy(ringIndex === 0 ? palette.b : palette.c);
        ringMaterials![ringIndex].opacity = Math.min(0.82, wave.strength * (1 - progress) ** 1.25 * [0.72, 0.42, 0.24][ringIndex]);
      });
    }

    // Sub-bass (20–70 Hz) drives reflective floor brightness and subwoofer ring expansion
    const ringFlash = this.floorWaves.reduce((peak, wave) => {
      const envelope = Math.max(0, 1 - wave.age / 0.42) * wave.strength;
      return Math.max(peak, envelope);
    }, 0);
    const ringScale = 0.92 + Math.min(0.46, effectiveSub * 0.42) + ringFlash * 0.12;
    this.subRing.scale.set(ringScale, 1.0, ringScale);
    this.subRingMaterial.color.copy(palette.a).lerp(palette.b, Math.min(0.55, ringFlash * 0.42));
    this.subRingMaterial.opacity = Math.min(0.46, 0.08 + effectiveSub * 0.24 + ringFlash * 0.12);

    // Floor glow brightness driven by sub-bass
    this.floorMaterial.color.copy(palette.a).multiplyScalar(Math.min(0.22, 0.025 + effectiveSub * 0.11 + beat * 0.04));

    // Kick and P (percussive) component drive camera kick recoil
    const kickPercussive = Math.max(kick, pEnergy, beat);
    const camBaseZ = 18.0;
    this.camera.position.z = camBaseZ - Math.min(0.55, kickPercussive * 0.42);
    this.camera.position.y = 5.0 + Math.sin(this.ambientTime * 0.5) * 0.3;

    // 64 Mel bands drive bar heights (falling back to spectrum if mel is not present)
    const mel = audio.mel;
    const melLen = mel ? mel.length : 0;
    const spectrum = audio.spectrum;
    const specLen = spectrum ? spectrum.length : 64;

    const half = NUM_BARS / 2;
    const gravity = 14.0; // Gravity pulling peak caps down

    // Circle of fifths chroma shift for bar colors: (dominantChroma * 7 % 12) / 12
    const targetHueShift = ((dominantChroma * 7) % 12) / 12.0;
    // Smooth the discrete chroma estimate so palette changes flow instead of flicker.
    let hueDelta = targetHueShift - this.paletteHueShift;
    if (hueDelta > 0.5) hueDelta -= 1;
    if (hueDelta < -0.5) hueDelta += 1;
    this.paletteHueShift = (this.paletteHueShift + hueDelta * (1 - Math.exp(-dtSeconds / 0.65)) + 1) % 1;

    for (let i = 0; i < NUM_BARS; i++) {
      // Keep the signature mirrored spectrum: bass sits at the center and
      // progressively higher frequencies travel toward the outer edges.
      const distFromCenter = Math.abs(i - half + 0.5) / half;

      let rawVal = 0;
      if (!audio.silent) {
        if (melLen > 0) {
          rawVal = calibrateBarsLevel(sampleFrequencyBand(mel!, distFromCenter), settings.sensitivity);
        } else if (specLen > 0) {
          rawVal = calibrateBarsLevel(sampleFrequencyBand(spectrum!, distFromCenter), settings.sensitivity);
        }
      }

      // Ambient idle ripple during silence
      const idleWave = Math.sin(this.ambientTime * 1.8 + i * 0.19) * 0.035 + 0.045;
      const bassWeight = Math.max(0, 1 - distFromCenter * 2.4);
      const midWeight = Math.max(0, 1 - Math.abs(distFromCenter - 0.5) * 2.5);
      const highWeight = Math.max(0, (distFromCenter - 0.48) / 0.52);
      const barX = this.barMeshes[i]?.position.x ?? 0;
      const barZ = this.barMeshes[i]?.position.z ?? 0;
      const floorDistance = Math.hypot(barX, (barZ + 1.8) * 1.45);
      let rippleEnergy = 0;
      for (const wave of this.floorWaves) {
        const progress = wave.age / SHOCKWAVE_LIFETIME;
        const waveRadius = 0.25 + wave.age * wave.speed;
        const width = 0.52 + waveRadius * 0.024;
        const distance = (floorDistance - waveRadius) / width;
        rippleEnergy += Math.exp(-distance * distance * 1.6) * wave.strength * (1 - progress) ** 1.4;
      }
      // without replacing the per-bin shape. Beat energy adds a short, bounded
      // accent so sustained loudness does not inflate the whole display.
      const bandSupport = bass * bassWeight * 0.42 +
        (this.beatFollower.smoothedMid) * midWeight * 0.24 +
        (this.beatFollower.smoothedTreble) * highWeight * 0.18;
      const onsetAccent = Math.min(0.42, beat * (0.16 + highWeight * 0.22));
      const rippleRise = Math.max(0, rippleEnergy - this.previousRippleEnergy[i]);
      this.previousRippleEnergy[i] = rippleEnergy;
      const desiredHeight = rawVal * BAR_SPECTRUM_GAIN + bandSupport + onsetAccent + rippleEnergy * 0.92 + idleWave;
      const targetHeight = Math.max(0.1, Math.min(MAX_BAR_HEIGHT, desiredHeight));
      const currentHeight = this.barHeights[i] ?? 0.1;
      const heightTau = targetHeight > currentHeight ? 0.04 : 0.28;
      const easedHeight = currentHeight + (1 - Math.exp(-Math.max(0, dtSeconds) / heightTau)) * (targetHeight - currentHeight);
      this.barHeights[i] = easedHeight;

      const bar = this.barMeshes[i];
      if (bar) {
        bar.scale.y = easedHeight;
        bar.position.y = -2.0 + easedHeight / 2;

        // Color mapping along the spectrum with circle of fifths hue shift
        const col = this.colorScratch;
        if (distFromCenter < 0.5) {
          col.lerpColors(palette.a, palette.b, distFromCenter * 2.0);
        } else {
          col.lerpColors(palette.b, palette.c, (distFromCenter - 0.5) * 2.0);
        }

        if (this.paletteHueShift > 0.001) {
          const hsl = { h: 0, s: 0, l: 0 };
          col.getHSL(hsl);
          hsl.h = (hsl.h + this.paletteHueShift) % 1.0;
          col.setHSL(hsl.h, hsl.s, hsl.l);
        }
        if (rippleEnergy > 0.01) col.lerp(palette.c, Math.min(0.34, rippleEnergy * 0.2));

        this.barMaterials[i]?.color.copy(col);
      }

      // Peak Hold Cap physics launched by Kick and P component
      const topY = -2.0 + easedHeight;
      let currPeakY = this.peakHeights[i] ?? topY;
      let currVel = this.peakVelocities[i] ?? 0;

      if (topY >= currPeakY || rippleRise > 0.08) {
        currPeakY = Math.max(currPeakY, topY + 0.08 + rippleRise * 0.42);
        // Kick and P component launch the peak caps high
        currVel = Math.max(currVel, Math.min(6.2, 0.7 + kick * 1.0 + pEnergy * 1.0 + beat * 0.65 + rippleRise * 2.8));
      } else {
        currVel -= gravity * dtSeconds;
        currPeakY += currVel * dtSeconds;
        if (currPeakY < topY + 0.05) {
          currPeakY = topY + 0.05;
          currVel = 0;
        }
      }
      this.peakHeights[i] = currPeakY;
      this.peakVelocities[i] = currVel;

      const peakMesh = this.peakMeshes[i];
      if (peakMesh) {
        peakMesh.position.y = currPeakY;
        // Peak cap glows white-hot on kick & percussive hits
        const peakMat = this.peakMaterials[i];
        if (peakMat) {
          peakMat.color.copy(palette.c);
          if (kickPercussive > 0.12 && highWeight > 0) {
            peakMat.color.lerp(palette.b, Math.min(0.42, kickPercussive * highWeight * 0.24));
          }
          peakMat.opacity = 0.52 + Math.min(0.26, beat * 0.16);
        }
      }
    }

    this.renderer.render(this.scene, this.camera);
  }

  resize(width: number, height: number, _pixelRatio: number): void {
    this.camera.aspect = width / Math.max(height, 1);
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    for (const m of this.barMeshes) {
      m.geometry.dispose();
    }
    for (const mat of this.barMaterials) {
      mat.dispose();
    }
    for (const m of this.peakMeshes) {
      m.geometry.dispose();
    }
    for (const mat of this.peakMaterials) {
      mat.dispose();
    }
    this.floorMesh.geometry.dispose();
    this.floorMaterial.dispose();
    this.floorGrid.geometry.dispose();
    (this.floorGrid.material as THREE.Material).dispose();
    this.floorGlow.geometry.dispose();
    this.floorGlowMaterial.dispose();
    for (const rings of this.shockwaveRings) {
      for (const ring of rings) {
        ring.geometry.dispose();
        this.scene.remove(ring);
      }
    }
    for (const materials of this.shockwaveRingMaterials) materials.forEach((material) => material.dispose());
    this.subRing.geometry.dispose();
    this.subRingMaterial.dispose();
    this.scene.remove(this.barGroup);
    this.scene.remove(this.floorMesh);
    this.scene.remove(this.floorGrid);
    this.scene.remove(this.floorGlow);
    this.scene.remove(this.subRing);
  }
}
