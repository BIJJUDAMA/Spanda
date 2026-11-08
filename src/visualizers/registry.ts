import { ParticleConstellationScene, LiquidInterferenceScene, TypographyScene, KaleidoscopeScene } from './scenes/expanded';
import type * as THREE from 'three';
import { TunnelScene } from './scenes/tunnel';
import { OscilloscopeScene } from './scenes/oscilloscope';
import { BarsScene } from './scenes/bars';
import { VinylStageScene } from './scenes/vinyl';
import { FractalScene } from './scenes/fractal';
import { ParticleSphereScene } from './scenes/particle-sphere';
import type { SceneFactory, VisualScene } from './types';

export const SCENE_REGISTRY: Record<string, SceneFactory> = {
  'particle-constellation': () => new ParticleConstellationScene(),
  'liquid-interference': () => new LiquidInterferenceScene(),
  typography: () => new TypographyScene(),
  kaleidoscope: () => new KaleidoscopeScene(),
  tunnel: (renderer: THREE.WebGLRenderer) => new TunnelScene(renderer),
  bars: (renderer: THREE.WebGLRenderer) => new BarsScene(renderer),
  oscilloscope: (renderer: THREE.WebGLRenderer) => new OscilloscopeScene(renderer),
  vinyl: (renderer: THREE.WebGLRenderer) => new VinylStageScene(renderer),
  fractal: (renderer: THREE.WebGLRenderer) => new FractalScene(renderer),
  'particle-sphere': () => new ParticleSphereScene(),
};

export function createScene(id: string, renderer: THREE.WebGLRenderer): VisualScene {
  const factory = SCENE_REGISTRY[id] ?? SCENE_REGISTRY.tunnel;
  return factory(renderer);
}
