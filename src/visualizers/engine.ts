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
    this.resize();
    if (!this.isRunning && !this.isContextLost) {
      this.start();
    }
  }

  public resize(): void {
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
