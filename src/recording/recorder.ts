import { invoke } from '@tauri-apps/api/core';
import type { VisualEngine } from '../visualizers/engine';
import { decodePcm, stereoSample } from './pcm';

const DELAY = .15;
const MAX_PENDING_BYTES = 16 * 1024 * 1024;
const MAX_DURATION_MS = 5 * 60 * 1000;
export interface RecordingState { phase: 'idle' | 'starting' | 'recording' | 'saving' | 'saved' | 'error'; elapsed: number; path?: string; message?: string }
export const idleRecording: RecordingState = { phase: 'idle', elapsed: 0 };


export class ClipRecorder {
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private media: MediaRecorder | null = null;
  private destination: MediaStreamAudioDestinationNode | null = null;
  private id: string | null = null;
  private disposed = false;
  private stopping: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribe: (() => void) | null = null;
  private writes: Promise<void> = Promise.resolve();
  private poll: Promise<void> = Promise.resolve();
  private pendingBytes = 0;
  private failure: string | null = null;
  private startedAt = 0;
  private contextEpoch = 0;
  private nextAudioTime = 0;
  private sources = new Set<AudioBufferSourceNode>();
  private unbindContext: (() => void) | null = null;
  private state: RecordingState = idleRecording;
  constructor(private engine: VisualEngine, private onState: (state: RecordingState) => void) {}
  private publish(state: RecordingState) { this.state = state; if (!this.disposed) this.onState(state); }
  private fail(error: unknown) {
    if (!this.failure) this.failure = error instanceof Error ? error.message : String(error);
    void this.stop();
  }
  async start() {
    if (this.media || this.id || this.context || this.disposed) return;
    this.publish({ phase: 'starting', elapsed: 0 });
    try {
      const source = this.engine.renderer.domElement;
      const onLost = () => this.fail(new Error('The graphics context was lost.'));
      source.addEventListener('webglcontextlost', onLost);
      this.unbindContext = () => source.removeEventListener('webglcontextlost', onLost);
      if (!source.captureStream || typeof MediaRecorder === 'undefined' || typeof AudioContext === 'undefined') throw new Error('Recording is unavailable in this WebView. Update Microsoft Edge WebView2.');
      const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus'].find(type => MediaRecorder.isTypeSupported(type));
      if (!mime) throw new Error('WebM recording with VP8/VP9 video and Opus audio is unavailable. Update Microsoft Edge WebView2 and try again.');
      const context = new AudioContext({ latencyHint: 'interactive' });
      this.context = context;
      await context.resume();
      if (this.disposed) { await this.cleanup(); return; }
      const destination = context.createMediaStreamDestination();
      this.destination = destination;
      const canvas = document.createElement('canvas');
      const scale = Math.min(1, 1280 / source.width, 720 / source.height);
      canvas.width = Math.max(2, Math.floor(source.width * scale / 2) * 2);
      canvas.height = Math.max(2, Math.floor(source.height * scale / 2) * 2);
      const output = canvas.getContext('2d', { alpha: false });
      if (!output) throw new Error('Cannot create the recording canvas.');
      output.fillStyle = '#000'; output.fillRect(0, 0, canvas.width, canvas.height);
      const frames = Array.from({ length: 8 }, () => {
        const frame = document.createElement('canvas'); frame.width = canvas.width; frame.height = canvas.height;
        const ctx = frame.getContext('2d', { alpha: false });
        if (!ctx) throw new Error('Cannot allocate recording frames.');
        return { canvas: frame, ctx, time: -Infinity, queued: false };
      });
      let lastFrame = -Infinity, lastPublished = 0;
      this.unsubscribe = this.engine.subscribeFrame((rendered, time) => {
        try {
        const due = frames.filter(frame => frame.queued && time - frame.time >= DELAY * 1000).sort((a, b) => a.time - b.time);
        for (const frame of due) { output.drawImage(frame.canvas, 0, 0); frame.queued = false; }
        if ((this.state.phase === 'starting' || this.state.phase === 'recording') && time - lastFrame >= 1000 / 30) {
          const frame = frames.find(frame => !frame.queued);
          if (frame) {
            const fit = Math.min(canvas.width / rendered.width, canvas.height / rendered.height);
            const width = rendered.width * fit, height = rendered.height * fit;
            frame.ctx.fillStyle = '#000'; frame.ctx.fillRect(0, 0, canvas.width, canvas.height);
            frame.ctx.drawImage(rendered, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
            frame.time = time; frame.queued = true;
          }
          lastFrame = time;
        }
        const elapsed = performance.now() - this.startedAt;
        if (this.state.phase === 'recording' && elapsed - lastPublished >= 1000) { lastPublished = elapsed; this.publish({ phase: 'recording', elapsed }); }
        if (this.state.phase === 'recording' && elapsed >= MAX_DURATION_MS) void this.stop();
        } catch (error) { this.fail(error); }
      });
      const stream = canvas.captureStream(30);
      destination.stream.getAudioTracks().forEach(track => stream.addTrack(track));
      this.stream = stream;
      if (this.disposed) { await this.cleanup(); return; }
      const media = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6_000_000, audioBitsPerSecond: 192_000 });
      this.media = media;
      media.ondataavailable = event => {
        if (!event.data.size || !this.id) return;
        if (this.pendingBytes + event.data.size > MAX_PENDING_BYTES) { this.fail(new Error('Saving could not keep up with recording. Try lower render quality.')); return; }
        const id = this.id;
        this.pendingBytes += event.data.size;
        this.writes = this.writes.then(async () => {
          if (this.failure || this.disposed) return;
          const bytes = new Uint8Array(await event.data.arrayBuffer());
          await invoke('append_recording_chunk', bytes, { headers: { 'x-recording-id': id } });
        }).catch(error => { this.fail(error); }).finally(() => { this.pendingBytes -= event.data.size; });
      };
      media.onerror = () => this.fail(new Error('The video encoder stopped unexpectedly.'));
      stream.getVideoTracks().forEach(track => { track.onended = () => { if (this.state.phase === 'recording') this.fail(new Error('Video capture ended.')); }; });
      const before = context.currentTime;
      const started = await invoke<{ id: string; path: string }>('begin_recording');
      this.id = started.id;
      this.contextEpoch = (before + context.currentTime) / 2;
      this.nextAudioTime = 0;
      if (this.disposed) { await this.cleanup(); return; }
      this.startedAt = performance.now();
      media.start(1000);
      this.publish({ phase: 'recording', elapsed: 0 });
      const pump = () => {
        if (performance.now() - this.startedAt >= MAX_DURATION_MS) { void this.stop(); return; }
        this.poll = this.pullAudio(destination).catch(error => this.fail(error));
        void this.poll.then(() => { if (this.state.phase === 'recording' && !this.disposed) this.timer = setTimeout(pump, 50); });
      };
      pump();
    } catch (error) {
      await this.cleanup();
      this.publish({ phase: 'error', elapsed: 0, message: error instanceof Error ? error.message : String(error) });
    }
  }
  private async pullAudio(destination: MediaStreamAudioDestinationNode) {
    if (!this.id || !this.context || this.disposed) return;
    const id = this.id, context = this.context;
    const data = await invoke<ArrayBuffer>('read_recording_audio', { id });
    if (this.disposed || this.id !== id || context.state === 'closed') return;
    if (context.state !== 'running') throw new Error('Audio recording was interrupted.');
    for (const packet of decodePcm(data)) {
      if (!packet.samples.length) continue;
      const frames = packet.samples.length / packet.channels;
      const buffer = context.createBuffer(2, frames, packet.rate);
      for (let channel = 0; channel < 2; channel++) {
        const output = buffer.getChannelData(channel);
        for (let frame = 0; frame < frames; frame++) output[frame] = stereoSample(packet.samples, frame * packet.channels, packet.channels, channel === 1);
      }
      const desired = this.contextEpoch + DELAY + packet.time;
      const when = Math.abs(desired - this.nextAudioTime) < .04 ? this.nextAudioTime : desired;
      if (when < context.currentTime - .06 || when > context.currentTime + 1) throw new Error('Recording audio fell out of sync. Try lower render quality.');
      const source = context.createBufferSource(); source.buffer = buffer; source.connect(destination);
      this.sources.add(source); source.onended = () => { source.disconnect(); this.sources.delete(source); };
      source.start(Math.max(context.currentTime, when));
      this.nextAudioTime = when + frames / packet.rate;
    }
  }
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    if (!this.media || !this.id) return Promise.resolve();
    this.stopping = this.finish();
    return this.stopping;
  }
  private async finish() {
    this.publish({ phase: 'saving', elapsed: this.state.elapsed });
    if (this.timer) clearTimeout(this.timer);
    try {
      await this.poll;
      if (!this.failure && this.destination) await this.pullAudio(this.destination);
      if (!this.failure) await new Promise(resolve => setTimeout(resolve, Math.min(500, Math.max(DELAY * 1000, (this.nextAudioTime - (this.context?.currentTime ?? 0)) * 1000 + 30))));
      const media = this.media!;
      if (media.state !== 'inactive') await new Promise<void>(resolve => { media.onstop = () => resolve(); media.stop(); });
      await this.writes;
      if (this.failure) throw new Error(this.failure);
      if (!this.id || this.disposed) return;
      const path = await invoke<string>('finish_recording', { id: this.id });
      this.id = null;
      await this.cleanup();
      this.publish({ phase: 'saved', elapsed: this.state.elapsed, path });
    } catch (error) {
      await this.cleanup();
      this.publish({ phase: 'error', elapsed: this.state.elapsed, message: `No clip saved. ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  private async cleanup() {
    if (this.timer) clearTimeout(this.timer);
    this.unsubscribe?.(); this.unsubscribe = null;
    this.unbindContext?.(); this.unbindContext = null;
    if (this.media) { this.media.ondataavailable = null; this.media.onerror = null; if (this.media.state !== 'inactive') this.media.stop(); this.media = null; }
    this.stream?.getTracks().forEach(track => track.stop()); this.stream = null;
    this.destination = null;
    this.sources.forEach(source => { source.onended = null; try { source.stop(); } catch { /* Already ended. */ } source.disconnect(); }); this.sources.clear();
    if (this.context && this.context.state !== 'closed') await this.context.close(); this.context = null;
    if (this.id) { const id = this.id; this.id = null; await invoke('cancel_recording', { id }).catch(() => {}); }
  }
  dispose() { this.disposed = true; void this.cleanup(); }
}
