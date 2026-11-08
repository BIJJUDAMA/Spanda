import * as THREE from 'three';
import { createScene } from './registry';
import { defaultSettings, type Quality, type RenderAudio, type VisualScene, type VisualSettings } from './types';
import { PostProcessingManager } from './postprocessing/composer';

const RESOLUTION_SCALES: Record<Quality, number> = {
  low: 0.5,
  medium: 0.75,
  high: 1.0,
};

export interface VisualEngineOptions {
  container: HTMLElement;
  readAudio: (nowMs: number) => RenderAudio;
  getSettings?: () => VisualSettings;
  sceneId?: string;
  renderer?: THREE.WebGLRenderer;
}

export class VisualEngine {
  public renderer: THREE.WebGLRenderer;
  public activeScene: VisualScene | null = null;
  public postManager: PostProcessingManager | null = null;
  public isRunning: boolean = false;
  public isContextLost: boolean = false;

  private transition: { target: THREE.WebGLRenderTarget; scene: THREE.Scene; camera: THREE.Camera; material: THREE.ShaderMaterial; geometry: THREE.PlaneGeometry; elapsed: number } | null = null;

  private clearTransition() {
    if (!this.transition) return;
    this.transition.target.dispose(); this.transition.material.dispose(); this.transition.geometry.dispose();
    this.transition = null;
  }

  private beginTransition() {
    if (this.customRenderer || this.isContextLost || !this.activeScene?.scene || !this.activeScene.camera || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      this.clearTransition(); return;
    }
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const target = new THREE.WebGLRenderTarget(size.x, size.y, { depthBuffer: false });
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.activeScene.scene, this.activeScene.camera);
    if (this.transition) {
      this.renderer.autoClear = false;
      this.renderer.render(this.transition.scene, this.transition.camera);
      this.renderer.autoClear = true;
    }
    this.renderer.setRenderTarget(null);
    this.clearTransition();
    const material = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: target.texture }, uOpacity: { value: 1 } },
      vertexShader: 'varying vec2 vUv; void main(){vUv=uv;gl_Position=vec4(position.xy,0.,1.);}',
      fragmentShader: 'varying vec2 vUv; uniform sampler2D uMap; uniform float uOpacity; void main(){gl_FragColor=vec4(texture2D(uMap,vUv).rgb,uOpacity);}',
      transparent: true, depthTest: false, depthWrite: false,
    });
    const scene = new THREE.Scene(), geometry = new THREE.PlaneGeometry(2, 2);
    scene.add(new THREE.Mesh(geometry, material));
    this.transition = { target, scene, geometry, material, camera: new THREE.Camera(), elapsed: 0 };
  }

  private dummyScene: THREE.Scene = new THREE.Scene();
  private dummyCamera: THREE.PerspectiveCamera = new THREE.PerspectiveCamera();
  private container: HTMLElement;
  private readAudio: (nowMs: number) => RenderAudio;
  private getSettings: () => VisualSettings;
  private animId: number | null = null;
  private lastTimeMs: number = 0;
  private currentSceneId: string;
  private customRenderer: boolean = false;
  private lastQuality: Quality = 'medium';

  private handleContextLost = (e: Event) => {
    e.preventDefault();
    this.isContextLost = true;
    this.clearTransition();
    if (this.postManager) {
      this.postManager.dispose();
      this.postManager = null;
    }
    this.stop();
  };

  private handleContextRestored = () => {
    this.isContextLost = false;
    this.postManager = new PostProcessingManager(this.renderer, this.dummyScene, this.dummyCamera);
    this.setScene(this.currentSceneId);
    this.start();
  };

  private handleVisibilityChange = () => {
    // When window becomes visible again, make sure the animation loop is running.
    // We never stop the loop on document.hidden so background/multi-monitor stays active.
    if (typeof document !== 'undefined' && !document.hidden && !this.isRunning && !this.isContextLost) {
      this.start();
    }
  };

  constructor(options: VisualEngineOptions) {
    this.container = options.container;
    this.readAudio = options.readAudio;
    this.getSettings = options.getSettings ?? (() => defaultSettings);
    this.currentSceneId = options.sceneId ?? 'oscilloscope';
    this.lastQuality = this.getSettings().quality ?? 'medium';

    if (options.renderer) {
      this.renderer = options.renderer;
      this.customRenderer = true;
    } else {
      this.renderer = new THREE.WebGLRenderer({
        antialias: false,
        powerPreference: 'high-performance',
        alpha: false,
      });
      this.renderer.setPixelRatio(1.0); // Capped at 1.0
      while (this.container.firstChild) {
        this.container.removeChild(this.container.firstChild);
      }
      this.container.appendChild(this.renderer.domElement);
    }

    if (this.renderer.domElement) {
      this.renderer.domElement.addEventListener('webglcontextlost', this.handleContextLost);
      this.renderer.domElement.addEventListener('webglcontextrestored', this.handleContextRestored);
    }

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.handleVisibilityChange);
    }

    this.postManager = new PostProcessingManager(this.renderer, this.dummyScene, this.dummyCamera);
    this.setScene(this.currentSceneId);
    this.resize();
  }

  public setScene(id: string): void {
    this.beginTransition();
    if (this.activeScene) {
      this.activeScene.dispose();
      this.activeScene = null;
    }
    this.currentSceneId = id;
    this.activeScene = createScene(id, this.renderer);
    if (this.activeScene && this.activeScene.scene && this.activeScene.camera && this.postManager) {
      this.postManager.setSceneProfile(id);
      this.postManager.setSceneAndCamera(this.activeScene.scene, this.activeScene.camera);
    }
    const transition = this.transition;
    this.transition = null;
    this.resize();
    this.transition = transition;
    if (!this.isRunning && !this.isContextLost) {
      this.start();
    }
  }

  public resize(): void {
    this.clearTransition();
    const width = this.container.clientWidth || (typeof window !== 'undefined' ? window.innerWidth : 800) || 800;
    const height = this.container.clientHeight || (typeof window !== 'undefined' ? window.innerHeight : 600) || 600;

    const quality = this.getSettings().quality ?? 'medium';
    const scale = RESOLUTION_SCALES[quality] ?? 0.75;
    const renderWidth = Math.max(1, Math.round(width * scale));
    const renderHeight = Math.max(1, Math.round(height * scale));

    if (!this.customRenderer) {
      this.renderer.setSize(renderWidth, renderHeight, false);
      if (this.renderer.domElement) {
        this.renderer.domElement.style.width = '100%';
        this.renderer.domElement.style.height = '100%';
      }
    }
    if (this.postManager) {
      this.postManager.resize(renderWidth, renderHeight);
    }
    if (this.activeScene) {
      this.activeScene.resize(renderWidth, renderHeight, 1.0);
    }
  }

  public start(): void {
    if (this.isRunning || this.isContextLost) return;
    this.isRunning = true;
    this.lastTimeMs = performance.now();

    const loop = (timeMs: number) => {
      if (!this.isRunning || this.isContextLost) return;
      const dt = Math.min((timeMs - this.lastTimeMs) / 1000, 0.1);
      this.lastTimeMs = timeMs;

      const settings = this.getSettings();
      if (settings.quality !== this.lastQuality) {
        this.lastQuality = settings.quality;
        this.resize();
      }

      const audio = this.readAudio(Date.now());

      if (this.activeScene) {
        try {
          this.activeScene.update(dt, audio, settings);
        } catch (sceneErr) {
          if (process.env.NODE_ENV !== 'test') {
            console.error('Active visualizer scene update error:', sceneErr);
          }
        }

        if (this.activeScene.scene && this.activeScene.camera) {
          if (this.postManager && this.postManager.composer) {
            this.postManager.setSceneAndCamera(this.activeScene.scene, this.activeScene.camera);
            this.postManager.update(dt, audio);
            this.postManager.render();
          } else {
            this.renderer.render(this.activeScene.scene, this.activeScene.camera);
          }
        }
      }

      if (this.transition) {
        this.transition.elapsed += dt;
        const progress = Math.min(1, this.transition.elapsed / .9);
        this.transition.material.uniforms.uOpacity.value = 1 - progress * progress * (3 - 2 * progress);
        this.renderer.autoClear = false;
        this.renderer.render(this.transition.scene, this.transition.camera);
        this.renderer.autoClear = true;
        if (progress >= 1) this.clearTransition();
      }
      this.animId = requestAnimationFrame(loop);
    };

    this.animId = requestAnimationFrame(loop);
  }

  public stop(): void {
    this.isRunning = false;
    if (this.animId !== null) {
      cancelAnimationFrame(this.animId);
      this.animId = null;
    }
  }

  public dispose(): void {
    this.stop();
    this.clearTransition();
    if (this.renderer.domElement) {
      this.renderer.domElement.removeEventListener('webglcontextlost', this.handleContextLost);
      this.renderer.domElement.removeEventListener('webglcontextrestored', this.handleContextRestored);
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    }
    if (this.postManager) {
      this.postManager.dispose();
      this.postManager = null;
    }
    if (this.activeScene) {
      this.activeScene.dispose();
      this.activeScene = null;
    }
    if (!this.customRenderer) {
      this.renderer.dispose();
      if (this.renderer.domElement && this.renderer.domElement.parentNode) {
        this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
      }
    }
  }
}
