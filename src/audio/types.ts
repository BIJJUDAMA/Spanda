export type CaptureState = 'idle' | 'starting' | 'running' | 'recovering' | 'stopping' | 'error';

export interface CaptureError {
  code: string;
  message: string;
}

export interface UnifiedAnalysisFrame {
  rms: number;
  peak: number;
  subBass: number;
  kick: number;
  mids: number;
  treble: number;
  bands: [number, number, number];
  mel: number[];
  spectrum: number[];
  flux: number;
  transient: number;
  beat: boolean;
  phase: number;
  bpm: number;
  confidence: number;
  hEnergy: number;
  pEnergy: number;
  chroma: number[];
  centroid: number;
  flatness: number;
  stereoWidth: number;
  leftPeak: number;
  rightPeak: number;
  waveform: number[];
}

export const defaultAnalysisFrame: UnifiedAnalysisFrame = {
  rms: 0,
  peak: 0,
  subBass: 0,
  kick: 0,
  mids: 0,
  treble: 0,
  bands: [0, 0, 0],
  mel: new Array(64).fill(0),
  spectrum: new Array(64).fill(0),
  flux: 0,
  transient: 0,
  beat: false,
  phase: 0,
  bpm: 0,
  confidence: 0,
  hEnergy: 0,
  pEnergy: 0,
  chroma: new Array(12).fill(0),
  centroid: 0,
  flatness: 0,
  stereoWidth: 0,
  leftPeak: 0,
  rightPeak: 0,
  waveform: new Array(64).fill(0),
};

export type AnalysisFrame = UnifiedAnalysisFrame;
export const idleAnalysis: UnifiedAnalysisFrame = defaultAnalysisFrame;

export interface CaptureSnapshot {
  generation: number;
  sequence: number;
  state: CaptureState;
  error: CaptureError | null;
  deviceName: string | null;
  sampleRate: number | null;
  channels: number | null;
  analysis: UnifiedAnalysisFrame;
  silent: boolean;
}

export const idleSnapshot: CaptureSnapshot = {
  generation: 0,
  sequence: 0,
  state: 'idle',
  error: null,
  deviceName: null,
  sampleRate: null,
  channels: null,
  analysis: idleAnalysis,
  silent: true,
};

export type AudioSourceType = 'wasapi' | 'idle';

export interface AudioView extends CaptureSnapshot {
  clientError: CaptureError | null;
  pending: boolean;
  rms: number;
  peak: number;
  source: AudioSourceType;
  sourceName?: string;
}

export const idleView: AudioView = {
  ...idleSnapshot,
  rms: 0,
  peak: 0,
  clientError: null,
  pending: false,
  source: 'idle',
  sourceName: undefined,
};

export type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

export type EventUnlisten = () => void;
export type EventListener<T> = (event: { payload: T }) => void;
export type Listen = <T>(
  event: string,
  handler: EventListener<T>
) => Promise<EventUnlisten> | EventUnlisten;
