import type * as THREE from 'three';

export interface RenderAudio {
  rms: number;
  bass: number;
  mid: number;
  treble: number;
  transient: number;
  spectrum: Float32Array;
  silent: boolean;
  mel?: Float32Array | number[];
  subBass?: number;
  kick?: number;
  phase?: number;
  bpm?: number;
  chroma?: number[];
  centroid?: number;
  flatness?: number;
  stereoWidth?: number;
  waveform?: Float32Array | number[];
  hEnergy?: number;
  pEnergy?: number;
  peak?: number;
  confidence?: number;
  beat?: boolean;
}

export function createEmptyRenderAudio(): RenderAudio {
  return {
    rms: 0,
    bass: 0,
    mid: 0,
    treble: 0,
    transient: 0,
    spectrum: new Float32Array(64),
    silent: true,
    subBass: 0,
    kick: 0,
    phase: 0,
    bpm: 0,
    confidence: 0,
    hEnergy: 0,
    pEnergy: 0,
    chroma: new Array(12).fill(0),
    centroid: 0,
    flatness: 0,
    stereoWidth: 0,
    waveform: new Float32Array(64),
    beat: false,
  };
}

export type ResponseStyle = 'punchy' | 'smooth' | 'hyper' | 'liquid' | 'bouncy';
export type Palette =
  | 'aurora'
  | 'ember'
  | 'cosmic'
  | 'cyberpunk'
  | 'synthwave'
  | 'matrix'
  | 'monochrome';
export type Quality = 'low' | 'medium' | 'high';

export interface VisualSettings {
  typographyText?: string;
  response: ResponseStyle;
  palette: Palette;
  sensitivity: number;
  quality: Quality;
}

export const defaultSettings: VisualSettings = {
  response: 'punchy',
  palette: 'aurora',
  sensitivity: 1.0,
  quality: 'medium',
};

export interface VisualScene {
  update(dtSeconds: number, audio: RenderAudio, settings: VisualSettings): void;
  resize(width: number, height: number, pixelRatio: number): void;
  dispose(): void;
  scene?: THREE.Scene;
  camera?: THREE.Camera;
}

export type SceneFactory = (renderer: THREE.WebGLRenderer) => VisualScene;
