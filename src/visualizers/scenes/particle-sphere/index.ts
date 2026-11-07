import * as THREE from 'three';
import type { Palette, Quality, RenderAudio, VisualScene, VisualSettings } from '../../types';
import { PALETTES } from '../../palettes';

interface Particle {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  age: number;
  stuckFor: number;
  alpha: number;
  size: number;
  sparklePhase: number;
  colorSlot: number;
  trailEnabled: boolean;
  trailTimer: number;
  trail: Float32Array;
}

const PARTICLE_RATE: Record<Quality, number> = { low: 96, medium: 160, high: 192 };
const MAX_PARTICLES: Record<Quality, number> = { low: 900, medium: 1500, high: 1800 };
const FRAMES_PER_SECOND = 24;

const smoothBand = (value: number, sensitivity = 1): number => {
  const input = Math.max(0, Number.isFinite(value) ? value : 0) * sensitivity;
  return input / (0.2 + input);
};

export class ParticleSphereScene implements VisualScene {
  public scene: THREE.Scene;
  public camera: THREE.PerspectiveCamera;

  private readonly emitter = new THREE.Group();
  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  private positions: Float32Array;
  private alphas: Float32Array;
  private colors: Float32Array;
  private sizes: Float32Array;
  private readonly trailGeometry = new THREE.BufferGeometry();
  private readonly trailMaterial = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.22,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  private trailPositions: Float32Array;
  private trailColors: Float32Array;
  private particles: Particle[] = [];
  private elapsed = 0;
  private emitRemainder = 0;
  private emitRate = PARTICLE_RATE.medium;
  private maxParticles = MAX_PARTICLES.high;
  private particleRadius = 280;
  private focalLength = 320;
  private turnSpeed = Math.PI * 2 / 18;
  private beatPulse = 0;
  private nextColorSlot = 0;
  private smoothedBass = 0;
  private smoothedMids = 0;
  private smoothedTreble = 0;
  private readonly mixedColor = new THREE.Color();
  private previousBeat = false;
  private palette: Palette = 'aurora';
  private quality: Quality = 'medium';

  constructor() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x000000);
    this.camera = new THREE.PerspectiveCamera(78.2, 900 / 520, 1, 3000);
    this.camera.position.z = 320;
    this.camera.lookAt(0, 0, 0);

    this.geometry = new THREE.BufferGeometry();
    this.positions = new Float32Array(MAX_PARTICLES.high * 3);
    this.alphas = new Float32Array(MAX_PARTICLES.high);
    this.colors = new Float32Array(MAX_PARTICLES.high * 3);
    this.sizes = new Float32Array(MAX_PARTICLES.high);
    this.trailPositions = new Float32Array(MAX_PARTICLES.high * 18);
    this.trailColors = new Float32Array(MAX_PARTICLES.high * 18);
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('alpha', new THREE.BufferAttribute(this.alphas, 1).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(this.colors, 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('size', new THREE.BufferAttribute(this.sizes, 1).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setDrawRange(0, 0);
    this.trailGeometry.setAttribute('position', new THREE.BufferAttribute(this.trailPositions, 3).setUsage(THREE.DynamicDrawUsage));
    this.trailGeometry.setAttribute('color', new THREE.BufferAttribute(this.trailColors, 3).setUsage(THREE.DynamicDrawUsage));
    this.trailGeometry.setDrawRange(0, 0);
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uPointDiameter: { value: 5 },
        uFocalLength: { value: 320 },
      },
      vertexShader: `
        attribute float alpha;
        attribute float size;
        attribute vec3 color;
        uniform float uPointDiameter;
        uniform float uFocalLength;
        varying float vAlpha;
        varying vec3 vColor;
        void main() {
          vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * viewPosition;
          gl_PointSize = max(1.0, uPointDiameter * size * uFocalLength / max(1.0, -viewPosition.z));
          vAlpha = alpha;
          vColor = color;
        }
      `,
      fragmentShader: `
        varying float vAlpha;
        varying vec3 vColor;
        void main() {
          float radius = length(gl_PointCoord - vec2(0.5));
          float disc = 1.0 - smoothstep(0.34, 0.5, radius);
          gl_FragColor = vec4(vColor, vAlpha * disc);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const points = new THREE.Points(this.geometry, this.material);
    points.frustumCulled = false;
    const trails = new THREE.LineSegments(this.trailGeometry, this.trailMaterial);
    trails.frustumCulled = false;
    this.emitter.add(trails);
    this.emitter.add(points);
    this.scene.add(this.emitter);
    this.resize(900, 520, 1);
  }

  update(dtSeconds: number, audio: RenderAudio, settings: VisualSettings): void {
    const dt = Math.min(Math.max(dtSeconds, 0), 0.1);
    this.elapsed += dt;
    if (settings.quality !== this.quality) {
      this.quality = settings.quality;
      this.emitRate = PARTICLE_RATE[this.quality];
      this.maxParticles = MAX_PARTICLES[this.quality];
      if (this.particles.length > this.maxParticles) this.particles.splice(0, this.particles.length - this.maxParticles);
    }
    if (settings.palette !== this.palette) {
      this.palette = settings.palette;
    }

    const response = settings.response === 'smooth' ? 0.75 : settings.response === 'hyper' ? 1.45 : 1.1;
    const drive = audio.silent ? 0 : response * settings.sensitivity;
    const bass = smoothBand(audio.kick ?? audio.bass, drive);
    const mids = smoothBand(audio.mid, drive);
    const treble = smoothBand(audio.treble, drive);
    const energy = Math.max(
      smoothBand(audio.transient, drive),
      smoothBand(audio.pEnergy ?? 0, drive),
      audio.beat && !audio.silent ? 0.8 : 0
    );
    const beat = !audio.silent && (Boolean(audio.beat) || (audio.kick ?? 0) > 0.7 || audio.transient > 0.86);
    if (beat && !this.previousBeat) this.beatPulse = 1;
    this.previousBeat = beat;
    this.beatPulse *= Math.exp(-dt / 0.32);

    this.smoothedBass += (bass - this.smoothedBass) * (1 - Math.exp(-dt / (bass > this.smoothedBass ? 0.045 : 0.24)));
    this.smoothedMids += (mids - this.smoothedMids) * (1 - Math.exp(-dt / 0.14));
    this.smoothedTreble += (treble - this.smoothedTreble) * (1 - Math.exp(-dt / 0.08));

    this.turnSpeed = Math.PI * 2 / 18 + this.smoothedMids * 2.4 + this.beatPulse * 1.5;
    this.emitter.rotation.y = (this.emitter.rotation.y + this.turnSpeed * dt) % (Math.PI * 2);
    this.emitter.rotation.x = Math.sin(this.elapsed * 0.23) * 0.16 + this.smoothedMids * 0.72;
    this.emitter.rotation.z = Math.sin(this.elapsed * 0.17) * 0.1 + this.smoothedMids * 0.38;
    const expansion = 1 + this.smoothedBass * 0.15 + this.beatPulse * 0.13;
    this.emitter.scale.setScalar(expansion);

    // Keep a steady ambient shell, then add a short burst on energetic attacks.
    const emission = this.emitRate * (1 + energy * 2.1 + this.smoothedBass * 0.55 + this.smoothedTreble * 0.2);
    this.emitRemainder += emission * dt;
    while (this.emitRemainder >= 1) {
      this.spawnParticle();
      this.emitRemainder -= 1;
    }
    if (beat && !audio.silent) {
      const burst = 28 + Math.round(energy * 32 + bass * 18);
      for (let i = 0; i < burst; i++) this.spawnParticle(1.8 + energy * 1.4 + this.beatPulse * 0.7);
    }

    this.updateParticles(dt);
    this.material.uniforms.uPointDiameter.value = 4.8 + this.smoothedBass * 2.7 + this.beatPulse * 2.2;
    this.trailMaterial.opacity = 0.12 + this.smoothedTreble * 0.18;
  }

  resize(width: number, height: number, _pixelRatio: number): void {
    const safeWidth = Math.max(1, width);
    const safeHeight = Math.max(1, height);
    this.camera.aspect = safeWidth / safeHeight;
    this.camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(520 / (2 * 320)));
    this.camera.updateProjectionMatrix();

    const designScale = safeHeight / 520;
    this.particleRadius = 280 * designScale;
    this.focalLength = 320 * designScale;
    this.camera.position.set(0, 0, this.focalLength);
    this.camera.lookAt(0, 0, 0);
    this.emitter.position.set(0, 0, -(this.particleRadius + 3 * designScale));
    this.material.uniforms.uFocalLength.value = this.focalLength;
  }

  dispose(): void {
    this.scene.remove(this.emitter);
    this.geometry.dispose();
    this.material.dispose();
    this.trailGeometry.dispose();
    this.trailMaterial.dispose();
    this.particles = [];
  }

  private spawnParticle(speedScale = 1): void {
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(Math.random() * 2 - 1);
    const sinPhi = Math.sin(phi);
    const x = this.particleRadius * sinPhi * Math.cos(theta);
    const y = this.particleRadius * sinPhi * Math.sin(theta);
    const z = this.particleRadius * Math.cos(phi);
    if (this.particles.length >= this.maxParticles) this.particles.shift();
    const speed = (0.62 + Math.random() * 0.62) * speedScale;
    const trail = new Float32Array(12);
    for (let i = 0; i < trail.length; i += 3) {
      trail[i] = x;
      trail[i + 1] = y;
      trail[i + 2] = z;
    }
    this.particles.push({
      x, y, z,
      vx: x / this.particleRadius * speed,
      vy: y / this.particleRadius * speed,
      vz: z / this.particleRadius * speed,
      age: 0,
      stuckFor: 0.3 + Math.random() * 0.5,
      alpha: 0,
      size: 0.65 + Math.random() * 1.05,
      sparklePhase: Math.random() * Math.PI * 2,
      colorSlot: this.nextColorSlot,
      trailEnabled: Math.random() < 0.34,
      trailTimer: 0,
      trail,
    });
    this.nextColorSlot = (this.nextColorSlot + 1) % 3;
  }

  private updateParticles(dt: number): void {
    const dtFrames = dt * FRAMES_PER_SECOND;
    const zeroAlphaDepth = -750 * (this.viewportScale());
    const palette = PALETTES[this.palette] ?? PALETTES.aurora;
    const paletteColors = [palette.a, palette.b, palette.c];
    let trailVertexCount = 0;
    let writeIndex = 0;
    for (const particle of this.particles) {
      particle.age += dt;
      if (particle.age > particle.stuckFor) {
        const jitter = Math.sqrt(dtFrames);
        particle.vx += (Math.random() * 2 - 1) * 0.075 * jitter;
        particle.vy += (Math.random() * 2 - 1) * 0.075 * jitter;
        particle.vz += (Math.random() * 2 - 1) * 0.075 * jitter;
        particle.vy -= 0.0015 * dtFrames;
      }
      const mobility = particle.age < particle.stuckFor ? 0.22 : 1;
      particle.x += particle.vx * dtFrames * mobility;
      particle.y += particle.vy * dtFrames * mobility;
      particle.z += particle.vz * dtFrames * mobility;

      const ageFrames = particle.age * FRAMES_PER_SECOND;
      if (ageFrames < 10) particle.alpha = ageFrames / 10;
      else if (ageFrames < 28) particle.alpha = 1;
      else particle.alpha = Math.max(0, 1 - (ageFrames - 28) / 90);
      if (ageFrames >= 118) continue;

      const viewZ = particle.z + this.emitter.position.z;
      if (viewZ > this.focalLength - 2 || particle.alpha <= 0) continue;
      const depthAlpha = THREE.MathUtils.clamp(1 - viewZ / zeroAlphaDepth, 0, 1);
      const flicker = 0.78 + 0.22 * (0.5 + 0.5 * Math.sin(this.elapsed * 31 + particle.sparklePhase));
      const offset = writeIndex * 3;
      this.positions[offset] = particle.x;
      this.positions[offset + 1] = particle.y;
      this.positions[offset + 2] = particle.z;
      this.alphas[writeIndex] = particle.alpha * depthAlpha * flicker * (1 + this.smoothedTreble * 0.45);
      const colorBlend = Math.min(0.38, particle.age * 0.055 + (1 - depthAlpha) * 0.16);
      this.mixedColor
        .copy(paletteColors[particle.colorSlot])
        .lerp(paletteColors[(particle.colorSlot + 1) % paletteColors.length], colorBlend);
      this.colors[offset] = this.mixedColor.r;
      this.colors[offset + 1] = this.mixedColor.g;
      this.colors[offset + 2] = this.mixedColor.b;
      this.sizes[writeIndex] = particle.size;

      if (particle.age > particle.stuckFor) {
        particle.trailTimer += dt;
        while (particle.trailTimer >= 0.045) {
          for (let trailIndex = particle.trail.length - 3; trailIndex >= 3; trailIndex -= 3) {
            particle.trail[trailIndex] = particle.trail[trailIndex - 3];
            particle.trail[trailIndex + 1] = particle.trail[trailIndex - 2];
            particle.trail[trailIndex + 2] = particle.trail[trailIndex - 1];
          }
          particle.trail[0] = particle.x;
          particle.trail[1] = particle.y;
          particle.trail[2] = particle.z;
          particle.trailTimer -= 0.045;
        }
      }
      if (particle.trailEnabled && particle.age > particle.stuckFor + 0.12) {
        const trailAlpha = particle.alpha * depthAlpha * (1 - this.smoothedTreble * 0.25);
        for (let segment = 0; segment < 3; segment++) {
          const trailOffset = trailVertexCount * 3;
          const current = segment * 3;
          const next = (segment + 1) * 3;
          this.trailPositions[trailOffset] = particle.trail[current];
          this.trailPositions[trailOffset + 1] = particle.trail[current + 1];
          this.trailPositions[trailOffset + 2] = particle.trail[current + 2];
          this.trailPositions[trailOffset + 3] = particle.trail[next];
          this.trailPositions[trailOffset + 4] = particle.trail[next + 1];
          this.trailPositions[trailOffset + 5] = particle.trail[next + 2];
          const fade = trailAlpha * (1 - segment / 3) * 0.8;
          for (let vertex = 0; vertex < 2; vertex++) {
            this.trailColors[trailOffset + vertex * 3] = this.mixedColor.r * fade;
            this.trailColors[trailOffset + vertex * 3 + 1] = this.mixedColor.g * fade;
            this.trailColors[trailOffset + vertex * 3 + 2] = this.mixedColor.b * fade;
          }
          trailVertexCount += 2;
        }
      }
      this.particles[writeIndex] = particle;
      writeIndex++;
    }
    this.particles.length = writeIndex;
    this.geometry.setDrawRange(0, writeIndex);
    (this.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.attributes.alpha as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.attributes.color as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.attributes.size as THREE.BufferAttribute).needsUpdate = true;
    this.trailGeometry.setDrawRange(0, trailVertexCount);
    (this.trailGeometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.trailGeometry.attributes.color as THREE.BufferAttribute).needsUpdate = true;
  }

  private viewportScale(): number {
    return this.focalLength / 320;
  }

}
