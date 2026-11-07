import * as THREE from 'three';
import { BarsScene } from '../bars';
import type { Quality, RenderAudio, VisualScene, VisualSettings } from '../../types';

/** Vinyl presentation wrapper around the shared, audio-reactive Bars scene. */
export class VinylStageScene implements VisualScene {
  private bars: BarsScene;

  public get smoothedBass(): number {
    return this.bars.smoothedBass;
  }
  public get smoothedMid(): number {
    return this.bars.smoothedMid;
  }
  public get smoothedTreble(): number {
    return this.bars.smoothedTreble;
  }
  public get smoothedTransient(): number {
    return this.bars.smoothedTransient;
  }
  public get smoothedSubBass(): number {
    return this.bars.smoothedSubBass;
  }
  public get smoothedKick(): number {
    return this.bars.smoothedKick;
  }
  public get smoothedPEnergy(): number {
    return this.bars.smoothedPEnergy;
  }
  public get dominantChroma(): number {
    return this.bars.dominantChroma;
  }

  public get scene(): THREE.Scene {
    return this.bars.scene;
  }

  public get camera(): THREE.Camera {
    return this.bars.camera;
  }

  constructor(renderer: THREE.WebGLRenderer, quality: Quality = 'medium') {
    this.bars = new BarsScene(renderer, quality);
  }

  update(dtSeconds: number, audio: RenderAudio, settings: VisualSettings): void {
    // Preserve the complete backend frame and active visual settings; BarsScene
    this.bars.update(dtSeconds, audio, settings);
  }

  resize(width: number, height: number, pixelRatio: number): void {
    this.bars.resize(width, height, pixelRatio);
  }

  dispose(): void {
    this.bars.dispose();
  }
}
