import * as THREE from 'three';
import type { Palette, Quality, RenderAudio, VisualScene, VisualSettings } from '../../types';
import { BeatFollower, getEffectiveSensitivity } from '../../dynamics';
import { PALETTES } from '../../palettes';

const ORB_PARTICLE_COUNTS: Record<Quality, number> = {
  low: 1800,
  medium: 4000,
  high: 8000,
};

/** Soft-knee input conditioning keeps sensitivity useful without hard clipping. */
export function calibrateOrbLevel(value: number, sensitivity: number): number {
  const drive = Math.max(0, Number.isFinite(value) ? value : 0) * getEffectiveSensitivity(sensitivity) * 0.9;
  return drive / (1 + drive * 0.9);
}

interface BurstParticle {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  age: number;
  maxAge: number;
  size: number;
}

export class OrbScene implements VisualScene {
  public scene: THREE.Scene;
  public camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;

  // 1. Core Sphere Surface Particles
  private spherePoints: THREE.Points | null = null;
  private sphereGeometry: THREE.BufferGeometry | null = null;
  private sphereMaterial: THREE.PointsMaterial | null = null;
  private baseSpherePositions: Float32Array = new Float32Array(0);

  // Continuous outer membrane plus a triangulated wire layer. Both share a
  // deforming spherical surface so the orb reads as a volume, not a point cloud.
  private outerShellGeometry: THREE.SphereGeometry | null = null;
  private outerShell: THREE.Mesh | null = null;
  private outerWire: THREE.Mesh | null = null;
  private outerShellMaterial: THREE.ShaderMaterial | null = null;
  private outerWireMaterial: THREE.ShaderMaterial | null = null;
  private baseOuterPositions: Float32Array = new Float32Array(0);
  private impactDirection = new THREE.Vector3(0, 1, 0);
  private impactAge = Number.POSITIVE_INFINITY;
  private impactStrength = 0;
  private burstCooldown = 0;

  // 2. Outward Beat Burst Particles (rectangleworld burst physics)
  private burstPoints: THREE.Points | null = null;
  private burstGeometry: THREE.BufferGeometry | null = null;
  private burstMaterial: THREE.ShaderMaterial | null = null;
  private burstParticles: BurstParticle[] = [];
  private burstPositions: Float32Array = new Float32Array(0);
  private burstColors: Float32Array = new Float32Array(0);
  private burstSizes: Float32Array = new Float32Array(0);

  // 3. Glowing Core Sphere
  private coreMesh: THREE.Mesh;
  private coreMaterial: THREE.MeshBasicMaterial;

  // 4. Orbiting Rings
  private ringGroup: THREE.Group;
  private ringLines: THREE.Line[] = [];

  private currentQuality: Quality = 'medium';
  private currentPalette: Palette = 'aurora';
  private ambientTime: number = 0;
  private turnAngle: number = 0;
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
  public get smoothedPEnergy(): number {
    return this.beatFollower.smoothedPEnergy;
  }
  public get smoothedHEnergy(): number {
    return this.beatFollower.smoothedHEnergy;
  }
  public get smoothedStereoWidth(): number {
    return this.beatFollower.smoothedStereoWidth;
  }
  public get dominantChroma(): number {
    return this.beatFollower.dominantChroma;
  }

  constructor(renderer: THREE.WebGLRenderer, quality: Quality = 'medium') {
    this.renderer = renderer;
    this.scene = new THREE.Scene();
    this.scene.add(new THREE.HemisphereLight(0x9eb8ff, 0x090716, 0.12));
    const keyLight = new THREE.DirectionalLight(0xc4d8ff, 0.18);
    keyLight.position.set(-6, 8, 10);
    this.scene.add(keyLight);
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    this.camera.position.set(0, 0, 18);
    this.camera.lookAt(0, 0, 0);

    // Inner glowing energy core
    const coreGeo = new THREE.SphereGeometry(1.6, 32, 32);
    this.coreMaterial = new THREE.MeshBasicMaterial({
      color: PALETTES.aurora.b,
      transparent: true,
      opacity: 0.2,
      wireframe: true,
    });
    this.coreMesh = new THREE.Mesh(coreGeo, this.coreMaterial);
    this.scene.add(this.coreMesh);

    // Orbital equatorial rings
    this.ringGroup = new THREE.Group();
    const ringRadii = [4.2, 5.0, 5.8];
    for (let rIdx = 0; rIdx < ringRadii.length; rIdx++) {
      const radius = ringRadii[rIdx] ?? 4.5;
      const pts: THREE.Vector3[] = [];
      const segments = 64;
      for (let i = 0; i <= segments; i++) {
        const theta = (i / segments) * Math.PI * 2;
        pts.push(new THREE.Vector3(Math.cos(theta) * radius, 0, Math.sin(theta) * radius));
      }
      const lineGeo = new THREE.BufferGeometry().setFromPoints(pts);
      const lineMat = new THREE.LineBasicMaterial({
        color: PALETTES.aurora.a,
        transparent: true,
        opacity: 0.24,
      });
      const ring = new THREE.Line(lineGeo, lineMat);
      ring.rotation.x = 0.4 + rIdx * 0.35;
      ring.rotation.z = rIdx * 0.5;
      this.ringLines.push(ring);
      this.ringGroup.add(ring);
    }
    this.scene.add(this.ringGroup);

    this.recreateParticles(quality, 'aurora');
  }

  private recreateParticles(quality: Quality, paletteKey: Palette): void {
    if (this.spherePoints) {
      this.scene.remove(this.spherePoints);
      this.sphereGeometry?.dispose();
      this.sphereMaterial?.dispose();
    }
    if (this.burstPoints) {
      this.scene.remove(this.burstPoints);
      this.burstGeometry?.dispose();
      this.burstMaterial?.dispose();
    }

    this.currentQuality = quality;
    this.currentPalette = paletteKey;
    const count = ORB_PARTICLE_COUNTS[quality] ?? ORB_PARTICLE_COUNTS.medium;
    const palette = PALETTES[paletteKey] ?? PALETTES.aurora;

    this.createOuterShell(quality, paletteKey);

    // --- 1. SPHERE SURFACE PARTICLES ---
    const spherePos = new Float32Array(count * 3);
    const sphereCols = new Float32Array(count * 3);
    this.baseSpherePositions = new Float32Array(count * 3);

    const baseRadius = 4.0;
    const tempColor = new THREE.Color();

    for (let i = 0; i < count; i++) {
      // 3D Spherical Coordinate Projection (rectangleworld formula)
      const theta = Math.random() * 2 * Math.PI;
      const phi = Math.acos(Math.random() * 2 - 1);

      const x = baseRadius * Math.sin(phi) * Math.cos(theta);
      const y = baseRadius * Math.sin(phi) * Math.sin(theta);
      const z = baseRadius * Math.cos(phi);

      spherePos[i * 3] = x;
      spherePos[i * 3 + 1] = y;
      spherePos[i * 3 + 2] = z;

      this.baseSpherePositions[i * 3] = x;
      this.baseSpherePositions[i * 3 + 1] = y;
      this.baseSpherePositions[i * 3 + 2] = z;

      // Color mapping from pole to equator (latitude gradient)
      const latRatio = phi / Math.PI;
      if (latRatio < 0.5) {
        tempColor.lerpColors(palette.a, palette.b, latRatio * 2.0);
      } else {
        tempColor.lerpColors(palette.b, palette.c, (latRatio - 0.5) * 2.0);
      }

      sphereCols[i * 3] = tempColor.r * 0.42;
      sphereCols[i * 3 + 1] = tempColor.g * 0.42;
      sphereCols[i * 3 + 2] = tempColor.b * 0.42;
    }

    this.sphereGeometry = new THREE.BufferGeometry();
    this.sphereGeometry.setAttribute('position', new THREE.BufferAttribute(spherePos, 3));
    this.sphereGeometry.setAttribute('color', new THREE.BufferAttribute(sphereCols, 3));

    this.sphereMaterial = new THREE.PointsMaterial({
      // PointsMaterial.size is measured in screen pixels, not scene units.
      size: 1.35,
      vertexColors: true,
      transparent: true,
      opacity: 0.22,
      blending: THREE.NormalBlending,
      depthWrite: false,
    });
    this.spherePoints = new THREE.Points(this.sphereGeometry, this.sphereMaterial);
    this.scene.add(this.spherePoints);

    // --- 2. OUTWARD BEAT BURST PARTICLES ---
    const maxBursts = Math.floor(count * 0.35);
    this.burstPositions = new Float32Array(maxBursts * 3);
    this.burstColors = new Float32Array(maxBursts * 3);
    this.burstSizes = new Float32Array(maxBursts);
    this.burstParticles = [];

    this.burstGeometry = new THREE.BufferGeometry();
    this.burstGeometry.setAttribute('position', new THREE.BufferAttribute(this.burstPositions, 3));
    this.burstGeometry.setAttribute('color', new THREE.BufferAttribute(this.burstColors, 3));
    this.burstGeometry.setAttribute('aSize', new THREE.BufferAttribute(this.burstSizes, 1));

    this.burstMaterial = new THREE.ShaderMaterial({
      vertexShader: `
        attribute float aSize;
        attribute vec3 color;
        varying vec3 vColor;
        void main() {
          vColor = color;
          vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * viewPosition;
          gl_PointSize = clamp(aSize * (220.0 / -viewPosition.z), 2.0, 12.0);
        }
      `,
      fragmentShader: `
        varying vec3 vColor;
        void main() {
          float radius = length(gl_PointCoord - vec2(0.5));
          if (radius > 0.5) discard;
          float core = 1.0 - smoothstep(0.05, 0.42, radius);
          float halo = exp(-radius * 9.0);
          gl_FragColor = vec4(vColor, (core * 0.48 + halo * 0.18) * 0.62);
        }
      `,
      vertexColors: true,
      transparent: true,
      blending: THREE.NormalBlending,
      depthWrite: false,
    });
    this.burstPoints = new THREE.Points(this.burstGeometry, this.burstMaterial);
    this.scene.add(this.burstPoints);
  }

  private createOuterShell(quality: Quality, paletteKey: Palette): void {
    if (this.outerShell) this.scene.remove(this.outerShell);
    if (this.outerWire) this.scene.remove(this.outerWire);
    this.outerShellGeometry?.dispose();
    this.outerShellMaterial?.dispose();
    this.outerWireMaterial?.dispose();

    const palette = PALETTES[paletteKey] ?? PALETTES.aurora;
    const segments = quality === 'low' ? 64 : quality === 'high' ? 112 : 88;
    const geometry = new THREE.SphereGeometry(4, segments, Math.floor(segments * 0.75));
    geometry.computeBoundingSphere();
    if (geometry.boundingSphere) geometry.boundingSphere.radius = 4.8;
    const positions = geometry.attributes.position.array as Float32Array;
    this.baseOuterPositions = positions.slice();
    this.outerShellGeometry = geometry;
    this.outerShellMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uColorA: { value: palette.a.clone() },
        uColorB: { value: palette.b.clone() },
        uColorC: { value: palette.c.clone() },
        uTime: { value: 0 },
        uBass: { value: 0 },
        uMid: { value: 0 },
        uTreble: { value: 0 },
        uKick: { value: 0 },
      },
      vertexShader: `
        varying vec3 vNormal;
        varying vec3 vViewDirection;
        varying vec3 vLocalPosition;
        void main() {
          vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
          vNormal = normalize(normalMatrix * normal);
          vViewDirection = normalize(-viewPosition.xyz);
          vLocalPosition = normalize(position);
          gl_Position = projectionMatrix * viewPosition;
        }
      `,
      fragmentShader: `
        uniform vec3 uColorA;
        uniform vec3 uColorB;
        uniform vec3 uColorC;
        uniform float uTime;
        uniform float uBass;
        uniform float uMid;
        uniform float uTreble;
        uniform float uKick;
        varying vec3 vNormal;
        varying vec3 vViewDirection;
        varying vec3 vLocalPosition;
        void main() {
          float latitude = vLocalPosition.y * 0.5 + 0.5;
          float longitude = atan(vLocalPosition.z, vLocalPosition.x);
          float flow = longitude * 2.0 + latitude * 17.0 - uTime * (0.42 + uMid * 0.22);
          float bands = 0.5 + 0.5 * sin(flow + sin(longitude * 3.0 - uTime * 0.28) * 0.8);
          float contour = smoothstep(0.28, 0.82, bands);
          vec3 palette = mix(uColorA, uColorB, smoothstep(0.08, 0.92, latitude));
          palette = mix(palette, uColorC, smoothstep(0.55, 0.98, bands) * 0.62);
          float facing = abs(dot(normalize(vNormal), normalize(vViewDirection)));
          float rim = pow(1.0 - facing, 2.4);
          float pulse = clamp(uBass * 0.08 + uKick * 0.12, 0.0, 0.18);
          float intensity = 0.66 + contour * (0.24 + uTreble * 0.08) + rim * 0.36 + pulse;
          vec3 color = palette * intensity;
          gl_FragColor = vec4(min(color, vec3(0.88)), 0.9);
        }
      `,
      transparent: true,
      side: THREE.FrontSide,
      blending: THREE.NormalBlending,
      depthWrite: false,
      toneMapped: false,
    });
    this.outerWireMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uColorA: { value: palette.a.clone() },
        uColorB: { value: palette.c.clone() },
        uOpacity: { value: 0.22 },
        uBeat: { value: 0 },
      },
      vertexShader: `
        varying vec3 vNormal;
        varying vec3 vViewPosition;
        void main() {
          vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
          vViewPosition = -viewPosition.xyz;
          vNormal = normalize(normalMatrix * normal);
          gl_Position = projectionMatrix * viewPosition;
        }
      `,
      fragmentShader: `
        uniform vec3 uColorA;
        uniform vec3 uColorB;
        uniform float uOpacity;
        uniform float uBeat;
        varying vec3 vNormal;
        varying vec3 vViewPosition;
        void main() {
          float facing = abs(dot(normalize(vNormal), normalize(vViewPosition)));
          float rim = pow(1.0 - facing, 2.1);
          float softVolume = pow(1.0 - facing, 0.65) * 0.12;
          vec3 tint = mix(uColorA, uColorB, smoothstep(0.05, 0.95, rim));
          float alpha = (softVolume + rim * (0.28 + uBeat * 0.1)) * uOpacity;
          gl_FragColor = vec4(tint * (0.72 + uBeat * 0.08), alpha);
        }
      `,
      transparent: true,
      blending: THREE.NormalBlending,
      side: THREE.FrontSide,
      depthWrite: false,
    });
    this.outerShell = new THREE.Mesh(geometry, this.outerShellMaterial);
    this.outerWire = new THREE.Mesh(geometry, this.outerWireMaterial);
    this.outerWire.scale.setScalar(1.006);
    this.scene.add(this.outerShell, this.outerWire);
  }

  update(dtSeconds: number, audio: RenderAudio, settings: VisualSettings): void {
    if (settings.quality !== this.currentQuality || settings.palette !== this.currentPalette) {
      this.recreateParticles(settings.quality, settings.palette);
    }

    this.ambientTime += dtSeconds;
    const rawBass = audio.silent ? 0 : calibrateOrbLevel(audio.bass, settings.sensitivity);
    const rawMid = audio.silent ? 0 : calibrateOrbLevel(audio.mid, settings.sensitivity);
    const rawTreble = audio.silent ? 0 : calibrateOrbLevel(audio.treble, settings.sensitivity);
    const rawTransient = audio.silent ? 0 : calibrateOrbLevel(audio.transient, settings.sensitivity);

    const { bass, mid, treble, beat, pulseScale, kick, pEnergy, hEnergy, stereoWidth, dominantChroma } =
      this.beatFollower.process(
        rawBass,
        rawMid,
        rawTreble,
        rawTransient,
        dtSeconds,
        this.ambientTime,
        settings.response,
        {
          subBass: audio.silent ? 0 : calibrateOrbLevel(audio.subBass ?? audio.bass, settings.sensitivity),
          kick: audio.silent ? 0 : calibrateOrbLevel(audio.kick ?? audio.bass, settings.sensitivity),
          pEnergy: audio.silent ? 0 : calibrateOrbLevel(audio.pEnergy ?? 0, settings.sensitivity),
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

    // Combined Kick and Percussive (P) intensity for triggers
    const kickPercussive = Math.min(1, Math.max(kick, pEnergy, beat));

    // Sphere rotation speed increases with bass drive
    const rotSpeed = 0.4 + bass * 0.8;
    this.turnAngle = (this.turnAngle + dtSeconds * rotSpeed) % (Math.PI * 2);

    // --- Update Core Mesh ---
    // H (harmonic) component drives steady inner wireframe core rotation and glow
    const coreRotSpeed = 0.5 + hEnergy * 2.4;
    this.coreMesh.rotation.y += dtSeconds * coreRotSpeed;
    this.coreMesh.rotation.x += dtSeconds * (coreRotSpeed * 0.5);

    // Keep the core clearly inside the radius-4 outer membrane, even on loud hits.
    const coreScale = 1.0 + hEnergy * 0.22 + bass * 0.1 + kickPercussive * 0.12;
    this.coreMesh.scale.set(coreScale, coreScale, coreScale);

    // Dominant chroma shifts core hue
    const chromaHueShift = ((dominantChroma * 7) % 12) / 12.0;
    const coreColor = palette.b.clone();
    if (chromaHueShift > 0.001) {
      const hsl = { h: 0, s: 0, l: 0 };
      coreColor.getHSL(hsl);
      hsl.h = (hsl.h + chromaHueShift) % 1.0;
      coreColor.setHSL(hsl.h, Math.max(0.75, hsl.s), hsl.l);
    }
    this.coreMaterial.color.copy(coreColor);
    this.coreMaterial.opacity = Math.min(0.3, 0.16 + hEnergy * 0.06 + bass * 0.035);

    // --- Update Orbital Equatorial Rings ---
    // Stereo width drives equatorial ring tilt
    const ringTilt = 0.35 + stereoWidth * 0.95;
    this.ringGroup.rotation.y = this.turnAngle * 0.7;
    this.ringGroup.rotation.x = Math.sin(this.ambientTime * 0.5) * 0.25;
    this.ringGroup.rotation.z = this.turnAngle * 0.15;

    for (let rIdx = 0; rIdx < this.ringLines.length; rIdx++) {
      const ring = this.ringLines[rIdx];
      if (ring) {
        ring.rotation.x = ringTilt * (1.0 + rIdx * 0.35);
        ring.rotation.z = rIdx * 0.5 + stereoWidth * 0.6;
        (ring.material as THREE.LineBasicMaterial).color.copy(rIdx === 0 ? palette.a : palette.c);
        (ring.material as THREE.LineBasicMaterial).opacity = Math.min(0.42, 0.24 + mid * 0.06 + beat * 0.05);
      }
    }

    // --- Update Sphere Surface Particles ---
    // Kick and P component trigger radial pulse expansion
    if (this.spherePoints && this.sphereGeometry) {
      this.spherePoints.rotation.y = this.turnAngle;
      this.spherePoints.rotation.x = Math.sin(this.ambientTime * 0.3) * 0.2;

      const pos = this.sphereGeometry.attributes.position.array as Float32Array;
      const count = pos.length / 3;

      // Keep a stable spherical silhouette. Audio adds a restrained radial
      // swell instead of multiplying the radius by BeatFollower's >1 pulseScale.
      const beatDrive = Math.min(1, Math.max(0, pulseScale - 1));
      const expansion = 1 + bass * 0.035 + beatDrive * 0.075;
      const waveFreq = 4.0;
      const waveAmp = mid * 0.18 + treble * 0.12;
      const impactFade = Math.exp(-this.impactAge * 2.4);

      for (let i = 0; i < count; i++) {
        const bx = this.baseSpherePositions[i * 3] ?? 0;
        const by = this.baseSpherePositions[i * 3 + 1] ?? 0;
        const bz = this.baseSpherePositions[i * 3 + 2] ?? 0;

        const longitude = Math.atan2(bz, bx);
        const ripple = (
          Math.sin(by * waveFreq + this.ambientTime * (3.4 + bass * 0.8)) * 0.62
          + Math.sin(longitude * 3.0 - this.ambientTime * 1.8 + by * 2.0) * 0.38
        ) * waveAmp;
        let impactDisplacement = 0;
        if (impactFade > 0.002) {
          const alignment = THREE.MathUtils.clamp(
            (bx * this.impactDirection.x + by * this.impactDirection.y + bz * this.impactDirection.z) * 0.25,
            -1,
            1,
          );
          const impactAngle = Math.acos(alignment);
          const centerPunch = Math.exp(-(impactAngle * impactAngle) / 0.075);
          const travelingWave = Math.sin(impactAngle * 19 - this.impactAge * 13) * Math.exp(-impactAngle * 2.2);
          impactDisplacement = this.impactStrength * impactFade * (centerPunch * 0.28 + travelingWave * 0.09);
        }
        const finalRadius = expansion + ripple + impactDisplacement * 0.25;

        pos[i * 3] = bx * finalRadius;
        pos[i * 3 + 1] = by * finalRadius;
        pos[i * 3 + 2] = bz * finalRadius;
      }
      this.sphereGeometry.attributes.position.needsUpdate = true;
    }

    // A beat dents and stretches a local patch of the spherical membrane.
    // The traveling ring ripples away from the impact and decays naturally.
    this.burstCooldown = Math.max(0, this.burstCooldown - dtSeconds);
    let emittedHit = false;
    if (kickPercussive > 0.48 && this.burstCooldown === 0) {
      const theta = Math.random() * Math.PI * 2;
      const z = Math.random() * 2 - 1;
      const radial = Math.sqrt(1 - z * z);
      this.impactDirection.set(radial * Math.cos(theta), z, radial * Math.sin(theta));
      this.impactAge = 0;
      this.impactStrength = 0.28 + kickPercussive * 0.32;
      this.burstCooldown = 0.34;
      emittedHit = true;
    }

    if (this.outerShellGeometry && this.outerShell && this.outerWire) {
      this.impactAge += dtSeconds;
      this.outerShell.rotation.y = this.turnAngle;
      this.outerShell.rotation.x = Math.sin(this.ambientTime * 0.3) * 0.2;
      this.outerWire.rotation.copy(this.outerShell.rotation);
      if (this.outerWireMaterial) {
        this.outerWireMaterial.uniforms.uColorA.value.copy(palette.a);
        this.outerWireMaterial.uniforms.uColorB.value.copy(palette.c);
        this.outerWireMaterial.uniforms.uBeat.value = Math.min(1, kickPercussive * 0.7);
        this.outerWireMaterial.uniforms.uOpacity.value = 0.22 + kickPercussive * 0.04;
      }
      if (this.outerShellMaterial) {
        const uniforms = this.outerShellMaterial.uniforms;
        uniforms.uColorA.value.copy(palette.a);
        uniforms.uColorB.value.copy(palette.b);
        uniforms.uColorC.value.copy(palette.c);
        uniforms.uTime.value = this.ambientTime;
        uniforms.uBass.value = bass;
        uniforms.uMid.value = mid;
        uniforms.uTreble.value = treble;
        uniforms.uKick.value = kickPercussive;
      }

      const positions = this.outerShellGeometry.attributes.position.array as Float32Array;
      const ageFade = Math.exp(-this.impactAge * 2.4);
      if (ageFade > 0.002) {
        for (let i = 0; i < positions.length; i += 3) {
          const x = this.baseOuterPositions[i] ?? 0;
          const y = this.baseOuterPositions[i + 1] ?? 0;
          const z = this.baseOuterPositions[i + 2] ?? 0;
          const alignment = THREE.MathUtils.clamp(
            (x * this.impactDirection.x + y * this.impactDirection.y + z * this.impactDirection.z) * 0.25,
            -1,
            1,
          );
          const angle = Math.acos(alignment);
          const centerPunch = Math.exp(-(angle * angle) / 0.075);
          const travelingWave = Math.sin(angle * 19 - this.impactAge * 13) * Math.exp(-angle * 2.2);
          const displacement = this.impactStrength * ageFade * (centerPunch * 0.28 + travelingWave * 0.09);
          const scale = (4 + displacement) * 0.25;
          positions[i] = x * scale;
          positions[i + 1] = y * scale;
          positions[i + 2] = z * scale;
        }
      } else {
        positions.set(this.baseOuterPositions);
      }
      this.outerShellGeometry.attributes.position.needsUpdate = true;
      this.outerShellGeometry.computeVertexNormals();
    }

    // --- Outward particle sprays on distinct kick/percussion hits ---
    const maxBursts = this.burstPositions.length / 3;
    if (emittedHit && this.burstParticles.length < maxBursts - 1) {
      const toSpawn = Math.min(maxBursts - this.burstParticles.length, 10 + Math.floor(kickPercussive * 18));
      const burstDirection = new THREE.Vector3();
      const impactWorldDirection = this.impactDirection.clone();
      if (this.outerShell) impactWorldDirection.applyQuaternion(this.outerShell.quaternion);
      for (let k = 0; k < toSpawn; k++) {
        const startRad = 4.0;
        burstDirection.set(
          impactWorldDirection.x + (Math.random() - 0.5) * 0.55,
          impactWorldDirection.y + (Math.random() - 0.5) * 0.55,
          impactWorldDirection.z + (Math.random() - 0.5) * 0.55,
        ).normalize();
        const x = burstDirection.x * startRad;
        const y = burstDirection.y * startRad;
        const z = burstDirection.z * startRad;

        // The spray comes from the struck patch and fans outward from the shell.
        const speed = 2.2 + Math.random() * 2.4 + kickPercussive * 2.2;
        const vx = burstDirection.x * speed + (Math.random() - 0.5) * 0.45;
        const vy = burstDirection.y * speed + (Math.random() - 0.5) * 0.45;
        const vz = burstDirection.z * speed + (Math.random() - 0.5) * 0.45;

        this.burstParticles.push({
          x,
          y,
          z,
          vx,
          vy,
          vz,
          age: 0,
          maxAge: 0.9 + Math.random() * 0.75,
          size: 0.24 + Math.random() * 0.27,
        });
      }
    }

    // Update active burst particles
    const tempCol = new THREE.Color();
    for (let i = this.burstParticles.length - 1; i >= 0; i--) {
      const p = this.burstParticles[i];
      if (!p) continue;
      p.age += dtSeconds;
      if (p.age >= p.maxAge) {
        this.burstParticles.splice(i, 1);
        continue;
      }

      p.x += p.vx * dtSeconds;
      p.y += p.vy * dtSeconds;
      p.z += p.vz * dtSeconds;
      const drag = Math.exp(-1.8 * dtSeconds);
      p.vx *= drag;
      p.vy *= drag;
      p.vz *= drag;
    }

    // Pack into burst geometry buffer
    for (let i = 0; i < maxBursts; i++) {
      const p = this.burstParticles[i];
      if (p) {
        this.burstPositions[i * 3] = p.x;
        this.burstPositions[i * 3 + 1] = p.y;
        this.burstPositions[i * 3 + 2] = p.z;

        const lifeRatio = p.age / p.maxAge;
        const alpha = 1.0 - lifeRatio;
        tempCol.lerpColors(palette.a, palette.c, lifeRatio).multiplyScalar(0.72 * (0.25 + alpha * 0.75));

        this.burstColors[i * 3] = tempCol.r;
        this.burstColors[i * 3 + 1] = tempCol.g;
        this.burstColors[i * 3 + 2] = tempCol.b;
        this.burstSizes[i] = p.size * (0.35 + alpha * 0.65);
      } else {
        this.burstPositions[i * 3] = 0;
        this.burstPositions[i * 3 + 1] = 0;
        this.burstPositions[i * 3 + 2] = 0;
        this.burstColors[i * 3] = 0;
        this.burstColors[i * 3 + 1] = 0;
        this.burstColors[i * 3 + 2] = 0;
        this.burstSizes[i] = 0;
      }
    }
    if (this.burstGeometry) {
      this.burstGeometry.attributes.position.needsUpdate = true;
      this.burstGeometry.attributes.color.needsUpdate = true;
      this.burstGeometry.attributes.aSize.needsUpdate = true;
    }

    this.renderer.render(this.scene, this.camera);
  }

  resize(width: number, height: number, _pixelRatio: number): void {
    this.camera.aspect = width / Math.max(height, 1);
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    if (this.spherePoints) {
      this.scene.remove(this.spherePoints);
      this.sphereGeometry?.dispose();
      this.sphereMaterial?.dispose();
    }
    if (this.burstPoints) {
      this.scene.remove(this.burstPoints);
      this.burstGeometry?.dispose();
      this.burstMaterial?.dispose();
    }
    if (this.outerShell) this.scene.remove(this.outerShell);
    if (this.outerWire) this.scene.remove(this.outerWire);
    this.outerShellGeometry?.dispose();
    this.outerShellMaterial?.dispose();
    this.outerWireMaterial?.dispose();
    this.coreMesh.geometry.dispose();
    this.coreMaterial.dispose();
    this.scene.remove(this.coreMesh);

    for (const r of this.ringLines) {
      r.geometry.dispose();
      (r.material as THREE.Material).dispose();
      this.ringGroup.remove(r);
    }
    this.scene.remove(this.ringGroup);
  }
}
