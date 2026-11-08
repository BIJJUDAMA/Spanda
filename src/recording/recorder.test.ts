import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { ClipRecorder, type RecordingState } from './recorder';
import type { VisualEngine } from '../visualizers/engine';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
const native = vi.mocked(invoke);
const videoTrack = { stop: vi.fn(), onended: null, requestFrame: vi.fn(), clone: () => ({ stop: vi.fn() }) };
const audioTrack = { stop: vi.fn() };
const audioConnect = vi.fn();
class Stream {
  tracks: unknown[] = [videoTrack];
  addTrack(track: unknown) { this.tracks.push(track); }
  getTracks() { return this.tracks as typeof videoTrack[]; }
  getVideoTracks() { return [videoTrack]; }
}
class Context {
  state = 'running'; currentTime = 1;
  resume = vi.fn(async () => {});
  close = vi.fn(async () => { this.state = 'closed'; });
  createMediaStreamDestination() { return { stream: { getAudioTracks: () => [audioTrack] } }; }
  createBuffer(_channels: number, frames: number) { return { getChannelData: () => new Float32Array(frames) }; }
  createBufferSource() { return { connect: audioConnect, start: vi.fn(), stop: vi.fn(), disconnect: vi.fn(), onended: null }; }
}
class Recorder {
  static lastMime = '';
  static lastStream: Stream;
  static isTypeSupported = (type: string) => type.startsWith('video/webm');
  constructor(stream: Stream, options: { mimeType: string }) { Recorder.lastMime = options.mimeType; Recorder.lastStream = stream; }
  state = 'inactive'; ondataavailable: ((event: unknown) => void) | null = null;
  onerror = null; onstop: (() => void) | null = null;
  start() { this.state = 'recording'; }
  stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new NodeBlob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0])]) }); this.onstop?.(); }
}
function engine() {
  const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
  return { renderer: { domElement: canvas }, subscribeFrame: vi.fn(() => vi.fn()) } as unknown as VisualEngine;
}
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  vi.stubGlobal('MediaStreamTrackProcessor', class { readable = new ReadableStream({ start(controller) { controller.enqueue({ close: vi.fn() }); } }); });
  vi.stubGlobal('AudioContext', Context); vi.stubGlobal('MediaRecorder', Recorder);
  Object.defineProperty(HTMLCanvasElement.prototype, 'captureStream', { configurable: true, value: vi.fn(() => new Stream()) });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ fillRect: vi.fn(), drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
  native.mockImplementation(async command => {
    if (command === 'begin_recording') return { id: 'clip', path: 'Videos/Spanda/clip.webm' };
    if (command === 'read_recording_audio') return new ArrayBuffer(0);
    if (command === 'finish_recording') return 'Videos/Spanda/clip.webm';
  });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); Reflect.deleteProperty(HTMLCanvasElement.prototype, 'captureStream'); });
it('combines canvas video and audio, writes encoded chunks, then saves and releases tracks', async () => {
  const states: RecordingState[] = [];
  const recorder = new ClipRecorder(engine(), state => states.push(state));
  const pcm = new ArrayBuffer(28), view = new DataView(pcm);
  view.setUint32(0, 48000, true); view.setUint32(4, 2, true); view.setUint32(8, 2, true);
  view.setFloat64(12, .01, true); view.setFloat32(20, .2, true); view.setFloat32(24, .3, true);
  let supplied = false;
  native.mockImplementation(async command => {
    if (command === 'begin_recording') return { id: 'clip', path: 'Videos/Spanda/clip.webm' };
    if (command === 'read_recording_audio') { if (!supplied) { supplied = true; return pcm; } return new ArrayBuffer(0); }
    if (command === 'finish_recording') return 'Videos/Spanda/clip.webm';
  });
  await recorder.start(); await Promise.resolve(); expect(states.at(-1)?.phase).toBe('recording');
  const stopped = recorder.stop(); await vi.advanceTimersByTimeAsync(300); await stopped;
  expect(HTMLCanvasElement.prototype.captureStream).toHaveBeenCalledWith(30);
  expect(Recorder.lastMime).toBe('video/webm;codecs=vp9,opus');
  expect(Recorder.lastStream.getTracks()).toEqual([videoTrack, audioTrack]);
  expect(native).toHaveBeenCalledWith('append_recording_chunk', expect.any(Uint8Array), { headers: { 'x-recording-id': 'clip' } });
  expect(native).toHaveBeenCalledWith('finish_recording', { id: 'clip' });
  expect(states.at(-1)).toMatchObject({ phase: 'saved', path: 'Videos/Spanda/clip.webm' });
  expect(videoTrack.stop).toHaveBeenCalled(); expect(audioTrack.stop).toHaveBeenCalled();
  expect(audioConnect).toHaveBeenCalledTimes(1);
  expect(audioConnect.mock.calls[0][0]).toHaveProperty('stream'); recorder.dispose();
});
it('reports a failed write and cancels instead of claiming a saved clip', async () => {
  native.mockImplementation(async command => {
    if (command === 'begin_recording') return { id: 'clip', path: 'clip.webm' };
    if (command === 'read_recording_audio') return new ArrayBuffer(0);
    if (command === 'append_recording_chunk') throw new Error('Disk full');
  });
  const states: RecordingState[] = [], recorder = new ClipRecorder(engine(), state => states.push(state));
  await recorder.start(); const stopped = recorder.stop(); await vi.advanceTimersByTimeAsync(300); await stopped;
  expect(states.at(-1)).toMatchObject({ phase: 'error', message: expect.stringContaining('Disk full') });
  expect(native).toHaveBeenCalledWith('cancel_recording', { id: 'clip' });
  expect(native).not.toHaveBeenCalledWith('finish_recording', expect.anything()); recorder.dispose();
});
it('rejects unsupported encoders before starting native recording', async () => {
  vi.spyOn(Recorder, 'isTypeSupported').mockImplementation(type => type.startsWith('video/mp4'));
  const states: RecordingState[] = [], recorder = new ClipRecorder(engine(), state => states.push(state));
  await recorder.start(); expect(states.at(-1)?.phase).toBe('error');
  expect(native).not.toHaveBeenCalledWith('begin_recording'); recorder.dispose();
});

it('falls back to VP8/Opus when VP9/Opus is unavailable', async () => {
  vi.spyOn(Recorder, 'isTypeSupported').mockImplementation(type => type === 'video/webm;codecs=vp8,opus');
  const states: RecordingState[] = [], recorder = new ClipRecorder(engine(), state => states.push(state));
  await recorder.start(); expect(Recorder.lastMime).toBe('video/webm;codecs=vp8,opus');
  const stopped = recorder.stop(); await vi.advanceTimersByTimeAsync(300); await stopped;
  expect(states.at(-1)).toMatchObject({ phase: 'saved', path: 'Videos/Spanda/clip.webm' });
  recorder.dispose();
});

it('records without MP4-specific frame processor support', async () => {
  vi.stubGlobal('MediaStreamTrackProcessor', undefined);
  const states: RecordingState[] = [], recorder = new ClipRecorder(engine(), state => states.push(state));
  await recorder.start();
  expect(states.at(-1)?.phase).toBe('recording');
  const stopped = recorder.stop(); await vi.advanceTimersByTimeAsync(300); await stopped;
  expect(states.at(-1)).toMatchObject({ phase: 'saved', path: 'Videos/Spanda/clip.webm' });
  recorder.dispose();
});
