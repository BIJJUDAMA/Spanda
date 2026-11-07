import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { ChromaticAberrationVignetteShader } from './aberrationShader';
import type { RenderAudio } from '../types';

export class PostProcessingManager {
  public composer: EffectComposer | null = null;
  public renderPass: RenderPass | null = null;
  public bloomPass: UnrealBloomPass | null = null;
  public aberrationPass: ShaderPass | null = null;
  private time: number = 0;
  private bloomBaseStrength = 0.10;
  private bloomKickHeadroom = 0.06;
  private aberrationResponse = 1;

  constructor(
    private renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera
  ) {
    const initialWidth = typeof window !== 'undefined' ? window.innerWidth : 800;
    const initialHeight = typeof window !== 'undefined' ? window.innerHeight : 600;

    try {
      this.renderPass = new RenderPass(scene, camera);
      this.bloomPass = new UnrealBloomPass(
        new THREE.Vector2(initialWidth, initialHeight),
        0.10,
        0.22,
        0.88
      );
      this.aberrationPass = new ShaderPass(ChromaticAberrationVignetteShader);

      this.composer = new EffectComposer(this.renderer);
      this.composer.addPass(this.renderPass);
      this.composer.addPass(this.bloomPass);
      this.composer.addPass(this.aberrationPass);
    } catch {
      // Mock environment or WebGL context limitation fallback
      this.composer = null;
    }
  }

  public setSceneAndCamera(scene: THREE.Scene, camera: THREE.Camera): void {
    if (this.renderPass) {
      this.renderPass.scene = scene;
      this.renderPass.camera = camera;
    }
  }

  public setSceneProfile(sceneId: string): void {
    // Balance bloom for scenes that benefit from restrained luminous accents.
    const profiles: Record<string, { strength: number; headroom: number; threshold: number; radius: number; aberration: number }> = {
      'particle-sphere': { strength: 0.12, headroom: 0.06, threshold: 0.82, radius: 0.24, aberration: 0.24 },
    };
    const profile = profiles[sceneId] ?? { strength: 0.075, headroom: 0.025, threshold: 0.9, radius: 0.2, aberration: 1 };
    this.bloomBaseStrength = profile.strength;
    this.bloomKickHeadroom = profile.headroom;
    this.aberrationResponse = profile.aberration;
    if (this.aberrationPass?.uniforms.uOffset) {
      this.aberrationPass.uniforms.uOffset.value = 0;
    }
    if (this.bloomPass) {
      this.bloomPass.strength = this.bloomBaseStrength;
      this.bloomPass.threshold = profile.threshold;
      this.bloomPass.radius = profile.radius;
    }
  }

  public update(dt: number, audio: RenderAudio): void {
    this.time += dt;
    if (this.bloomPass) {
      // Transient kicks gently boost bloom highlights without blowing out the screen into white
      const kickBoost = Math.min(this.bloomKickHeadroom, (audio.kick ?? 0) * 0.02 + (audio.transient ?? 0) * 0.012);
      const targetStrength = this.bloomBaseStrength + kickBoost;
      this.bloomPass.strength = THREE.MathUtils.lerp(this.bloomPass.strength, targetStrength, 0.2);
    }
    if (this.aberrationPass) {
      // Bass hits snap chromatic aberration
      const kickSnap = ((audio.kick ?? 0) * 0.8 + (audio.subBass ?? 0) * 0.4) * this.aberrationResponse;
      const currentOffset = (this.aberrationPass.uniforms.uOffset?.value as number) ?? 0.0;
      if (this.aberrationPass.uniforms.uOffset) {
        this.aberrationPass.uniforms.uOffset.value = THREE.MathUtils.lerp(currentOffset, kickSnap, 0.3);
      }
      if (this.aberrationPass.uniforms.uTime) {
        this.aberrationPass.uniforms.uTime.value = this.time;
      }
    }
  }

  public render(): void {
    if (this.composer) {
      try {
        this.composer.render();
      } catch {
        // Fallback in case of mock/unsupported context during test executions
      }
    }
  }

  public resize(width: number, height: number): void {
    if (this.composer) {
      try {
        this.composer.setSize(width, height);
      } catch {
        // Ignore mock resize errors
      }
    }
    if (this.bloomPass) {
      this.bloomPass.resolution.set(width, height);
    }
  }

  public dispose(): void {
    if (this.composer) {
      this.composer.passes = [];
      this.composer = null;
    }
    if (this.bloomPass) {
      try {
        this.bloomPass.dispose();
      } catch {
        // Ignore mock dispose errors
      }
      this.bloomPass = null;
    }
    if (this.aberrationPass) {
      try {
        this.aberrationPass.dispose();
      } catch {
        // Ignore mock dispose errors
      }
      this.aberrationPass = null;
    }
    this.renderPass = null;
  }
}
